// utils/query/fields_test.ts
/**
 * Comprehensive unit tests for field selection (sparse fieldsets) utilities
 *
 * Test Structure (Effect-TS inspired - precise behavioral contracts):
 * 
 * 1. SYNTAX DETECTION
 *    - Simple syntax: ?fields=a,b,c
 *    - JSON:API syntax: ?fields[type]=a,b,c
 *    - Priority and fallback
 * 
 * 2. SOURCE ADAPTERS (decode/encode round-trips)
 *    - createFieldsQueryAdapter
 *    - createFieldsJsonAdapter
 *    - createFieldsFormAdapter
 * 
 * 3. VALIDATION (createFieldsSchema)
 *    - Field allowlist
 *    - Wildcard expansion
 *    - De-duplication
 *    - Defaults
 */

import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import {
  createFieldsQueryAdapter,
  createFieldsJsonAdapter,
  createFieldsFormAdapter,
  createFieldsSchema,
} from './fields.ts'

import type { FieldSelectionNormalized } from './schemas.ts'

// ============================================================================
// TEST FIXTURES
// ============================================================================

const TEST_ALLOWED_FIELDS = ['id', 'name', 'email', 'created_at', 'status', 'price']

// ============================================================================
// 1. SYNTAX DETECTION (via query adapter)
// ============================================================================

describe('syntax detection via query adapter', () => {
  const adapter = createFieldsQueryAdapter()

  describe('simple syntax', () => {
    it('parses fields=a,b,c format', () => {
      const result = adapter.decode({ fields: 'id,name,email' })

      expect(result).toEqual({
        type: 'simple',
        fields: ['id', 'name', 'email']
      })
    })

    it('handles whitespace around field names', () => {
      const result = adapter.decode({ fields: ' id , name , email ' })

      expect(result).toEqual({
        type: 'simple',
        fields: ['id', 'name', 'email']
      })
    })

    it('filters empty segments', () => {
      const result = adapter.decode({ fields: 'id,,name' })

      expect(result?.fields).toEqual(['id', 'name'])
    })

    it('returns null for empty fields value', () => {
      const result = adapter.decode({ fields: '' })

      expect(result).toBeNull()
    })
  })

  describe('JSON:API syntax', () => {
    it('parses fields[type]=a,b,c format', () => {
      const result = adapter.decode({ 'fields[products]': 'id,name,price' })

      expect(result).toEqual({
        type: 'jsonapi',
        fields: {
          products: ['id', 'name', 'price']
        }
      })
    })

    it('handles multiple resource types', () => {
      const result = adapter.decode({
        'fields[products]': 'id,name',
        'fields[categories]': 'id,title'
      })

      expect(result).toEqual({
        type: 'jsonapi',
        fields: {
          products: ['id', 'name'],
          categories: ['id', 'title']
        }
      })
    })

    it('handles whitespace in JSON:API values', () => {
      const result = adapter.decode({ 'fields[products]': ' id , name ' })

      expect(result?.type).toBe('jsonapi')
      if (result?.type === 'jsonapi') {
        expect(result.fields.products).toEqual(['id', 'name'])
      }
    })
  })

  describe('priority and fallback', () => {
    it('prefers JSON:API syntax when both present', () => {
      const result = adapter.decode({
        fields: 'simple_field',
        'fields[products]': 'jsonapi_field'
      })

      expect(result?.type).toBe('jsonapi')
    })

    it('falls back to simple syntax when no JSON:API', () => {
      const result = adapter.decode({
        fields: 'id,name',
        other_param: 'value'
      })

      expect(result?.type).toBe('simple')
    })

    it('returns null when no fields params', () => {
      const result = adapter.decode({ limit: '20', offset: '0' })

      expect(result).toBeNull()
    })
  })

  describe('edge cases', () => {
    it('handles undefined input gracefully', () => {
      const result = adapter.decode({})

      expect(result).toBeNull()
    })

    it('handles array values (ZStringOrStringArray)', () => {
      const result = adapter.decode({ fields: ['id,name', 'ignored'] })

      // Should use first array element
      expect(result?.type).toBe('simple')
      if (result?.type === 'simple') {
        expect(result.fields).toContain('id')
        expect(result.fields).toContain('name')
      }
    })
  })
})

// ============================================================================
// 2. SOURCE ADAPTERS
// ============================================================================

describe('createFieldsQueryAdapter', () => {
  const adapter = createFieldsQueryAdapter()

  describe('decode', () => {
    it('parses simple fields parameter', () => {
      const result = adapter.decode({ fields: 'id,name' })

      expect(result?.type).toBe('simple')
    })

    it('parses JSON:API fields parameters', () => {
      const result = adapter.decode({ 'fields[users]': 'id,email' })

      expect(result?.type).toBe('jsonapi')
    })

    it('returns null when no fields', () => {
      const result = adapter.decode({ page: '1' })

      expect(result).toBeNull()
    })
  })

  describe('encode', () => {
    it('encodes simple selection to fields=a,b', () => {
      const result = adapter.encode({
        type: 'simple',
        fields: ['id', 'name', 'email']
      })

      expect(result).toEqual({ fields: 'id,name,email' })
    })

    it('encodes JSON:API selection to fields[type]=a,b', () => {
      const result = adapter.encode({
        type: 'jsonapi',
        fields: {
          products: ['id', 'name'],
          categories: ['id', 'title']
        }
      })

      expect(result).toEqual({
        'fields[products]': 'id,name',
        'fields[categories]': 'id,title'
      })
    })

    it('returns empty object for null', () => {
      const result = adapter.encode(null)

      expect(result).toEqual({})
    })
  })

  describe('round-trip', () => {
    it('preserves simple selection', () => {
      const original: FieldSelectionNormalized = {
        type: 'simple',
        fields: ['id', 'name', 'email']
      }

      const encoded = adapter.encode(original)
      const decoded = adapter.decode(encoded)

      expect(decoded).toEqual(original)
    })

    it('preserves JSON:API selection', () => {
      const original: FieldSelectionNormalized = {
        type: 'jsonapi',
        fields: {
          products: ['id', 'name'],
          categories: ['id', 'title']
        }
      }

      const encoded = adapter.encode(original)
      const decoded = adapter.decode(encoded)

      expect(decoded).toEqual(original)
    })
  })
})

describe('createFieldsJsonAdapter', () => {
  const adapter = createFieldsJsonAdapter()

  describe('decode', () => {
    it('extracts fields from { fields: {...} }', () => {
      const result = adapter.decode({
        fields: { type: 'simple', fields: ['id', 'name'] }
      })

      expect(result).toEqual({ type: 'simple', fields: ['id', 'name'] })
    })

    it('returns null when fields missing', () => {
      const result = adapter.decode({})

      expect(result).toBeNull()
    })
  })

  describe('encode', () => {
    it('wraps selection in { fields: {...} }', () => {
      const result = adapter.encode({ type: 'simple', fields: ['id'] })

      expect(result).toEqual({
        fields: { type: 'simple', fields: ['id'] }
      })
    })
  })
})

describe('createFieldsFormAdapter', () => {
  const adapter = createFieldsFormAdapter()

  describe('decode', () => {
    it('parses simple fields from form data', () => {
      const result = adapter.decode({ fields: 'id,name' })

      expect(result?.type).toBe('simple')
    })

    it('parses JSON:API fields from form data', () => {
      const result = adapter.decode({ 'fields[users]': 'id,email' })

      expect(result?.type).toBe('jsonapi')
    })
  })

  describe('encode', () => {
    it('encodes to form data format', () => {
      const result = adapter.encode({ type: 'simple', fields: ['id', 'name'] })

      expect(result).toEqual({ fields: 'id,name' })
    })
  })
})

// ============================================================================
// 3. VALIDATION (createFieldsSchema)
// ============================================================================

describe('createFieldsSchema', () => {
  describe('field allowlist', () => {
    it('allows fields in allowedFields', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS
      })

      const result = schema.safeParse({ fields: 'id,name,email' })

      expect(result.success).toBe(true)
    })

    it('rejects fields not in allowedFields', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: ['id', 'name']
      })

      const result = schema.safeParse({ fields: 'id,unknown_field' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('Invalid fields')
        expect(result.error.issues[0].message).toContain('unknown_field')
      }
    })

    it('allows any field when allowedFields undefined', () => {
      // Note: undefined and empty array [] both mean "no restrictions".
      // This is intentional semantic equivalence for API flexibility.
      const schema = createFieldsSchema({
        source: 'query'
      })

      const result = schema.safeParse({ fields: 'any,field,name' })

      expect(result.success).toBe(true)
    })

    it('provides helpful error listing allowed fields', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: ['id', 'name']
      })

      const result = schema.safeParse({ fields: 'invalid' })

      expect(result.success).toBe(false)
      if (!result.success) {
        const msg = result.error.issues[0].message
        expect(msg).toContain('id')
        expect(msg).toContain('name')
      }
    })
  })

  describe('wildcard expansion', () => {
    it('expands * to all allowed fields', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: ['id', 'name', 'email']
      })

      const result = schema.safeParse({ fields: '*' })

      expect(result.success).toBe(true)
      if (result.success && result.data?.type === 'simple') {
        expect(result.data.fields).toEqual(['id', 'name', 'email'])
      }
    })

    it('passes through wildcard when no allowedFields defined', () => {
      // When no allowedFields is configured, wildcard cannot be expanded
      // to a list - it passes through as-is for the handler to interpret
      const schema = createFieldsSchema({
        source: 'query'
      })

      const result = schema.safeParse({ fields: '*' })

      expect(result.success).toBe(true)
      if (result.success && result.data?.type === 'simple') {
        // Behavior: '*' is kept as literal since we can't expand it
        expect(result.data.fields).toContain('*')
      }
    })

    it('expands JSON:API wildcard for specific resource type', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: ['id', 'name'],
        resourceType: 'users'
      })

      const result = schema.safeParse({ 'fields[users]': '*' })

      expect(result.success).toBe(true)
      if (result.success && result.data?.type === 'jsonapi') {
        expect(result.data.fields.users).toEqual(['id', 'name'])
      }
    })
  })

  describe('de-duplication', () => {
    it('removes duplicate fields', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS
      })

      const result = schema.safeParse({ fields: 'id,name,id,name' })

      expect(result.success).toBe(true)
      if (result.success && result.data?.type === 'simple') {
        expect(result.data.fields).toEqual(['id', 'name'])
      }
    })

    it('de-duplicates each resource type in JSON:API', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS
      })

      const result = schema.safeParse({
        'fields[products]': 'id,name,id'
      })

      expect(result.success).toBe(true)
      if (result.success && result.data?.type === 'jsonapi') {
        expect(result.data.fields.products).toEqual(['id', 'name'])
      }
    })
  })

  describe('defaults', () => {
    it('uses defaults when no fields provided', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        defaults: ['id', 'name']
      })

      const result = schema.safeParse({})

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data?.type).toBe('simple')
        if (result.data?.type === 'simple') {
          expect(result.data.fields).toEqual(['id', 'name'])
        }
      }
    })

    it('ignores defaults when fields provided', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS,
        defaults: ['id', 'name']
      })

      const result = schema.safeParse({ fields: 'email' })

      expect(result.success).toBe(true)
      if (result.success && result.data?.type === 'simple') {
        expect(result.data.fields).toEqual(['email'])
      }
    })

    it('returns null when no fields and no defaults', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: TEST_ALLOWED_FIELDS
      })

      const result = schema.safeParse({})

      expect(result.success).toBe(true)
      expect(result.data).toBeNull()
    })
  })

  describe('disabled mode', () => {
    it('returns null when disabled=true', () => {
      const schema = createFieldsSchema({
        source: 'query',
        disabled: true
      })

      const result = schema.safeParse({ fields: 'id,name' })

      expect(result.success).toBe(true)
      expect(result.data).toBeNull()
    })
  })

  describe('JSON:API resource type filtering', () => {
    it('validates only specified resourceType fields', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: ['id', 'name'],
        resourceType: 'users'
      })

      const result = schema.safeParse({
        'fields[users]': 'id,name',
        'fields[other]': 'anything' // Should be ignored
      })

      expect(result.success).toBe(true)
    })
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('edge cases', () => {
  describe('empty and whitespace', () => {
    const adapter = createFieldsQueryAdapter()

    it('handles whitespace-only fields value', () => {
      const result = adapter.decode({ fields: '   ' })

      expect(result).toBeNull()
    })

    it('handles empty JSON:API values', () => {
      const result = adapter.decode({ 'fields[users]': '' })

      expect(result).toBeNull()
    })
  })

  describe('special characters in field names', () => {
    const adapter = createFieldsQueryAdapter()

    it('handles underscored field names', () => {
      const result = adapter.decode({ fields: 'created_at,updated_at' })

      expect(result?.type).toBe('simple')
      if (result?.type === 'simple') {
        expect(result.fields).toContain('created_at')
      }
    })

    it('handles camelCase field names', () => {
      const result = adapter.decode({ fields: 'createdAt,updatedAt' })

      expect(result?.type).toBe('simple')
      if (result?.type === 'simple') {
        expect(result.fields).toContain('createdAt')
      }
    })

    it('handles dotted field names (nested paths)', () => {
      const result = adapter.decode({ fields: 'user.name,user.email' })

      expect(result?.type).toBe('simple')
      if (result?.type === 'simple') {
        expect(result.fields).toContain('user.name')
      }
    })
  })

  describe('many fields', () => {
    it('handles large number of fields', () => {
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: Array.from({ length: 100 }, (_, i) => `field${i}`)
      })

      const fields = Array.from({ length: 50 }, (_, i) => `field${i}`).join(',')
      const result = schema.safeParse({ fields })

      expect(result.success).toBe(true)
    })
  })

  describe('unicode field names', () => {
    const adapter = createFieldsQueryAdapter()

    it('handles unicode in field names', () => {
      const result = adapter.decode({ fields: '名前,メール' })

      expect(result?.type).toBe('simple')
      if (result?.type === 'simple') {
        expect(result.fields).toContain('名前')
        expect(result.fields).toContain('メール')
      }
    })
  })

  describe('validation with empty allowedFields', () => {
    it('allows any field when allowedFields is empty array', () => {
      // Note: Empty array [] and undefined both mean "no restrictions".
      // This is semantic equivalence - see "allows any field when allowedFields undefined"
      // in the field allowlist section above.
      const schema = createFieldsSchema({
        source: 'query',
        allowedFields: []
      })

      const result = schema.safeParse({ fields: 'anything,goes' })

      expect(result.success).toBe(true)
    })
  })
})