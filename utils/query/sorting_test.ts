// utils/query/sorting_test.ts
/**
 * Comprehensive unit tests for sorting utilities
 *
 * Test Structure (Effect-TS inspired - precise behavioral contracts):
 * 
 * 1. COLON SYNTAX PARSING
 *    - parseColonSyntax() - URL query extraction
 *    - Field extraction, direction parsing, whitespace handling
 * 
 * 2. SOURCE ADAPTERS (decode/encode round-trips)
 *    - createSortsQueryAdapter
 *    - createSortsJsonAdapter
 *    - createSortsFormAdapter
 * 
 * 3. VALIDATION (createSortsSchema)
 *    - DoS protection (maxSorts)
 *    - Field allowlist
 *    - Tiebreaker injection
 *    - Defaults and merging
 */

import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import {
  createSortsQueryAdapter,
  createSortsJsonAdapter,
  createSortsFormAdapter,
  createSortsSchema,
} from './sorting.ts'

import type { SortsNormalized } from './schemas.ts'

// ============================================================================
// TEST FIXTURES
// ============================================================================

const TEST_ALLOWED_FIELDS = ['created_at', 'updated_at', 'title', 'price', 'id', 'name']

// ============================================================================
// 1. COLON SYNTAX PARSING (via query adapter)
// ============================================================================

describe('colon syntax parsing via query adapter', () => {
  const adapter = createSortsQueryAdapter()

  describe('basic parsing', () => {
    it('parses field:direction format', () => {
      const result = adapter.decode({ sort: 'created_at:desc' })

      expect(result).toHaveLength(1)
      expect(result[0].field).toBe('created_at')
      expect(result[0].direction).toBe('desc')
    })

    it('parses comma-separated multiple sorts', () => {
      const result = adapter.decode({ sort: 'created_at:desc,title:asc' })

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ field: 'created_at', direction: 'desc', tiebreaker: false })
      expect(result[1]).toEqual({ field: 'title', direction: 'asc', tiebreaker: false })
    })

    it('defaults direction to asc when omitted', () => {
      const result = adapter.decode({ sort: 'created_at' })

      expect(result[0].direction).toBe('asc')
    })

    it('handles whitespace around segments', () => {
      const result = adapter.decode({ sort: ' created_at:desc , title:asc ' })

      expect(result).toHaveLength(2)
      expect(result[0].field).toBe('created_at')
      expect(result[1].field).toBe('title')
    })
  })

  describe('direction validation', () => {
    it('accepts asc direction', () => {
      const result = adapter.decode({ sort: 'created_at:asc' })

      expect(result[0].direction).toBe('asc')
    })

    it('accepts desc direction', () => {
      const result = adapter.decode({ sort: 'created_at:desc' })

      expect(result[0].direction).toBe('desc')
    })

    it('skips invalid directions (silent ignore for forward compatibility)', () => {
      const result = adapter.decode({ sort: 'created_at:invalid,title:asc' })

      // Design decision: Invalid direction segments are silently skipped rather than
      // causing an error. This allows adding new direction keywords (e.g., 'nullsfirst')
      // in the future without breaking existing clients. Validation layer can enforce
      // strict checking if needed.
      expect(result).toHaveLength(1)
      expect(result[0].field).toBe('title')
    })

    it('normalizes direction to lowercase', () => {
      const result = adapter.decode({ sort: 'created_at:DESC' })

      expect(result[0].direction).toBe('desc')
    })

    it('normalizes mixed case direction', () => {
      const result = adapter.decode({ sort: 'created_at:Asc' })

      expect(result[0].direction).toBe('asc')
    })
  })

  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      const result = adapter.decode({ sort: '' })

      expect(result).toEqual([])
    })

    it('returns empty array for undefined', () => {
      const result = adapter.decode({})

      expect(result).toEqual([])
    })

    it('handles field names with underscores', () => {
      const result = adapter.decode({ sort: 'created_at:desc' })

      expect(result[0].field).toBe('created_at')
    })

    it('handles field names with numbers', () => {
      const result = adapter.decode({ sort: 'field1:asc' })

      expect(result[0].field).toBe('field1')
    })

    it('skips empty segments from trailing commas', () => {
      const result = adapter.decode({ sort: 'created_at:desc,' })

      expect(result).toHaveLength(1)
      expect(result[0].field).toBe('created_at')
    })

    it('skips empty segments from leading commas', () => {
      const result = adapter.decode({ sort: ',created_at:desc' })

      expect(result).toHaveLength(1)
    })

    it('skips empty segments from multiple commas', () => {
      const result = adapter.decode({ sort: 'created_at:desc,,title:asc' })

      expect(result).toHaveLength(2)
    })

    it('handles whitespace-only sort value', () => {
      const result = adapter.decode({ sort: '   ' })

      expect(result).toEqual([])
    })
  })
})

// ============================================================================
// 2. SOURCE ADAPTERS
// ============================================================================

describe('createSortsQueryAdapter', () => {
  const adapter = createSortsQueryAdapter()

  describe('decode', () => {
    it('parses sort query parameter', () => {
      const result = adapter.decode({ sort: 'created_at:desc,id:asc' })

      expect(result).toEqual([
        { field: 'created_at', direction: 'desc', tiebreaker: false },
        { field: 'id', direction: 'asc', tiebreaker: false }
      ])
    })

    it('handles ZStringOrStringArray (takes first)', () => {
      const result = adapter.decode({ sort: ['created_at:desc', 'ignored:asc'] })

      expect(result).toEqual([
        { field: 'created_at', direction: 'desc', tiebreaker: false }
      ])
    })

    it('returns empty array when no sort', () => {
      const result = adapter.decode({ other: 'param' })

      expect(result).toEqual([])
    })
  })

  describe('encode', () => {
    it('joins sorts with field:direction,field:direction', () => {
      const result = adapter.encode([
        { field: 'created_at', direction: 'desc', tiebreaker: false },
        { field: 'id', direction: 'asc', tiebreaker: true }
      ])

      expect(result).toEqual({ sort: 'created_at:desc,id:asc' })
    })

    it('returns empty object for empty sorts', () => {
      const result = adapter.encode([])

      expect(result).toEqual({})
    })
  })

  describe('round-trip', () => {
    const testCases: SortsNormalized[] = [
      [{ field: 'created_at', direction: 'desc', tiebreaker: false }],
      [{ field: 'id', direction: 'asc', tiebreaker: true }],
      [
        { field: 'created_at', direction: 'desc', tiebreaker: false },
        { field: 'title', direction: 'asc', tiebreaker: false },
        { field: 'id', direction: 'asc', tiebreaker: true }
      ]
    ]

    testCases.forEach((sorts, i) => {
      it(`preserves sorts through encode/decode (case ${i + 1})`, () => {
        const encoded = adapter.encode(sorts)
        const decoded = adapter.decode(encoded)

        // Note: tiebreaker flag is not preserved through URL round-trip
        // (it's set by validation layer, not parsing)
        expect(decoded.map(s => ({ field: s.field, direction: s.direction }))).toEqual(
          sorts.map(s => ({ field: s.field, direction: s.direction }))
        )
      })
    })
  })
})

describe('createSortsJsonAdapter', () => {
  const adapter = createSortsJsonAdapter()

  describe('decode', () => {
    it('extracts sorts array from { sorts: [...] }', () => {
      const result = adapter.decode({
        sorts: [
          { field: 'created_at', direction: 'desc' }
        ]
      })

      expect(result).toEqual([
        { field: 'created_at', direction: 'desc', tiebreaker: false }
      ])
    })

    it('defaults to empty array when sorts missing', () => {
      const result = adapter.decode({})

      expect(result).toEqual([])
    })
  })

  describe('encode', () => {
    it('wraps normalized sorts in { sorts: [...] }', () => {
      const result = adapter.encode([
        { field: 'created_at', direction: 'desc', tiebreaker: false }
      ])

      expect(result).toEqual({
        sorts: [{ field: 'created_at', direction: 'desc', tiebreaker: false }]
      })
    })
  })
})

describe('createSortsFormAdapter', () => {
  const adapter = createSortsFormAdapter()

  describe('decode', () => {
    it('parses sort from form data', () => {
      const result = adapter.decode({ sort: 'created_at:desc' })

      expect(result).toEqual([
        { field: 'created_at', direction: 'desc', tiebreaker: false }
      ])
    })

    it('handles array value (takes first)', () => {
      const result = adapter.decode({ sort: ['created_at:desc', 'title:asc'] })

      expect(result).toEqual([
        { field: 'created_at', direction: 'desc', tiebreaker: false }
      ])
    })

    it('returns empty array when no sort', () => {
      const result = adapter.decode({})

      expect(result).toEqual([])
    })
  })

  describe('encode', () => {
    it('encodes sorts to form data format', () => {
      const result = adapter.encode([
        { field: 'created_at', direction: 'desc', tiebreaker: false }
      ])

      expect(result).toEqual({ sort: 'created_at:desc' })
    })
  })
})

// ============================================================================
// 3. VALIDATION (createSortsSchema)
// ============================================================================

describe('createSortsSchema', () => {
  describe('DoS protection', () => {
    it('rejects when sorts exceed maxSorts limit', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        limits: { maxSorts: 2 }
      })

      const result = schema.safeParse({ sort: 'created_at:desc,title:asc,price:desc' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('maximum 2 allowed')
      }
    })

    it('counts user sorts before adding tiebreaker', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        limits: { maxSorts: 2 },
        tiebreaker: 'id'
      })

      // 2 user sorts should pass, tiebreaker added after
      const result = schema.safeParse({ sort: 'created_at:desc,title:asc' })

      expect(result.success).toBe(true)
      if (result.success) {
        // Tiebreaker is added after validation
        const data = result.data!
        expect(data.length).toBe(3)
        expect(data[2].field).toBe('id')
      }
    })

    it('uses default maxSorts=5 when not configured', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS
      })

      // 5 sorts should pass
      const result = schema.safeParse({
        sort: 'created_at:desc,updated_at:asc,title:desc,price:asc,name:desc'
      })

      expect(result.success).toBe(true)
    })
  })

  describe('field allowlist', () => {
    it('rejects fields not in allowedFields', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: ['created_at', 'id']
      })

      const result = schema.safeParse({ sort: 'unknown_field:desc' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('not sortable')
      }
    })

    it('allows any field when allowedFields empty', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: []
      })

      const result = schema.safeParse({ sort: 'anything:desc' })

      expect(result.success).toBe(true)
    })

    it('provides helpful error message listing allowed fields', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: ['created_at', 'title']
      })

      const result = schema.safeParse({ sort: 'unknown:desc' })

      expect(result.success).toBe(false)
      if (!result.success) {
        const msg = result.error.issues[0].message
        expect(msg).toContain('created_at')
        expect(msg).toContain('title')
      }
    })
  })

  describe('tiebreaker injection', () => {
    it('adds tiebreaker when not present in user sorts', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        tiebreaker: 'id'
      })

      const result = schema.safeParse({ sort: 'created_at:desc' })

      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data!
        expect(data).toHaveLength(2)
        expect(data[1]).toEqual({
          field: 'id',
          direction: 'asc',
          tiebreaker: true
        })
      }
    })

    it('marks existing sort as tiebreaker if it matches', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        tiebreaker: 'id'
      })

      const result = schema.safeParse({ sort: 'created_at:desc,id:desc' })

      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data!
        expect(data).toHaveLength(2)
        expect(data[1].field).toBe('id')
        expect(data[1].tiebreaker).toBe(true)
        expect(data[1].direction).toBe('desc')
      }
    })

    it('uses configured tiebreaker field (default: id)', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: [...TEST_ALLOWED_FIELDS, 'uuid'],
        tiebreaker: 'uuid'
      })

      const result = schema.safeParse({ sort: 'created_at:desc' })

      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data!
        expect(data[1].field).toBe('uuid')
      }
    })

    it('tiebreaker has direction asc when auto-added', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        tiebreaker: 'id'
      })

      const result = schema.safeParse({ sort: 'created_at:desc' })

      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data!
        expect(data[1].direction).toBe('asc')
      }
    })

    it('does not duplicate tiebreaker', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        tiebreaker: 'id'
      })

      const result = schema.safeParse({ sort: 'id:desc' })

      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data!
        expect(data).toHaveLength(1)
        expect(data[0].tiebreaker).toBe(true)
      }
    })

    it('adds tiebreaker even when tiebreaker field not explicitly in allowedFields', () => {
      // This tests the common case where 'id' is always a valid sort
      // even if not listed in the public allowedFields
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: ['created_at', 'title'], // 'id' not listed
        tiebreaker: 'id'
      })

      const result = schema.safeParse({ sort: 'created_at:desc' })

      // Behavior depends on implementation - document actual behavior
      // If tiebreaker is always added regardless of allowlist:
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data!
        expect(data.some(s => s.field === 'id')).toBe(true)
      }
    })
  })

  describe('defaults', () => {
    it('uses defaults when no user sorts', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        defaults: [{ field: 'created_at', direction: 'desc', tiebreaker: false }],
        tiebreaker: 'id'
      })

      const result = schema.safeParse({})

      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data!
        expect(data[0].field).toBe('created_at')
        expect(data[0].direction).toBe('desc')
      }
    })

    it('merges defaults when mergeDefaults=true', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        defaults: [{ field: 'created_at', direction: 'desc', tiebreaker: false }],
        mergeDefaults: true,
        tiebreaker: 'id'
      })

      const result = schema.safeParse({ sort: 'title:asc' })

      expect(result.success).toBe(true)
      if (result.success) {
        // Default first, then user sort, then tiebreaker
        const data = result.data!
        expect(data.map(s => s.field)).toContain('created_at')
        expect(data.map(s => s.field)).toContain('title')
      }
    })

    it('skips duplicate fields when merging', () => {
      const schema = createSortsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        defaults: [{ field: 'created_at', direction: 'desc', tiebreaker: false }],
        mergeDefaults: true,
        tiebreaker: 'id'
      })

      // User provides same field as default
      const result = schema.safeParse({ sort: 'created_at:asc' })

      expect(result.success).toBe(true)
      if (result.success) {
        // Only one created_at (user's overrides default)
        const data = result.data!
        const createdAtSorts = data.filter(s => s.field === 'created_at')
        expect(createdAtSorts).toHaveLength(1)
      }
    })
  })

  describe('disabled mode', () => {
    it('returns null when disabled=true', () => {
      const schema = createSortsSchema({
        source: 'query',
        disabled: true
      })

      const result = schema.safeParse({ sort: 'created_at:desc' })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBeNull()
      }
    })
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('edge cases', () => {
  describe('field name formats', () => {
    const adapter = createSortsQueryAdapter()

    // Note: snake_case already tested in basic parsing section
    // Focus on formats NOT tested elsewhere

    it('handles camelCase field names', () => {
      const result = adapter.decode({ sort: 'createdAt:desc' })
      expect(result[0].field).toBe('createdAt')
    })

    it('handles field names starting with numbers', () => {
      const result = adapter.decode({ sort: '123field:asc' })
      expect(result[0].field).toBe('123field')
    })

    it('handles single-character field names', () => {
      const result = adapter.decode({ sort: 'x:asc' })
      expect(result[0].field).toBe('x')
    })
  })

  describe('colon edge cases', () => {
    const adapter = createSortsQueryAdapter()

    it('handles multiple colons (takes first two parts)', () => {
      const result = adapter.decode({ sort: 'field:asc:extra' })
      
      expect(result[0].field).toBe('field')
      expect(result[0].direction).toBe('asc')
    })

    it('handles field with no colon', () => {
      const result = adapter.decode({ sort: 'fieldonly' })
      
      expect(result[0].field).toBe('fieldonly')
      expect(result[0].direction).toBe('asc') // default
    })

    it('skips segment with only colon', () => {
      const result = adapter.decode({ sort: ':' })
      
      expect(result).toEqual([])
    })

    it('skips segment with colon but no field', () => {
      const result = adapter.decode({ sort: ':asc' })
      
      expect(result).toEqual([])
    })
  })

  describe('special characters', () => {
    const adapter = createSortsQueryAdapter()

    it('handles field names with dots', () => {
      const result = adapter.decode({ sort: 'user.name:asc' })
      expect(result[0].field).toBe('user.name')
    })

    it('handles field names with hyphens', () => {
      const result = adapter.decode({ sort: 'created-at:desc' })
      expect(result[0].field).toBe('created-at')
    })
  })

  describe('many sorts', () => {
    const adapter = createSortsQueryAdapter()

    it('handles 10 sorts', () => {
      const sort = Array.from({ length: 10 }, (_, i) => `field${i}:asc`).join(',')
      const result = adapter.decode({ sort })
      
      expect(result).toHaveLength(10)
    })
  })
})
