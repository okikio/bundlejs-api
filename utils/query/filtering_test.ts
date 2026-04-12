// utils/query/filtering_test.ts
/**
 * Comprehensive unit tests for filtering utilities
 *
 * Test Structure (Effect-TS inspired - precise behavioral contracts):
 * 
 * 1. BRACKET NOTATION PARSING
 *    - parseBracketNotation() - URL query extraction
 *    - Field extraction, operator inference, null keywords
 * 
 * 2. SOURCE ADAPTERS (decode/encode round-trips)
 *    - createFiltersQueryAdapter
 *    - createFiltersJsonAdapter
 *    - createFiltersFormAdapter
 * 
 * 3. TYPE COERCION (validateAndCoerceOperatorValue)
 *    - Number coercion and NaN rejection
 *    - Boolean coercion
 *    - Date coercion and invalid date rejection
 *    - Enum validation
 *    - UUID validation
 *    - Array operator splitting
 * 
 * 4. VALIDATION (createFiltersSchema)
 *    - DoS protection (maxFilters)
 *    - Field allowlist
 *    - Operator allowlist per field
 *    - Defaults and merging
 */

import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import {
  createFiltersQueryAdapter,
  createFiltersJsonAdapter,
  createFiltersFormAdapter,
  createFiltersSchema,
} from './filtering.ts'

import type { FilterRegistry, FiltersNormalized } from './schemas.ts'

// ============================================================================
// TEST FIXTURES
// ============================================================================

/**
 * Sample filter registry covering all field types
 */
const TEST_REGISTRY: FilterRegistry = {
  status: {
    operators: ['eq', 'ne', 'in', 'nin'],
    type: 'enum',
    values: ['draft', 'published', 'archived'],
    arrayOperators: ['in', 'nin']
  },
  price: {
    operators: ['eq', 'gt', 'gte', 'lt', 'lte'],
    type: 'number'
  },
  created_at: {
    operators: ['eq', 'gt', 'gte', 'lt', 'lte'],
    type: 'date'
  },
  is_featured: {
    operators: ['eq', 'ne'],
    type: 'boolean'
  },
  user_id: {
    operators: ['eq'],
    type: 'uuid'
  },
  title: {
    operators: ['eq', 'contains', 'icontains', 'startswith', 'endswith'],
    type: 'string'
  },
  deleted_at: {
    operators: ['is_null', 'is_not_null'],
    type: 'date'
  }
}

function makeQueryFilters(count: number, prefix = 'field'): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`filter[${prefix}${i}][eq]`, `value${i}`])
  )
}

/**
 * Factory for creating filter fixtures
 */
function makeFilter(overrides: Partial<FiltersNormalized[0]> = {}): FiltersNormalized[0] {
  return {
    field: 'status',
    operator: 'eq',
    value: 'published',
    ...overrides
  }
}

// ============================================================================
// 1. BRACKET NOTATION PARSING
// ============================================================================

describe('bracket notation parsing via query adapter', () => {
  const adapter = createFiltersQueryAdapter()

  describe('field extraction', () => {
    it('extracts field from filter[field]=value', () => {
      const result = adapter.decode({ 'filter[status]': 'published' })

      expect(result).toHaveLength(1)
      expect(result[0].field).toBe('status')
    })

    it('extracts field from filter[field][operator]=value', () => {
      const result = adapter.decode({ 'filter[price][gte]': '50' })

      expect(result).toHaveLength(1)
      expect(result[0].field).toBe('price')
    })

    it('ignores non-filter keys', () => {
      const result = adapter.decode({
        'filter[status]': 'published',
        'sort': 'created_at:desc',
        'limit': '20'
      })

      expect(result).toHaveLength(1)
      expect(result[0].field).toBe('status')
    })

    it('handles multiple filters', () => {
      const result = adapter.decode({
        'filter[status]': 'published',
        'filter[price][gte]': '50',
        'filter[price][lte]': '100'
      })

      expect(result).toHaveLength(3)
      expect(result.map(f => f.field)).toEqual(['status', 'price', 'price'])
    })

    it('handles underscore field names', () => {
      const result = adapter.decode({ 'filter[created_at]': '2024-01-01' })

      expect(result[0].field).toBe('created_at')
    })

    it('handles field names with numbers', () => {
      const result = adapter.decode({ 'filter[field1]': 'value' })

      expect(result[0].field).toBe('field1')
    })
  })

  describe('operator inference', () => {
    it('defaults to eq when no operator specified', () => {
      const result = adapter.decode({ 'filter[status]': 'published' })

      expect(result[0].operator).toBe('eq')
    })

    it('extracts explicit operator from second bracket', () => {
      const result = adapter.decode({ 'filter[price][gte]': '50' })

      expect(result[0].operator).toBe('gte')
    })

    const validOperators = [
      'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
      'in', 'nin', 'contains', 'icontains',
      'startswith', 'endswith'
    ] as const

    validOperators.forEach(op => {
      it(`accepts operator: ${op}`, () => {
        const result = adapter.decode({ [`filter[field][${op}]`]: 'value' })

        expect(result[0].operator).toBe(op)
      })
    })
  })

  describe('null keyword handling', () => {
    it('converts value "null" to operator is_null', () => {
      const result = adapter.decode({ 'filter[deleted_at]': 'null' })

      expect(result[0].operator).toBe('is_null')
      expect(result[0].value).toBeUndefined()
    })

    it('converts value "not_null" to operator is_not_null', () => {
      const result = adapter.decode({ 'filter[deleted_at]': 'not_null' })

      expect(result[0].operator).toBe('is_not_null')
      expect(result[0].value).toBeUndefined()
    })
  })

  describe('array value extraction', () => {
    it('takes first value when ZStringOrStringArray provides array', () => {
      const result = adapter.decode({ 'filter[status]': ['published', 'draft'] })

      expect(result[0].value).toBe('published')
    })
  })
})

// ============================================================================
// 2. SOURCE ADAPTERS
// ============================================================================

describe('createFiltersQueryAdapter', () => {
  const adapter = createFiltersQueryAdapter()

  describe('decode', () => {
    it('parses bracket notation from query object', () => {
      const result = adapter.decode({
        'filter[status]': 'published',
        'filter[price][gte]': '50'
      })

      expect(result).toEqual([
        { field: 'status', operator: 'eq', value: 'published' },
        { field: 'price', operator: 'gte', value: '50' }
      ])
    })

    it('returns empty array when no filters present', () => {
      const result = adapter.decode({ sort: 'created_at:desc' })

      expect(result).toEqual([])
    })
  })

  describe('encode', () => {
    it('converts normalized filters to bracket notation', () => {
      const result = adapter.encode([
        { field: 'status', operator: 'eq', value: 'published' },
        { field: 'price', operator: 'gte', value: '50' }
      ])

      expect(result).toEqual({
        'filter[status]': 'published',
        'filter[price][gte]': '50'
      })
    })

    it('uses null keyword for is_null operator', () => {
      const result = adapter.encode([
        { field: 'deleted_at', operator: 'is_null' }
      ])

      expect(result).toEqual({ 'filter[deleted_at]': 'null' })
    })

    it('uses not_null keyword for is_not_null operator', () => {
      const result = adapter.encode([
        { field: 'deleted_at', operator: 'is_not_null' }
      ])

      expect(result).toEqual({ 'filter[deleted_at]': 'not_null' })
    })

    it('joins array values with commas for in/nin', () => {
      const result = adapter.encode([
        { field: 'status', operator: 'in', value: ['draft', 'published'] }
      ])

      expect(result).toEqual({ 'filter[status][in]': 'draft,published' })
    })
  })

  describe('round-trip', () => {
    const testCases: FiltersNormalized[] = [
      [{ field: 'status', operator: 'eq', value: 'published' }],
      [{ field: 'price', operator: 'gte', value: '50' }],
      [{ field: 'deleted_at', operator: 'is_null' }],
      [
        { field: 'status', operator: 'eq', value: 'published' },
        { field: 'price', operator: 'gte', value: '50' }
      ]
    ]

    testCases.forEach((filters, i) => {
      it(`preserves filters through encode/decode (case ${i + 1})`, () => {
        const encoded = adapter.encode(filters)
        const decoded = adapter.decode(encoded)

        expect(decoded).toEqual(filters)
      })
    })
  })
})

describe('createFiltersJsonAdapter', () => {
  const adapter = createFiltersJsonAdapter()

  describe('decode', () => {
    it('extracts filters array from { filters: [...] }', () => {
      const result = adapter.decode({
        filters: [
          { field: 'status', operator: 'eq', value: 'published' }
        ]
      })

      expect(result).toEqual([
        { field: 'status', operator: 'eq', value: 'published' }
      ])
    })

    it('defaults to empty array when filters missing', () => {
      const result = adapter.decode({})

      expect(result).toEqual([])
    })
  })

  describe('encode', () => {
    it('wraps normalized filters in { filters: [...] }', () => {
      const result = adapter.encode([
        { field: 'status', operator: 'eq', value: 'published' }
      ])

      expect(result).toEqual({
        filters: [{ field: 'status', operator: 'eq', value: 'published' }]
      })
    })
  })
})

// ============================================================================
// 3. VALIDATION (createFiltersSchema)
// ============================================================================

describe('createFiltersSchema', () => {
  describe('DoS protection', () => {
    it('rejects when filters exceed maxFilters limit', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY,
        limits: { maxFilters: 3 }
      })

      const input = {
        'filter[status]': 'published',
        'filter[price][gte]': '50',
        'filter[price][lte]': '100',
        'filter[is_featured]': 'true'
      }

      const result = schema.safeParse(input)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('maximum 3 allowed')
      }
    })

    it('allows filters when equal to maxFilters limit', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY,
        limits: { maxFilters: 3 }
      })

      const input = {
        'filter[status]': 'published',
        'filter[price][gte]': '50',
        'filter[price][lte]': '100'
      }

      const result = schema.safeParse(input)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(3)
      }
    })

    it('uses default maxFilters=20 when not configured', () => {
      const schema = createFiltersSchema({
        source: 'query'
      })

      const twentyFilters = makeQueryFilters(20)
      const twentyOneFilters = makeQueryFilters(21)

      const okResult = schema.safeParse(twentyFilters)
      expect(okResult.success).toBe(true)
      if (okResult.success) {
        expect(okResult.data).toHaveLength(20)
      }

      const badResult = schema.safeParse(twentyOneFilters)
      expect(badResult.success).toBe(false)
      if (!badResult.success) {
        expect(badResult.error.issues[0].message).toContain('maximum 20 allowed')
      }
    })
  })

  describe('field allowlist', () => {
    it('rejects unknown fields when registry provided', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY
      })

      const result = schema.safeParse({ 'filter[unknown_field]': 'value' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('not filterable')
      }
    })

    it('allows any field when registry is empty', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: {}
      })

      const result = schema.safeParse({ 'filter[anything]': 'value' })

      expect(result.success).toBe(true)
    })

    it('provides helpful error message listing allowed fields', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: { status: TEST_REGISTRY.status, price: TEST_REGISTRY.price }
      })

      const result = schema.safeParse({ 'filter[unknown]': 'value' })

      expect(result.success).toBe(false)
      if (!result.success) {
        const msg = result.error.issues[0].message
        expect(msg).toContain('status')
        expect(msg).toContain('price')
      }
    })
  })

  describe('defaults and limits interaction', () => {
    const defaults = [
      makeFilter({ field: 'status', operator: 'eq', value: 'published' }),
      makeFilter({ field: 'is_featured', operator: 'eq', value: true })
    ]

    it('applies maxFilters to defaults plus user filters', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY,
        limits: { maxFilters: 3 },
        defaults
      })

      const okResult = schema.safeParse({ 'filter[price][gte]': '50' })
      expect(okResult.success).toBe(true)
      if (okResult.success) {
        expect(okResult.data).toHaveLength(3)
      }

      const badResult = schema.safeParse({
        'filter[price][gte]': '50',
        'filter[price][lte]': '100'
      })
      expect(badResult.success).toBe(false)
      if (!badResult.success) {
        expect(badResult.error.issues[0].message).toContain('maximum 3 allowed')
      }
    })
  })

  describe('operator allowlist', () => {
    it('rejects operators not in field definition', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY
      })

      // status only allows eq, ne, in, nin - not 'contains'
      const result = schema.safeParse({ 'filter[status][contains]': 'pub' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('not allowed')
      }
    })

    it('provides helpful error message listing allowed operators', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY
      })

      const result = schema.safeParse({ 'filter[status][gt]': 'value' })

      expect(result.success).toBe(false)
      if (!result.success) {
        const msg = result.error.issues[0].message
        expect(msg).toContain('eq')
        expect(msg).toContain('ne')
        expect(msg).toContain('in')
      }
    })
  })

  describe('type coercion - number', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('coerces string to number for numeric operators', () => {
      const result = schema.safeParse({ 'filter[price][gte]': '50' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe(50)
        expect(typeof result.data[0].value).toBe('number')
      }
    })

    it('rejects NaN for numeric fields', () => {
      const result = schema.safeParse({ 'filter[price][gte]': 'not-a-number' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('numeric')
      }
    })

    it('handles negative numbers', () => {
      const result = schema.safeParse({ 'filter[price][gte]': '-10' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe(-10)
      }
    })

    it('handles decimal numbers', () => {
      const result = schema.safeParse({ 'filter[price][gte]': '99.99' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe(99.99)
      }
    })
  })

  describe('type coercion - boolean', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('coerces "true" to true', () => {
      const result = schema.safeParse({ 'filter[is_featured][eq]': 'true' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe(true)
      }
    })

    it('coerces "1" to true', () => {
      const result = schema.safeParse({ 'filter[is_featured][eq]': '1' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe(true)
      }
    })

    it('coerces "false" to false', () => {
      const result = schema.safeParse({ 'filter[is_featured][eq]': 'false' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe(false)
      }
    })

    it('coerces other values to false', () => {
      const result = schema.safeParse({ 'filter[is_featured][eq]': 'anything' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe(false)
      }
    })
  })

  describe('type coercion - date', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('coerces ISO string to ISO string (normalized)', () => {
      const result = schema.safeParse({ 'filter[created_at][gte]': '2024-01-15T10:00:00Z' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toBe('2024-01-15T10:00:00.000Z')
      }
    })

    it('rejects invalid date strings', () => {
      const result = schema.safeParse({ 'filter[created_at][gte]': 'not-a-date' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('valid date')
      }
    })

    it('handles date-only strings', () => {
      const result = schema.safeParse({ 'filter[created_at][gte]': '2024-01-15' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        // Will parse as midnight UTC
        expect(result.data[0].value).toContain('2024-01-15')
      }
    })
  })

  describe('type coercion - enum', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('validates value against allowed values', () => {
      const result = schema.safeParse({ 'filter[status][eq]': 'published' })

      expect(result.success).toBe(true)
    })

    it('rejects values not in enum', () => {
      const result = schema.safeParse({ 'filter[status][eq]': 'invalid_status' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid value')
      }
    })

    it('provides helpful error with allowed values', () => {
      const result = schema.safeParse({ 'filter[status][eq]': 'invalid' })

      expect(result.success).toBe(false)
      if (!result.success) {
        const msg = result.error.issues[0].message
        expect(msg).toContain('draft')
        expect(msg).toContain('published')
        expect(msg).toContain('archived')
      }
    })
  })

  describe('type coercion - uuid', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('validates UUID format', () => {
      const result = schema.safeParse({
        'filter[user_id][eq]': '550e8400-e29b-41d4-a716-446655440000'
      })

      expect(result.success).toBe(true)
    })

    it('rejects malformed UUIDs', () => {
      const result = schema.safeParse({ 'filter[user_id][eq]': 'not-a-uuid' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('UUID')
      }
    })
  })

  describe('array operators', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('splits comma-separated values when operator in arrayOperators', () => {
      const result = schema.safeParse({ 'filter[status][in]': 'draft,published' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual(['draft', 'published'])
      }
    })

    it('rejects empty arrays', () => {
      const result = schema.safeParse({ 'filter[status][in]': '' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 1')
      }
    })

    it('trims whitespace from array values', () => {
      const result = schema.safeParse({ 'filter[status][in]': ' draft , published ' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual(['draft', 'published'])
      }
    })
  })

  describe('enum validation with array operators', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('validates each value in in/nin against enum allowlist', () => {
      // All values valid
      const validResult = schema.safeParse({ 'filter[status][in]': 'draft,published' })
      expect(validResult.success).toBe(true)

      // One invalid value
      const invalidResult = schema.safeParse({ 'filter[status][in]': 'published,invalid_status' })
      expect(invalidResult.success).toBe(false)
      if (!invalidResult.success) {
        expect(invalidResult.error.issues[0].message).toContain('Invalid values')
        expect(invalidResult.error.issues[0].message).toContain('invalid_status')
      }
    })

    it('rejects all invalid values in array', () => {
      const result = schema.safeParse({ 'filter[status][in]': 'foo,bar,baz' })
      
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('foo')
        expect(result.error.issues[0].message).toContain('bar')
        expect(result.error.issues[0].message).toContain('baz')
      }
    })

    it('provides allowed enum values in error message', () => {
      const result = schema.safeParse({ 'filter[status][nin]': 'invalid' })
      
      expect(result.success).toBe(false)
      if (!result.success) {
        const msg = result.error.issues[0].message
        expect(msg).toContain('draft')
        expect(msg).toContain('published')
        expect(msg).toContain('archived')
      }
    })

    it('coerces valid enum array values to strings', () => {
      const result = schema.safeParse({ 'filter[status][in]': 'draft,published,archived' })
      
      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual(['draft', 'published', 'archived'])
        // Verify all are strings
        for (const v of result.data[0].value as string[]) {
          expect(typeof v).toBe('string')
        }
      }
    })
  })

  describe('number validation with array operators', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: {
        quantity: {
          operators: ['in', 'nin'],
          type: 'number',
          arrayOperators: ['in', 'nin']
        }
      }
    })

    it('coerces string values to numbers', () => {
      const result = schema.safeParse({ 'filter[quantity][in]': '1,2,3' })
      
      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual([1, 2, 3])
        // Verify all are numbers
        for (const v of result.data[0].value as number[]) {
          expect(typeof v).toBe('number')
        }
      }
    })

    it('rejects non-numeric values in array', () => {
      const result = schema.safeParse({ 'filter[quantity][in]': '1,two,3' })
      
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('numeric')
      }
    })

    it('handles decimal numbers in array', () => {
      const result = schema.safeParse({ 'filter[quantity][in]': '1.5,2.5,3.5' })
      
      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual([1.5, 2.5, 3.5])
      }
    })
  })

  describe('uuid validation with array operators', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: {
        user_ids: {
          operators: ['in', 'nin'],
          type: 'uuid',
          arrayOperators: ['in', 'nin']
        }
      }
    })

    it('validates each UUID in array', () => {
      const validUuids = '550e8400-e29b-41d4-a716-446655440000,6ba7b810-9dad-11d1-80b4-00c04fd430c8'
      const result = schema.safeParse({ 'filter[user_ids][in]': validUuids })
      
      expect(result.success).toBe(true)
    })

    it('rejects invalid UUIDs in array', () => {
      const mixedUuids = '550e8400-e29b-41d4-a716-446655440000,not-a-uuid'
      const result = schema.safeParse({ 'filter[user_ids][in]': mixedUuids })
      
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('UUID')
        expect(result.error.issues[0].message).toContain('not-a-uuid')
      }
    })
  })

  describe('null operators', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: TEST_REGISTRY
    })

    it('is_null requires no value', () => {
      const result = schema.safeParse({ 'filter[deleted_at]': 'null' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].operator).toBe('is_null')
        expect(result.data[0].value).toBeUndefined()
      }
    })

    it('is_not_null requires no value', () => {
      const result = schema.safeParse({ 'filter[deleted_at]': 'not_null' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].operator).toBe('is_not_null')
        expect(result.data[0].value).toBeUndefined()
      }
    })
  })

  describe('defaults and merging', () => {
    it('applies defaults when no user filters', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY,
        defaults: [{ field: 'status', operator: 'eq', value: 'published' }]
      })

      const result = schema.safeParse({})

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data).toEqual([
          { field: 'status', operator: 'eq', value: 'published' }
        ])
      }
    })

    it('merges defaults with user filters when mergeDefaults=true', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY,
        defaults: [{ field: 'status', operator: 'eq', value: 'published' }],
        mergeDefaults: true
      })

      const result = schema.safeParse({ 'filter[price][gte]': '50' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data).toHaveLength(2)
        expect(result.data[0]).toEqual({ field: 'status', operator: 'eq', value: 'published' })
        expect(result.data[1].field).toBe('price')
      }
    })

    it('skips defaults when user filters provided and mergeDefaults=false', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: TEST_REGISTRY,
        defaults: [{ field: 'status', operator: 'eq', value: 'published' }],
        mergeDefaults: false
      })

      const result = schema.safeParse({ 'filter[price][gte]': '50' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data).toHaveLength(1)
        expect(result.data[0].field).toBe('price')
      }
    })
  })

  describe('disabled mode', () => {
    it('returns null when disabled=true', () => {
      const schema = createFiltersSchema({
        source: 'query',
        disabled: true
      })

      const result = schema.safeParse({ 'filter[status]': 'published' })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBeNull()
      }
    })
  })
})

// ============================================================================
// BETWEEN OPERATOR (BLOCKER - was missing)
// ============================================================================

describe('between operator', () => {
  describe('number fields', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: {
        price: {
          operators: ['between'],
          type: 'number'
        }
      }
    })

    it('coerces comma-separated string to [min, max] number array', () => {
      const result = schema.safeParse({ 'filter[price][between]': '50,200' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].operator).toBe('between')
        expect(result.data[0].value).toEqual([50, 200])
      }
    })

    it('rejects when not exactly 2 values (too few)', () => {
      const result = schema.safeParse({ 'filter[price][between]': '50' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('exactly 2 values')
      }
    })

    it('rejects when not exactly 2 values (too many)', () => {
      const result = schema.safeParse({ 'filter[price][between]': '10,50,200' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('exactly 2 values')
      }
    })

    it('rejects when min > max', () => {
      const result = schema.safeParse({ 'filter[price][between]': '200,50' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('min <= max')
      }
    })

    it('rejects non-numeric values', () => {
      const result = schema.safeParse({ 'filter[price][between]': 'low,high' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('numeric')
      }
    })

    it('handles decimal values', () => {
      const result = schema.safeParse({ 'filter[price][between]': '9.99,99.99' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual([9.99, 99.99])
      }
    })

    it('handles negative values', () => {
      const result = schema.safeParse({ 'filter[price][between]': '-100,100' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual([-100, 100])
      }
    })

    it('accepts equal min and max', () => {
      const result = schema.safeParse({ 'filter[price][between]': '50,50' })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual([50, 50])
      }
    })
  })

  describe('date fields', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: {
        created_at: {
          operators: ['between'],
          type: 'date'
        }
      }
    })

    it('coerces comma-separated dates to ISO string array', () => {
      const result = schema.safeParse({
        'filter[created_at][between]': '2024-01-01,2024-12-31'
      })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        const value = result.data[0].value as string[]
        expect(value).toHaveLength(2)
        expect(value[0]).toContain('2024-01-01')
        expect(value[1]).toContain('2024-12-31')
      }
    })

    it('rejects when start > end date', () => {
      const result = schema.safeParse({
        'filter[created_at][between]': '2024-12-31,2024-01-01'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('start date <= end date')
      }
    })

    it('rejects invalid date strings', () => {
      const result = schema.safeParse({
        'filter[created_at][between]': 'not-a-date,also-not-a-date'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('valid dates')
      }
    })

    it('handles ISO datetime strings', () => {
      const result = schema.safeParse({
        'filter[created_at][between]': '2024-01-15T00:00:00Z,2024-01-15T23:59:59Z'
      })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        const value = result.data[0].value as string[]
        expect(value[0]).toBe('2024-01-15T00:00:00.000Z')
        expect(value[1]).toBe('2024-01-15T23:59:59.000Z')
      }
    })
  })

  describe('unsupported types', () => {
    it('rejects between on string type', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: {
          title: {
            operators: ['between'],
            type: 'string'
          }
        }
      })

      const result = schema.safeParse({ 'filter[title][between]': 'a,z' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('not supported')
      }
    })

    it('rejects between on boolean type', () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: {
          is_active: {
            operators: ['between'],
            type: 'boolean'
          }
        }
      })

      const result = schema.safeParse({ 'filter[is_active][between]': 'true,false' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('not supported')
      }
    })
  })

  describe('JSON source', () => {
    const schema = createFiltersSchema({
      source: 'json',
      registry: {
        price: {
          operators: ['between'],
          type: 'number'
        }
      }
    })

    it('accepts array value in JSON body', () => {
      const result = schema.safeParse({
        filters: [
          { field: 'price', operator: 'between', value: [50, 200] }
        ]
      })

      expect(result.success).toBe(true)
      if (result.success && result.data !== null) {
        expect(result.data[0].value).toEqual([50, 200])
      }
    })
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('edge cases', () => {
  describe('empty and whitespace', () => {
    const adapter = createFiltersQueryAdapter()

    it('returns empty array for empty input', () => {
      const result = adapter.decode({})

      expect(result).toEqual([])
    })

    it('handles whitespace-only values', () => {
      const result = adapter.decode({ 'filter[title]': '   ' })

      expect(result[0].value).toBe('   ')
    })
  })

  describe('special characters', () => {
    const adapter = createFiltersQueryAdapter()

    it('preserves special characters in values', () => {
      const result = adapter.decode({ 'filter[title]': 'Hello & World!' })

      expect(result[0].value).toBe('Hello & World!')
    })

    it('handles unicode in values', () => {
      const result = adapter.decode({ 'filter[title]': '日本語テスト' })

      expect(result[0].value).toBe('日本語テスト')
    })

    it('handles emoji in values', () => {
      const result = adapter.decode({ 'filter[title]': '🚀 Launch' })

      expect(result[0].value).toBe('🚀 Launch')
    })
  })

  describe('malformed input', () => {
    const adapter = createFiltersQueryAdapter()

    it('ignores malformed filter keys', () => {
      const result = adapter.decode({
        'filter': 'value',              // Missing brackets
        'filter[]': 'value',            // Empty field
        'filter[field': 'value',        // Unclosed bracket
        'filter[field][': 'value'       // Unclosed operator bracket
      })

      expect(result).toEqual([])
    })
  })
})

// ============================================================================
// BASE FILTERS INTERACTION
// ============================================================================

describe('baseFilters interaction', () => {
  /**
   * baseFilters are system-level filters applied by handlers (e.g., realm scoping,
   * soft-delete exclusion). They're injected at execution time, separate from user filters.
   * 
   * Key behaviors to verify:
   * 1. baseFilters don't count toward maxFilters limit
   * 2. baseFilters are applied before user filters in execution
   * 3. User cannot override baseFilters via query params
   */

  describe('maxFilters limit applies only to user filters', () => {
    it('allows user filters up to maxFilters even with baseFilters present', () => {
      // Scenario: maxFilters=3, user provides 3 filters
      // baseFilters (realm_id, deleted_at) would be added at execution time
      // User's 3 filters should be valid
      
      const schema = createFiltersSchema({
        source: 'query',
        limits: { maxFilters: 3 }
      })

      const userFilters = {
        'filter[status][eq]': 'published',
        'filter[price][gte]': '50',
        'filter[category][in]': 'books,electronics'
      }

      const result = schema.safeParse(userFilters)
      expect(result.success).toBe(true)
      
      if (result.success) {
        expect(result.data).toHaveLength(3)
      }
    })

    it('rejects when user filters exceed maxFilters', () => {
      const schema = createFiltersSchema({
        source: 'query',
        limits: { maxFilters: 2 }
      })

      const userFilters = {
        'filter[status][eq]': 'published',
        'filter[price][gte]': '50',
        'filter[category][in]': 'books'  // 3rd filter exceeds limit
      }

      const result = schema.safeParse(userFilters)
      expect(result.success).toBe(false)
      
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('maximum')
      }
    })
  })

  describe('baseFilters field protection', () => {
    /**
     * Production pattern: handlers inject baseFilters for realm scoping.
     * User should not be able to filter on realm_id themselves.
     */
    
    it('registry can exclude fields from user filtering', () => {
      // Create registry that excludes realm_id from user filtering
      const registry = new FieldRegistry()
      registry.register('status', 'string', { filterable: true })
      registry.register('price', 'number', { filterable: true })
      registry.register('realm_id', 'string', { filterable: false })  // Not user-filterable
      
      const schema = createFiltersSchema({
        source: 'query',
        registry
      })

      // User tries to filter on realm_id
      const result = schema.safeParse({
        'filter[realm_id][eq]': 'other-realm'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('not filterable')
      }
    })

    it('allows valid user filters while rejecting protected fields', () => {
      const registry = new FieldRegistry()
      registry.register('status', 'string', { filterable: true })
      registry.register('realm_id', 'string', { filterable: false })
      
      const schema = createFiltersSchema({
        source: 'query',
        registry
      })

      // Mixed: valid + invalid
      const result = schema.safeParse({
        'filter[status][eq]': 'published',
        'filter[realm_id][eq]': 'other-realm'
      })

      // Should reject because realm_id is not filterable
      expect(result.success).toBe(false)
    })
  })

  describe('baseFilters merge semantics', () => {
    /**
     * When execution layer merges baseFilters with user filters,
     * baseFilters should take precedence (applied first).
     */
    
    it('baseFilters and user filters can target same field if allowed', () => {
      // User might filter status=published, while baseFilter might be deleted_at is null
      // Both should be valid if field allows multiple filter instances
      
      const registry = new FieldRegistry()
      registry.register('status', 'string', { filterable: true })
      registry.register('created_at', 'date', { filterable: true })
      
      const schema = createFiltersSchema({
        source: 'query',
        registry
      })

      // User provides date range filter
      const result = schema.safeParse({
        'filter[created_at][gte]': '2024-01-01',
        'filter[created_at][lt]': '2024-02-01'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        // Both filters on same field should be preserved
        expect(result.data).toHaveLength(2)
        expect(result.data.every(f => f.field === 'created_at')).toBe(true)
      }
    })
  })
})

// ============================================================================
// PARAMETERIZED OPERATOR TESTS
// ============================================================================

describe('parameterized operator coverage', () => {
  /**
   * Systematic coverage of all operators with appropriate field types.
   * Each operator is tested with valid input to ensure the full operator matrix works.
   */
  
  const operatorTestCases = [
    // Comparison operators - work on strings, numbers, dates
    { operator: 'eq', field: 'status', type: 'string', value: 'active', expected: 'active' },
    { operator: 'ne', field: 'status', type: 'string', value: 'deleted', expected: 'deleted' },
    { operator: 'gt', field: 'price', type: 'number', value: '100', expected: 100 },
    { operator: 'gte', field: 'price', type: 'number', value: '50', expected: 50 },
    { operator: 'lt', field: 'price', type: 'number', value: '200', expected: 200 },
    { operator: 'lte', field: 'price', type: 'number', value: '150', expected: 150 },
    
    // Set operators - work on arrays
    { operator: 'in', field: 'status', type: 'string', value: 'a,b,c', expected: ['a', 'b', 'c'] },
    { operator: 'nin', field: 'status', type: 'string', value: 'x,y', expected: ['x', 'y'] },
    
    // String operators
    { operator: 'contains', field: 'title', type: 'string', value: 'test', expected: 'test' },
    { operator: 'icontains', field: 'title', type: 'string', value: 'TEST', expected: 'TEST' },
    { operator: 'startswith', field: 'title', type: 'string', value: 'pre', expected: 'pre' },
    { operator: 'endswith', field: 'title', type: 'string', value: 'fix', expected: 'fix' },
    
    // Null operators - no value needed
    { operator: 'is_null', field: 'deleted_at', type: 'date', value: 'null', expected: undefined },
    { operator: 'is_not_null', field: 'deleted_at', type: 'date', value: 'not_null', expected: undefined },
  ]

  // Create a registry that allows all operators on all test fields
  const allOperatorsRegistry = {
    status: { type: 'string', filterable: true, operators: ['eq', 'ne', 'in', 'nin', 'contains', 'icontains', 'startswith', 'endswith'] },
    price: { type: 'number', filterable: true, operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'between'] },
    title: { type: 'string', filterable: true, operators: ['eq', 'ne', 'contains', 'icontains', 'startswith', 'endswith'] },
    deleted_at: { type: 'date', filterable: true, operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null', 'between'] },
    created_at: { type: 'date', filterable: true, operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'] },
  }

  operatorTestCases.forEach(({ operator, field, type, value, expected }) => {
    it(`${operator} operator on ${type} field (${field})`, () => {
      const schema = createFiltersSchema({
        source: 'query',
        registry: allOperatorsRegistry
      })

      const input = operator === 'is_null' || operator === 'is_not_null'
        ? { [`filter[${field}]`]: value }
        : { [`filter[${field}][${operator}]`]: value }

      const result = schema.safeParse(input)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(1)
        expect(result.data[0].field).toBe(field)
        expect(result.data[0].operator).toBe(operator)
        
        if (expected !== undefined) {
          expect(result.data[0].value).toEqual(expected)
        }
      }
    })
  })

  describe('between operator parameterized', () => {
    const betweenCases = [
      { field: 'price', type: 'number', value: '10,100', expected: [10, 100] },
      { field: 'price', type: 'number', value: '0,1000', expected: [0, 1000] },
      { field: 'created_at', type: 'date', value: '2024-01-01,2024-12-31', expectedLength: 2 },
    ]

    betweenCases.forEach(({ field, type, value, expected, expectedLength }) => {
      it(`between on ${type} field: ${value}`, () => {
        const schema = createFiltersSchema({
          source: 'query',
          registry: allOperatorsRegistry
        })

        const result = schema.safeParse({
          [`filter[${field}][between]`]: value
        })

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data[0].operator).toBe('between')
          if (expected) {
            expect(result.data[0].value).toEqual(expected)
          }
          if (expectedLength) {
            expect((result.data[0].value as unknown[]).length).toBe(expectedLength)
          }
        }
      })
    })
  })
})

// ============================================================================
// FUZZ-LIKE EDGE CASE TESTS
// ============================================================================

describe('fuzz-like edge cases', () => {
  const adapter = createFiltersQueryAdapter()

  describe('unicode and special strings', () => {
    const unicodeCases = [
      { name: 'Chinese characters', value: '中文测试' },
      { name: 'Japanese hiragana', value: 'ひらがな' },
      { name: 'Korean hangul', value: '한글테스트' },
      { name: 'Arabic text', value: 'اختبار' },
      { name: 'Hebrew text', value: 'בדיקה' },
      { name: 'Thai script', value: 'ทดสอบ' },
      { name: 'Emoji sequence', value: '👨‍👩‍👧‍👦 Family' },
      { name: 'Mixed emoji', value: '🚀💻🔥' },
      { name: 'Zero-width joiner', value: 'a\u200Db' },
      { name: 'Combining characters', value: 'e\u0301' }, // é as e + combining acute
      { name: 'Right-to-left mark', value: 'test\u200Fvalue' },
    ]

    unicodeCases.forEach(({ name, value }) => {
      it(`handles ${name} in filter values`, () => {
        const result = adapter.decode({ 'filter[title]': value })

        expect(result).toHaveLength(1)
        expect(result[0].value).toBe(value)
      })
    })
  })

  describe('potentially dangerous strings', () => {
    const dangerousCases = [
      { name: 'SQL injection attempt', value: "'; DROP TABLE users; --" },
      { name: 'NoSQL injection', value: '{"$gt": ""}' },
      { name: 'XSS attempt', value: '<script>alert("xss")</script>' },
      { name: 'Path traversal', value: '../../../etc/passwd' },
      { name: 'Null bytes', value: 'test\x00value' },
      { name: 'Command injection', value: '$(rm -rf /)' },
      { name: 'LDAP injection', value: '*)(&' },
      { name: 'XML entity', value: '&lt;xml&gt;' },
    ]

    dangerousCases.forEach(({ name, value }) => {
      it(`safely handles ${name}`, () => {
        // These should be passed through as literal strings
        // Actual sanitization happens at the execution/database layer
        const result = adapter.decode({ 'filter[title]': value })

        expect(result).toHaveLength(1)
        expect(result[0].value).toBe(value)
        expect(result[0].field).toBe('title')
      })
    })
  })

  describe('boundary string lengths', () => {
    it('handles empty string value', () => {
      const result = adapter.decode({ 'filter[title]': '' })

      expect(result).toHaveLength(1)
      expect(result[0].value).toBe('')
    })

    it('handles very long field names (255 chars)', () => {
      const longField = 'a'.repeat(255)
      const result = adapter.decode({ [`filter[${longField}]`]: 'value' })

      expect(result).toHaveLength(1)
      expect(result[0].field).toBe(longField)
    })

    it('handles very long values (10KB)', () => {
      const longValue = 'x'.repeat(10 * 1024)
      const result = adapter.decode({ 'filter[content]': longValue })

      expect(result).toHaveLength(1)
      expect(result[0].value).toBe(longValue)
    })
  })

  describe('numeric edge cases', () => {
    const schema = createFiltersSchema({
      source: 'query',
      registry: {
        amount: { type: 'number', filterable: true, operators: ['eq', 'gt', 'lt', 'gte', 'lte', 'between'] }
      }
    })

    const numericCases = [
      { name: 'zero', value: '0', expected: 0 },
      { name: 'negative zero', value: '-0', expected: 0 },
      { name: 'negative number', value: '-100', expected: -100 },
      { name: 'decimal', value: '3.14159', expected: 3.14159 },
      { name: 'scientific notation', value: '1e10', expected: 1e10 },
      { name: 'negative scientific', value: '-1.5e-3', expected: -1.5e-3 },
      { name: 'max safe integer', value: '9007199254740991', expected: 9007199254740991 },
    ]

    numericCases.forEach(({ name, value, expected }) => {
      it(`coerces ${name}: "${value}"`, () => {
        const result = schema.safeParse({ 'filter[amount][eq]': value })

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.data[0].value).toBe(expected)
        }
      })
    })

    const invalidNumericCases = [
      { name: 'text', value: 'not-a-number' },
      { name: 'NaN string', value: 'NaN' },
      { name: 'Infinity', value: 'Infinity' },
      { name: 'mixed', value: '123abc' },
    ]

    invalidNumericCases.forEach(({ name, value }) => {
      it(`rejects invalid number: ${name}`, () => {
        const result = schema.safeParse({ 'filter[amount][eq]': value })

        expect(result.success).toBe(false)
      })
    })
  })

  describe('field name edge cases', () => {
    it('handles snake_case fields', () => {
      const result = adapter.decode({ 'filter[created_at]': 'value' })
      expect(result[0].field).toBe('created_at')
    })

    it('handles camelCase fields', () => {
      const result = adapter.decode({ 'filter[createdAt]': 'value' })
      expect(result[0].field).toBe('createdAt')
    })

    it('handles fields with numbers', () => {
      const result = adapter.decode({ 'filter[field123]': 'value' })
      expect(result[0].field).toBe('field123')
    })

    it('handles fields starting with underscore', () => {
      const result = adapter.decode({ 'filter[_internal]': 'value' })
      expect(result[0].field).toBe('_internal')
    })
  })

  describe('multiple filters stress test', () => {
    it('handles maximum allowed filters (20)', () => {
      const schema = createFiltersSchema({
        source: 'query',
        limits: { maxFilters: 20 }
      })

      const input = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`filter[field${i}][eq]`, `value${i}`])
      )

      const result = schema.safeParse(input)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(20)
      }
    })
  })
})