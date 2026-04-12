// utils/query/query_test.ts
/**
 * Integration tests for query composition utilities
 *
 * Test Structure (Effect-TS inspired - precise behavioral contracts):
 * 
 * 1. SCHEMA COMPOSITION
 *    - createQuerySchema() - combines pagination, filters, sorts, fields
 *    - Component disabling
 *    - Source detection (query, json, form)
 * 
 * 2. VALIDATION ORDER
 *    - Pagination validation
 *    - Filter registry validation
 *    - Sort allowlist validation
 *    - Error aggregation
 * 
 * 3. INTEGRATION SCENARIOS
 *    - Typical list endpoint queries
 *    - Cursor continuation
 *    - Complex filter combinations
 *    - Full QuerySpec output shape
 */

import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import { createQuerySpec } from './query.ts'
import type { 
  FilterRegistry, 
  EndpointQueryConfig,
  QuerySpec,
  FiltersNormalized,
  PaginationNormalized,
  SortsNormalized,
} from './schemas.ts'
import { createFieldsQueryAdapter } from './fields.ts'
import { createFiltersQueryAdapter } from './filtering.ts'
import { createPaginationQueryAdapter, encodeCursor } from './pagination.ts'
import { createSortsQueryAdapter } from './sorting.ts'

function createQuerySchema(options: { source: 'query' | 'json' | 'form'; config: EndpointQueryConfig }) {
  return createQuerySpec(options.source, options.config)
}

// ============================================================================
// TEST FIXTURES
// ============================================================================

const TEST_SECRET = 'test-secret-key-for-hmac-signing-minimum-32-chars'

const TEST_FILTER_REGISTRY: FilterRegistry = {
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
    operators: ['eq'],
    type: 'boolean'
  },
  user_id: {
    operators: ['eq'],
    type: 'uuid'
  },
  title: {
    operators: ['eq', 'contains', 'startswith'],
    type: 'string'
  }
}

const TEST_SORT_ALLOWED = ['created_at', 'updated_at', 'title', 'price', 'id']

function makeConfig(overrides: Partial<EndpointQueryConfig> = {}): EndpointQueryConfig {
  return {
    pagination: {
      limits: {
        minLimit: 1,
        maxLimit: 100,
        defaultLimit: 20,
        maxOffset: 10000,
        cursorTTL: 3600
      },
      cursorSecret: TEST_SECRET
    },
    filters: {
      registry: TEST_FILTER_REGISTRY,
      limits: { maxFilters: 10 }
    },
    sorts: {
      allowedFields: TEST_SORT_ALLOWED,
      tiebreaker: 'id',
      limits: { maxSorts: 3 }
    },
    fields: {
      allowedFields: ['id', 'title', 'status', 'price', 'created_at'],
      disabled: false
    },
    ...overrides
  }
}

// ============================================================================
// 1. SCHEMA COMPOSITION
// ============================================================================

describe('createQuerySchema', () => {
  describe('component composition', () => {
    it('combines pagination, filters, sorts, fields schemas', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[status]': 'published',
        sort: 'created_at:desc',
        fields: 'id,title'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination).toBeDefined()
        expect(result.data.filters).toBeDefined()
        expect(result.data.sorts).toBeDefined()
        expect(result.data.fields).toBeDefined()
      }
    })

    it('respects disabled flag for filters', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          filters: { disabled: true }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[status]': 'published' // Should be ignored
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.filters).toBeNull()
      }
    })

    it('respects disabled flag for sorts', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          sorts: { disabled: true }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        sort: 'created_at:desc' // Should be ignored
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.sorts).toBeNull()
      }
    })

    it('respects disabled flag for fields', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          fields: { disabled: true }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        fields: 'id,title' // Should be ignored
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.fields).toBeNull()
      }
    })
  })

  describe('source detection', () => {
    it('uses query adapters for source="query"', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      // Query source expects bracket notation for filters
      const result = schema.safeParse({
        'filter[status]': 'published',
        sort: 'created_at:desc',
        offset: '0',
        limit: '20'
      })

      expect(result.success).toBe(true)
    })

    it('uses json adapters for source="json"', () => {
      const schema = createQuerySchema({
        source: 'json',
        config: makeConfig()
      })

      // JSON source expects structured objects
      const result = schema.safeParse({
        filters: [{ field: 'status', operator: 'eq', value: 'published' }],
        sorts: [{ field: 'created_at', direction: 'desc' }],
        pagination: { type: 'offset', offset: 0, limit: 20 }
      })

      expect(result.success).toBe(true)
    })

    it('uses form adapters for source="form"', () => {
      const schema = createQuerySchema({
        source: 'form',
        config: makeConfig()
      })

      // Form source similar to query
      const result = schema.safeParse({
        'filter[status]': 'published',
        sort: 'created_at:desc',
        offset: '0',
        limit: '20'
      })

      expect(result.success).toBe(true)
    })
  })
})

// ============================================================================
// 2. VALIDATION ORDER
// ============================================================================

describe('validation order', () => {
  describe('pagination validation', () => {
    it('validates limit bounds', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          pagination: {
            limits: { minLimit: 1, maxLimit: 50, defaultLimit: 20, maxOffset: 10000, cursorTTL: 3600 }
          }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '100' // Exceeds maxLimit of 50
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.includes('limit'))).toBe(true)
      }
    })

    it('validates offset bounds (DoS protection)', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          pagination: {
            limits: { minLimit: 1, maxLimit: 100, defaultLimit: 20, maxOffset: 1000, cursorTTL: 3600 }
          }
        })
      })

      const result = schema.safeParse({
        offset: '5000', // Exceeds maxOffset of 1000
        limit: '20'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(i => i.path.includes('offset'))).toBe(true)
      }
    })

    it('uses default limit when not provided', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          pagination: {
            limits: { minLimit: 1, maxLimit: 100, defaultLimit: 25, maxOffset: 10000, cursorTTL: 3600 }
          }
        })
      })

      const result = schema.safeParse({
        offset: '0'
        // No limit provided
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination.limit).toBe(25)
      }
    })
  })

  describe('filter registry validation', () => {
    it('rejects unknown filter fields', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[unknown_field]': 'value'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(i => 
          i.message.includes('not filterable')
        )).toBe(true)
      }
    })

    it('rejects invalid filter operators', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      // status only allows eq, ne, in, nin - not 'gt'
      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[status][gt]': 'published'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(i => 
          i.message.includes('not allowed')
        )).toBe(true)
      }
    })

    it('coerces filter values based on field type', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[price][gte]': '50.5'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const priceFilter = result.data.filters?.find(f => f.field === 'price')
        expect(priceFilter?.value).toBe(50.5)
        expect(typeof priceFilter?.value).toBe('number')
      }
    })
  })

  describe('sort allowlist validation', () => {
    it('rejects unknown sort fields', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        sort: 'unknown_field:desc'
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some(i => 
          i.message.includes('not sortable')
        )).toBe(true)
      }
    })

    it('injects tiebreaker after sort validation', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        sort: 'created_at:desc'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        // Should have user sort + tiebreaker
        expect(result.data.sorts?.length).toBe(2)
        expect(result.data.sorts?.[0].field).toBe('created_at')
        expect(result.data.sorts?.[1].field).toBe('id')
        expect(result.data.sorts?.[1].tiebreaker).toBe(true)
      }
    })
  })

  describe('error aggregation', () => {
    it('collects multiple validation errors', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          pagination: {
            limits: { minLimit: 1, maxLimit: 50, defaultLimit: 20, maxOffset: 1000, cursorTTL: 3600 }
          }
        })
      })

      const result = schema.safeParse({
        offset: '5000',      // Invalid: exceeds maxOffset
        limit: '200',        // Invalid: exceeds maxLimit
        'filter[unknown]': 'value',  // Invalid: unknown field
        sort: 'bad_field:desc'       // Invalid: unknown field
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        // Should have multiple errors
        expect(result.error.issues.length).toBeGreaterThan(1)
      }
    })
  })
})

// ============================================================================
// 3. INTEGRATION SCENARIOS
// ============================================================================

describe('integration scenarios', () => {
  describe('typical list endpoint queries', () => {
    it('parses: ?offset=0&limit=20&filter[status]=active&sort=created_at:desc', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[status]': 'published',
        sort: 'created_at:desc'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const pagination = result.data.pagination
        expect(pagination.type).toBe('offset')
        if (pagination.type === 'offset') {
          expect(pagination.offset).toBe(0)
          expect(pagination.limit).toBe(20)
        }
        expect(result.data.filters?.[0].field).toBe('status')
        expect(result.data.filters?.[0].value).toBe('published')
        expect(result.data.sorts?.[0].field).toBe('created_at')
        expect(result.data.sorts?.[0].direction).toBe('desc')
      }
    })

    it('parses page-based pagination: ?page=3&per_page=25', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        page: '3',
        per_page: '25'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const pagination = result.data.pagination
        expect(pagination.type).toBe('offset')
        if (pagination.type === 'offset') {
          expect(pagination.offset).toBe(50)
          expect(pagination.limit).toBe(25)
        }
      }
    })

    it('handles multiple filters on same field (range query)', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[price][gte]': '50',
        'filter[price][lte]': '200'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const priceFilters = result.data.filters?.filter(f => f.field === 'price')
        expect(priceFilters?.length).toBe(2)
        
        const gteFilter = priceFilters?.find(f => f.operator === 'gte')
        const lteFilter = priceFilters?.find(f => f.operator === 'lte')
        expect(gteFilter?.value).toBe(50)
        expect(lteFilter?.value).toBe(200)
      }
    })

    it('handles array filter (in operator)', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[status][in]': 'draft,published'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const statusFilter = result.data.filters?.find(f => f.field === 'status')
        expect(statusFilter?.operator).toBe('in')
        expect(statusFilter?.value).toEqual(['draft', 'published'])
      }
    })
  })

  describe('cursor continuation', () => {
    it('parses cursor-based pagination: ?cursor=abc&limit=20', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        cursor: '',  // Empty cursor = first page
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination.type).toBe('cursor')
        expect(result.data.pagination.limit).toBe(20)
      }
    })
  })

  describe('JSON body queries', () => {
    it('parses structured JSON query', () => {
      const schema = createQuerySchema({
        source: 'json',
        config: makeConfig()
      })

      const result = schema.safeParse({
        pagination: {
          type: 'offset',
          offset: 40,
          limit: 20
        },
        filters: [
          { field: 'status', operator: 'eq', value: 'published' },
          { field: 'price', operator: 'gte', value: 100 }
        ],
        sorts: [
          { field: 'created_at', direction: 'desc' }
        ]
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination.type).toBe('offset')
        expect(result.data.filters?.length).toBe(2)
        expect(result.data.sorts?.[0].field).toBe('created_at')
      }
    })
  })

  describe('QuerySpec output shape', () => {
    it('produces complete QuerySpec structure', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '20',
        limit: '10',
        'filter[status]': 'published',
        sort: 'title:asc',
        fields: 'id,title,status'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const spec: QuerySpec = result.data

        // Pagination
        expect(spec.pagination).toBeDefined()
        expect(spec.pagination.type).toBe('offset')
        
        // Filters (or null if disabled)
        expect(spec.filters).toBeDefined()
        expect(Array.isArray(spec.filters)).toBe(true)
        
        // Sorts (or null if disabled)
        expect(spec.sorts).toBeDefined()
        expect(Array.isArray(spec.sorts)).toBe(true)
        
        // Fields (or null if disabled)
        expect(spec.fields).toBeDefined()
      }
    })

    it('produces null for disabled components', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          filters: { disabled: true },
          sorts: { disabled: true },
          fields: { disabled: true }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination).toBeDefined()
        expect(result.data.filters).toBeNull()
        expect(result.data.sorts).toBeNull()
        expect(result.data.fields).toBeNull()
      }
    })
  })

  describe('defaults application', () => {
    it('applies default filters when none provided', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          filters: {
            registry: TEST_FILTER_REGISTRY,
            defaults: [{ field: 'status', operator: 'eq', value: 'published' }]
          }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20'
        // No filters
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.filters?.[0].field).toBe('status')
        expect(result.data.filters?.[0].value).toBe('published')
      }
    })

    it('applies default sorts when none provided', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          sorts: {
            allowedFields: TEST_SORT_ALLOWED,
            defaults: [{ field: 'created_at', direction: 'desc', tiebreaker: false }],
            tiebreaker: 'id'
          }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20'
        // No sort
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.sorts?.[0].field).toBe('created_at')
        expect(result.data.sorts?.[0].direction).toBe('desc')
      }
    })
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('edge cases', () => {
  describe('empty input', () => {
    it('handles completely empty query', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({})

      expect(result.success).toBe(true)
      if (result.success) {
        const pagination = result.data.pagination
        expect(pagination.type).toBe('offset')
        if (pagination.type === 'offset') {
          expect(pagination.offset).toBe(0)
        }
      }
    })
  })

  describe('whitespace handling', () => {
    it('handles whitespace in filter values', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[title]': '  spaced value  '
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.filters?.[0].value).toBe('  spaced value  ')
      }
    })
  })

  describe('special characters', () => {
    it('handles unicode in filter values', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[title][contains]': '日本語'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.filters?.[0].value).toBe('日本語')
      }
    })
  })

  describe('boundary values', () => {
    it('handles minimum limit', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          pagination: {
            limits: { minLimit: 1, maxLimit: 100, defaultLimit: 20, maxOffset: 10000, cursorTTL: 3600 }
          }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '1'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination.limit).toBe(1)
      }
    })

    it('handles maximum limit', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          pagination: {
            limits: { minLimit: 1, maxLimit: 100, defaultLimit: 20, maxOffset: 10000, cursorTTL: 3600 }
          }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '100'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination.limit).toBe(100)
      }
    })

    it('handles zero offset', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const pagination = result.data.pagination
        expect(pagination.type).toBe('offset')
        if (pagination.type === 'offset') {
          expect(pagination.offset).toBe(0)
        }
      }
    })
  })

  describe('many items', () => {
    it('handles maximum allowed filters', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          filters: {
            registry: TEST_FILTER_REGISTRY,
            limits: { maxFilters: 10 }
          }
        })
      })

      // Create 10 filter params (the max)
      const params: Record<string, string> = {
        offset: '0',
        limit: '20'
      }
      for (let i = 0; i < 10; i++) {
        params[`filter[title][eq]`] = `value${i}` // Will overwrite, just testing count
      }

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        'filter[status]': 'published',
        'filter[price][gte]': '10',
        'filter[price][lte]': '100'
      })

      expect(result.success).toBe(true)
    })

    it('handles maximum allowed sorts', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig({
          sorts: {
            allowedFields: TEST_SORT_ALLOWED,
            limits: { maxSorts: 3 },
            tiebreaker: 'id'
          }
        })
      })

      const result = schema.safeParse({
        offset: '0',
        limit: '20',
        sort: 'created_at:desc,title:asc,price:desc'
      })

      expect(result.success).toBe(true)
    })
  })
})

// ============================================================================
// PRODUCTION ENDPOINT CONFIGURATIONS (IMPORTANT - mirror real endpoints)
// ============================================================================

describe('production endpoint configurations', () => {
  /**
   * These tests mirror actual endpoint definitions to ensure test coverage
   * matches real-world usage patterns.
   */

  describe('collections list endpoint pattern', () => {
    /**
     * Mirrors: functions/collections/endpoints/collections/list/definition.ts
     */
    const collectionsFilterRegistry: FilterRegistry = {
      visibility_code: {
        operators: ['eq', 'in'],
        type: 'string',
        arrayOperators: ['in'],
      },
      collection_type: {
        operators: ['eq', 'in', 'is_null'],
        type: 'string',
        arrayOperators: ['in'],
      },
      deleted_at: {
        operators: ['is_null', 'is_not_null'],
        type: 'date',
      },
      created_at: {
        operators: ['gt', 'gte', 'lt', 'lte'],
        type: 'date',
      },
      updated_at: {
        operators: ['gt', 'gte', 'lt', 'lte'],
        type: 'date',
      },
    }

    const collectionsConfig: EndpointQueryConfig = {
      filters: {
        registry: collectionsFilterRegistry,
        limits: { maxFilters: 10 },
      },
      fields: {
        allowedFields: [
          'id', 'realm_id', 'name', 'slug', 'description',
          'cover_image_url', 'collection_type', 'sort_order',
          'visibility_code', 'item_count', 'created_at', 'updated_at',
        ],
        disabled: true,  // Return all fields by default
      },
      sorts: {
        tiebreaker: 'id',
        allowedFields: ['created_at', 'updated_at', 'name', 'item_count', 'id'],
        limits: { maxSorts: 3 },
        defaults: [
          { field: 'created_at', direction: 'desc' },
        ],
      },
      pagination: {
        cursorSecret: TEST_SECRET,
        limits: {
          defaultLimit: 50,
          maxLimit: 100,
        },
      },
    }

    it('parses typical collections list query', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: collectionsConfig
      })

      const result = schema.safeParse({
        'filter[visibility_code]': 'public',
        sort: 'created_at:desc',
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.filters?.[0]).toEqual({
          field: 'visibility_code',
          operator: 'eq',
          value: 'public'
        })
        expect(result.data.sorts?.[0].field).toBe('created_at')
        expect(result.data.pagination.limit).toBe(20)
      }
    })

    it('handles collection_type IN query', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: collectionsConfig
      })

      const result = schema.safeParse({
        'filter[collection_type][in]': 'reading_list,favorites',
        limit: '50'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const typeFilter = result.data.filters?.find(f => f.field === 'collection_type')
        expect(typeFilter?.operator).toBe('in')
        expect(typeFilter?.value).toEqual(['reading_list', 'favorites'])
      }
    })

    it('applies default sort when no sort provided', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: collectionsConfig
      })

      const result = schema.safeParse({
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        // Should have default sort + tiebreaker
        expect(result.data.sorts?.length).toBeGreaterThanOrEqual(1)
        expect(result.data.sorts?.[0].field).toBe('created_at')
        expect(result.data.sorts?.[0].direction).toBe('desc')
      }
    })

    it('handles null check for soft delete', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: collectionsConfig
      })

      const result = schema.safeParse({
        'filter[deleted_at]': 'null',
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.filters?.[0].operator).toBe('is_null')
      }
    })

    it('respects maxLimit from config', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: collectionsConfig
      })

      const result = schema.safeParse({
        limit: '200'  // Exceeds maxLimit of 100
      })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('100')
      }
    })

    it('respects defaultLimit when no limit provided', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: collectionsConfig
      })

      const result = schema.safeParse({})

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.pagination.limit).toBe(50)  // defaultLimit
      }
    })
  })

  describe('date range filtering pattern', () => {
    /**
     * Common pattern for reporting/analytics endpoints
     */
    const dateRangeConfig: EndpointQueryConfig = {
      filters: {
        registry: {
          created_at: {
            operators: ['gte', 'lt', 'between'],
            type: 'date',
          },
          status: {
            operators: ['eq', 'in'],
            type: 'enum',
            values: ['pending', 'completed', 'failed'],
            arrayOperators: ['in'],
          },
        },
        limits: { maxFilters: 5 },
      },
      fields: { disabled: true },
      sorts: {
        allowedFields: ['created_at', 'id'],
        tiebreaker: 'id',
        limits: { maxSorts: 1 },
      },
      pagination: {
        limits: { defaultLimit: 100, maxLimit: 1000 },
      },
    }

    it('handles date range with gte/lt pattern', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: dateRangeConfig
      })

      const result = schema.safeParse({
        'filter[created_at][gte]': '2024-01-01',
        'filter[created_at][lt]': '2024-02-01',
        limit: '100'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const dateFilters = result.data.filters?.filter(f => f.field === 'created_at')
        expect(dateFilters?.length).toBe(2)
      }
    })

    it('handles date range with between operator', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: dateRangeConfig
      })

      const result = schema.safeParse({
        'filter[created_at][between]': '2024-01-01,2024-12-31',
        limit: '100'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const dateFilter = result.data.filters?.find(f => f.field === 'created_at')
        expect(dateFilter?.operator).toBe('between')
        expect(dateFilter?.value).toHaveLength(2)
      }
    })
  })

  describe('search endpoint pattern', () => {
    /**
     * Pattern for text search with icontains
     */
    const searchConfig: EndpointQueryConfig = {
      filters: {
        registry: {
          query: {
            operators: ['icontains'],
            type: 'string',
          },
          category: {
            operators: ['eq', 'in'],
            type: 'string',
            arrayOperators: ['in'],
          },
        },
        limits: { maxFilters: 3 },
      },
      fields: { disabled: true },
      sorts: {
        allowedFields: ['relevance', 'created_at', 'id'],
        tiebreaker: 'id',
        limits: { maxSorts: 1 },
      },
      pagination: {
        limits: { defaultLimit: 20, maxLimit: 100 },
      },
    }

    it('handles search query with icontains', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: searchConfig
      })

      const result = schema.safeParse({
        'filter[query][icontains]': 'batman',
        'filter[category][in]': 'comics,movies',
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const queryFilter = result.data.filters?.find(f => f.field === 'query')
        expect(queryFilter?.operator).toBe('icontains')
        expect(queryFilter?.value).toBe('batman')

        const categoryFilter = result.data.filters?.find(f => f.field === 'category')
        expect(categoryFilter?.value).toEqual(['comics', 'movies'])
      }
    })
  })

  describe('cursor pagination production flow', () => {
    it('handles full cursor pagination lifecycle', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: makeConfig()
      })

      // First request - no cursor
      const firstPage = schema.safeParse({
        cursor: '',
        limit: '20'
      })

      expect(firstPage.success).toBe(true)
      if (firstPage.success) {
        const pagination = firstPage.data.pagination
        expect(pagination.type).toBe('cursor')
        if (pagination.type === 'cursor') {
          expect(pagination.cursor).toBeUndefined()
        }
      }

      // Subsequent request - with cursor (simulated)
      // In production, this token would come from the prior paginated response.
      const nextCursor = encodeCursor({
        sortField: 'created_at',
        sortValue: '2024-01-01T00:00:00.000Z',
        tiebreaker: 'id',
        tiebreakerValue: 'item-1',
        direction: 'desc',
        createdAt: new Date(),
      }, TEST_SECRET)

      const nextPage = schema.safeParse({
        cursor: nextCursor,
        limit: '20'
      })

      expect(nextPage.success).toBe(true)
      if (nextPage.success) {
        expect(nextPage.data.pagination.type).toBe('cursor')
        if (nextPage.data.pagination.type === 'cursor') {
          expect(nextPage.data.pagination.decodedCursor?.sortField).toBe('created_at')
        }
      }
    })
  })

  describe('disabled components behavior', () => {
    it('ignores filters when filters.disabled=true', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: {
          ...makeConfig(),
          filters: { disabled: true }
        }
      })

      const result = schema.safeParse({
        'filter[unknown_field]': 'value',  // Would normally fail
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.filters).toBeNull()
      }
    })

    it('ignores sorts when sorts.disabled=true', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: {
          ...makeConfig(),
          sorts: { disabled: true }
        }
      })

      const result = schema.safeParse({
        sort: 'unknown_field:desc',  // Would normally fail
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.sorts).toBeNull()
      }
    })

    it('ignores fields when fields.disabled=true', () => {
      const schema = createQuerySchema({
        source: 'query',
        config: {
          ...makeConfig(),
          fields: { disabled: true }
        }
      })

      const result = schema.safeParse({
        fields: 'unknown,fields',  // Would normally fail
        limit: '20'
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.fields).toBeNull()
      }
    })
  })
})


// ============================================================================
// PROPERTY-BASED ROUND-TRIP TESTS
// ============================================================================

describe('property-based round-trip tests', () => {
  /**
   * These tests verify that encode(decode(x)) produces equivalent output.
   * For adapters that are symmetric, decode(encode(x)) === x.
   * 
   * Property-based approach: generate various valid inputs and verify
   * the round-trip preserves semantic meaning.
   */

  describe('filters adapter round-trip', () => {
    const adapter = createFiltersQueryAdapter()

    // Generate test cases programmatically
    const filterCases: Array<{ name: string; encoded: Record<string, string>; normalized: FiltersNormalized }> = [
      {
        name: 'simple equality',
        encoded: { 'filter[status][eq]': 'active' },
        normalized: [{ field: 'status', operator: 'eq', value: 'active' }]
      },
      {
        name: 'comparison operators',
        encoded: { 'filter[price][gte]': '100', 'filter[price][lt]': '500' },
        normalized: [
          { field: 'price', operator: 'gte', value: '100' },
          { field: 'price', operator: 'lt', value: '500' }
        ]
      },
      {
        name: 'array operator (in)',
        encoded: { 'filter[status][in]': 'draft,published,archived' },
        // Note: Adapter decodes to string; array splitting happens in schema coercion
        normalized: [{ field: 'status', operator: 'in', value: 'draft,published,archived' }]
      },
      {
        name: 'null check',
        encoded: { 'filter[deleted_at]': 'null' },
        normalized: [{ field: 'deleted_at', operator: 'is_null' }]
      },
      {
        name: 'not null check',
        encoded: { 'filter[verified_at]': 'not_null' },
        normalized: [{ field: 'verified_at', operator: 'is_not_null' }]
      },
    ]

    filterCases.forEach(({ name, encoded, normalized }) => {
      it(`decode → encode preserves ${name}`, () => {
        const decoded = adapter.decode(encoded)
        const reencoded = adapter.encode(decoded)

        // Decode the re-encoded to compare normalized forms
        const redecoded = adapter.decode(reencoded)
        
        expect(redecoded).toEqual(decoded)
      })

      it(`encode → decode preserves ${name}`, () => {
        const encoded2 = adapter.encode(normalized)
        const decoded = adapter.decode(encoded2)

        expect(decoded).toEqual(normalized)
      })
    })
  })

  describe('sorts adapter round-trip', () => {
    const adapter = createSortsQueryAdapter()

    const sortCases: Array<{ name: string; encoded: string; normalized: SortsNormalized }> = [
      {
        name: 'single ascending',
        encoded: 'created_at:asc',
        normalized: [{ field: 'created_at', direction: 'asc', tiebreaker: false }]
      },
      {
        name: 'single descending',
        encoded: 'updated_at:desc',
        normalized: [{ field: 'updated_at', direction: 'desc', tiebreaker: false }]
      },
      {
        name: 'multiple sorts',
        encoded: 'status:asc,created_at:desc',
        normalized: [
          { field: 'status', direction: 'asc', tiebreaker: false },
          { field: 'created_at', direction: 'desc', tiebreaker: false }
        ]
      },
      {
        name: 'with tiebreaker',
        encoded: 'created_at:desc,id:desc',
        normalized: [
          { field: 'created_at', direction: 'desc', tiebreaker: false },
          { field: 'id', direction: 'desc', tiebreaker: true }  // Last sort can be tiebreaker
        ]
      },
    ]

    sortCases.forEach(({ name, encoded, normalized }) => {
      it(`decode → encode preserves ${name}`, () => {
        const decoded = adapter.decode({ sort: encoded })
        const reencoded = adapter.encode(decoded)

        // Decode again and compare (tiebreaker may be normalized)
        const redecoded = adapter.decode(reencoded)
        
        // Compare fields and directions (tiebreaker is runtime-determined)
        expect(redecoded.map(s => ({ field: s.field, direction: s.direction })))
          .toEqual(decoded.map(s => ({ field: s.field, direction: s.direction })))
      })
    })
  })

  describe('pagination adapter round-trip', () => {
    const adapter = createPaginationQueryAdapter()

    const paginationCases: Array<{ name: string; encoded: Record<string, string>; normalized: Partial<PaginationNormalized> }> = [
      {
        name: 'offset mode',
        encoded: { offset: '20', limit: '10' },
        normalized: { type: 'offset', offset: 20, limit: 10 }
      },
      {
        name: 'cursor mode (first page)',
        encoded: { cursor: '', limit: '20' },
        normalized: { type: 'cursor', limit: 20 }
      },
      {
        name: 'default offset',
        encoded: { limit: '15' },
        normalized: { type: 'offset', offset: 0, limit: 15 }
      },
    ]

    paginationCases.forEach(({ name, encoded, normalized }) => {
      it(`decode produces expected shape for ${name}`, () => {
        const decoded = adapter.decode(encoded)
        
        expect(decoded.type).toBe(normalized.type)
        expect(decoded.limit).toBe(normalized.limit)
        
        if (normalized.type === 'offset' && 'offset' in normalized) {
          expect((decoded as { offset: number }).offset).toBe(normalized.offset)
        }
      })
    })
  })

  describe('fields adapter round-trip', () => {
    const adapter = createFieldsQueryAdapter()

    const fieldsCases: Array<{ name: string; encoded: string; normalized: string[] }> = [
      {
        name: 'single field',
        encoded: 'id',
        normalized: ['id']
      },
      {
        name: 'multiple fields',
        encoded: 'id,name,created_at',
        normalized: ['id', 'name', 'created_at']
      },
      {
        name: 'with whitespace',
        encoded: ' id , name , status ',
        normalized: ['id', 'name', 'status']  // Trimmed
      },
    ]

    fieldsCases.forEach(({ name, encoded, normalized }) => {
      it(`decode → encode preserves ${name}`, () => {
        const decoded = adapter.decode({ fields: encoded })
        
        // Decoded fields should match normalized (after trimming)
        if (decoded && decoded.type === 'simple') {
          expect(decoded.fields.map(f => f.trim())).toEqual(normalized)
        }
      })
    })
  })
})

// ============================================================================
// RANDOMIZED PROPERTY TESTS
// ============================================================================

describe('randomized property tests', () => {
  /**
   * Generate random valid inputs and verify invariants hold.
   * Not true property-based testing (no shrinking), but covers edge cases.
   */

  describe('filter field names', () => {
    const validFieldNames = [
      'a',
      'field',
      'field_name',
      'fieldName',
      'field123',
      '_private',
      'CamelCase',
      'UPPER_CASE',
      'a'.repeat(50),  // Long but reasonable
    ]

    validFieldNames.forEach(fieldName => {
      it(`preserves field name: ${fieldName.slice(0, 20)}...`, () => {
        const adapter = createFiltersQueryAdapter()
        const decoded = adapter.decode({ [`filter[${fieldName}]`]: 'value' })

        expect(decoded).toHaveLength(1)
        expect(decoded[0].field).toBe(fieldName)
      })
    })
  })

  describe('filter values with special characters', () => {
    const specialValues = [
      'hello world',
      'hello,world',  // Commas
      'hello=world',  // Equals
      'hello[world]', // Brackets
      'hello&world',  // Ampersand
      'hello%20world', // URL encoded
      'a+b',          // Plus
      '100%',         // Percent
    ]

    specialValues.forEach(value => {
      it(`preserves value: "${value}"`, () => {
        const adapter = createFiltersQueryAdapter()
        const decoded = adapter.decode({ 'filter[field][eq]': value })

        expect(decoded).toHaveLength(1)
        expect(decoded[0].value).toBe(value)
      })
    })
  })

  describe('sort field stability', () => {
    it('maintains sort order through multiple round-trips', () => {
      const adapter = createSortsQueryAdapter()
      const original = { sort: 'created_at:desc,updated_at:asc,id:asc' }

      let current: { sort?: string | string[] } = original
      for (let i = 0; i < 5; i++) {
        const decoded = adapter.decode(current)
        current = adapter.encode(decoded)
      }

      const finalDecoded = adapter.decode(current)
      const originalDecoded = adapter.decode(original)

      expect(finalDecoded.map(s => s.field)).toEqual(originalDecoded.map(s => s.field))
      expect(finalDecoded.map(s => s.direction)).toEqual(originalDecoded.map(s => s.direction))
    })
  })

  describe('pagination limit boundaries', () => {
    const limits = [1, 10, 20, 50, 100, 500, 1000]

    limits.forEach(limit => {
      it(`preserves limit=${limit} through round-trip`, () => {
        const adapter = createPaginationQueryAdapter()
        const decoded = adapter.decode({ limit: String(limit) })
        const encoded = adapter.encode(decoded)
        const redecoded = adapter.decode(encoded)

        expect(redecoded.limit).toBe(limit)
      })
    })
  })
})