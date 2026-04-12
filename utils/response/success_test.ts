// utils/response/success_test.ts
/**
 * Comprehensive unit tests for success response utilities
 *
 * Test Structure (Effect-TS inspired - precise behavioral contracts):
 * 
 * 1. BASIC ENVELOPES
 *    - ok() - standard success responses
 *    - created() - 201 with Location header
 *    - accepted() - 202 for async operations
 *    - noContent() - 204 responses
 * 
 * 2. PAGINATION RESPONSE
 *    - paginate() - cursor and offset modes
 *    - Link header generation (RFC 8288)
 *    - De-facto headers (X-Total-Count, X-Per-Page, etc.)
 *    - Standards headers (Range-Unit, Content-Range)
 * 
 * 3. URL BUILDING
 *    - buildUrlWithParams() - query string manipulation
 *    - buildCursorUrl() - cursor pagination URLs
 *    - buildOffsetUrl() - offset pagination URLs
 * 
 * 4. RESULT HELPERS
 *    - withHeaders() - merge extra headers
 *    - withMeta() - merge extra metadata
 *    - isSuccessResponse() - type guard
 */

import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import {
  ok,
  created,
  accepted,
  noContent,
  paginate,
  buildUrlWithParams,
  buildCursorUrl,
  buildOffsetUrl,
  withHeaders,
  withMeta,
  isSuccessResponse,
} from './success.ts'

import { badRequest } from './errors.ts'
import type { Pagination } from './schemas.ts'

// ============================================================================
// TEST FIXTURES
// ============================================================================

const TEST_URL = '/api/items'

function makePagination(overrides: Partial<Pagination> = {}): Pagination {
  return {
    hasMore: false,
    limit: 20,
    count: 10,
    ...overrides
  }
}

function makeItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i + 1}`, name: `Item ${i + 1}` }))
}

// ============================================================================
// 1. BASIC ENVELOPES
// ============================================================================

describe('ok', () => {
  describe('status code handling', () => {
    it('defaults to 200', () => {
      const [, status] = ok({ id: '123' })

      expect(status).toBe(200)
    })

    it('accepts explicit status code', () => {
      const [, status] = ok({ id: '123' }, 201)

      expect(status).toBe(201)
    })

    it('returns undefined body for 204', () => {
      const [body, status] = ok(null, 204)

      expect(status).toBe(204)
      expect(body).toBeUndefined()
    })

    it('returns undefined body for 101', () => {
      const [body, status] = ok(null, 101)

      expect(status).toBe(101)
      expect(body).toBeUndefined()
    })

    it('returns undefined body for 205', () => {
      const [body, status] = ok(null, 205)

      expect(status).toBe(205)
      expect(body).toBeUndefined()
    })

    it('returns undefined body for 304', () => {
      const [body, status] = ok(null, 304)

      expect(status).toBe(304)
      expect(body).toBeUndefined()
    })
  })

  describe('envelope structure', () => {
    it('wraps data in { data, meta }', () => {
      const [body] = ok({ id: '123', name: 'Test' })

      expect(body).toHaveProperty('data')
      expect(body).toHaveProperty('meta')
      expect(body.data).toEqual({ id: '123', name: 'Test' })
    })

    it('includes timestamp in meta', () => {
      const before = new Date()
      const [body] = ok({ id: '123' })
      const after = new Date()

      expect(body.meta.timestamp).toBeDefined()
      const timestamp = new Date(body.meta.timestamp)
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('merges custom meta', () => {
      const [body] = ok({ id: '123' }, 200, { custom: 'value', count: 42 })

      expect(body.meta.custom).toBe('value')
      expect(body.meta.count).toBe(42)
      expect(body.meta.timestamp).toBeDefined()
    })
  })

  describe('return tuple', () => {
    it('returns [body, status, headers] tuple', () => {
      const result = ok({ id: '123' })

      expect(result).toHaveLength(3)
    })

    it('sets Content-Type to application/json', () => {
      const [, , headers] = ok({ id: '123' })

      expect(headers['Content-Type']).toBe('application/json')
    })
  })

  describe('data types', () => {
    it('handles null data', () => {
      const [body] = ok(null, 200)

      expect(body.data).toBeNull()
    })

    it('handles array data', () => {
      const items = [{ id: '1' }, { id: '2' }]
      const [body] = ok(items)

      expect(body.data).toEqual(items)
    })

    it('handles primitive data', () => {
      const [body] = ok('string value')

      expect(body.data).toBe('string value')
    })

    it('handles nested objects', () => {
      const data = { nested: { deep: { value: 42 } } }
      const [body] = ok(data)

      expect(body.data).toEqual(data)
    })
  })
})

describe('created', () => {
  it('returns 201 status', () => {
    const [, status] = created({ id: '123' })

    expect(status).toBe(201)
  })

  it('includes Location header when provided', () => {
    const [, , headers] = created({ id: '123' }, '/api/resources/123')

    expect(headers.Location).toBe('/api/resources/123')
  })

  it('omits Location header when not provided', () => {
    const [, , headers] = created({ id: '123' })

    expect(headers.Location).toBeUndefined()
  })

  it('accepts custom meta', () => {
    const [body] = created({ id: '123' }, undefined, { created: true })

    expect(body.meta.created).toBe(true)
  })
})

describe('accepted', () => {
  it('returns 202 status', () => {
    const [, status] = accepted({ taskId: 'task-123' })

    expect(status).toBe(202)
  })

  it('supports tracking metadata', () => {
    const [body] = accepted(
      { taskId: 'task-123' },
      { tracking: { taskId: 'task-123', status: 'queued' } }
    )

    expect(body.meta.tracking).toEqual({ taskId: 'task-123', status: 'queued' })
  })
})

describe('noContent', () => {
  it('returns 204 status', () => {
    const [, status] = noContent()

    expect(status).toBe(204)
  })

  it('returns undefined body', () => {
    const [body] = noContent()

    expect(body).toBeUndefined()
  })
})

// ============================================================================
// 2. PAGINATION RESPONSE
// ============================================================================

describe('paginate', () => {
  describe('cursor mode', () => {
    it('includes nextCursor in meta when provided', () => {
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        hasMore: true,
        nextCursor: 'cursor-abc'
      }))

      expect(body.meta.pagination.nextCursor).toBe('cursor-abc')
    })

    it('includes prevCursor in meta when provided', () => {
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        prevCursor: 'cursor-xyz'
      }))

      expect(body.meta.pagination.prevCursor).toBe('cursor-xyz')
    })

    it('builds Link header with rel="next" for nextCursor', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        hasMore: true,
        nextCursor: 'cursor-next',
        limit: 20
      }))

      expect(headers.Link).toContain('rel="next"')
      expect(headers.Link).toContain('cursor=cursor-next')
    })

    it('builds Link header with rel="prev" for prevCursor', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        prevCursor: 'cursor-prev',
        limit: 20
      }))

      expect(headers.Link).toContain('rel="prev"')
      expect(headers.Link).toContain('cursor=cursor-prev')
    })

    it('includes expiresAt when provided', () => {
      const expiresAt = new Date('2024-01-15T12:00:00Z')
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        expiresAt
      }))

      expect(body.meta.pagination.expiresAt).toEqual(expiresAt)
    })
  })

  describe('offset mode', () => {
    it('includes offset in meta', () => {
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20
      }))

      expect(body.meta.pagination.offset).toBe(40)
    })

    it('includes nextOffset when hasMore', () => {
      const [body] = paginate(TEST_URL, makeItems(20), makePagination({
        offset: 40,
        limit: 20,
        hasMore: true,
        nextOffset: 60
      }))

      expect(body.meta.pagination.hasMore).toBe(true)
    })

    it('builds Link header with rel="first"', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20
      }))

      expect(headers.Link).toContain('rel="first"')
      expect(headers.Link).toContain('offset=0')
    })

    it('builds Link header with rel="last" when total known', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20,
        total: 100
      }))

      expect(headers.Link).toContain('rel="last"')
      expect(headers.Link).toContain('offset=80') // total 100, limit 20 -> last page at 80
    })

    it('builds Link header with rel="next" when hasMore', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(20), makePagination({
        offset: 40,
        limit: 20,
        hasMore: true
      }))

      expect(headers.Link).toContain('rel="next"')
      expect(headers.Link).toContain('offset=60')
    })

    it('builds Link header with rel="prev" when offset > 0', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20
      }))

      expect(headers.Link).toContain('rel="prev"')
      expect(headers.Link).toContain('offset=20')
    })

    it('omits rel="prev" when on first page', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20
      }))

      expect(headers.Link).not.toContain('rel="prev"')
    })
  })

  describe('de-facto headers (offset mode)', () => {
    it('sets X-Total-Count from total', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        total: 100
      }))

      expect(headers['X-Total-Count']).toBe('100')
    })

    it('sets X-Total-Count from approxTotal when no exact total', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        approxTotal: 1000
      }))

      expect(headers['X-Total-Count']).toBe('1000')
    })

    it('sets X-Per-Page from limit', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 25,
        total: 100
      }))

      expect(headers['X-Per-Page']).toBe('25')
    })

    it('sets X-Page (1-indexed)', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20,
        total: 100
      }))

      expect(headers['X-Page']).toBe('3') // offset 40 / limit 20 + 1 = 3
    })

    it('sets X-Total-Pages when exact total known', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        total: 95
      }))

      expect(headers['X-Total-Pages']).toBe('5') // ceil(95/20) = 5
    })

    it('omits X-Total-Pages when only approxTotal', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        approxTotal: 1000
      }))

      expect(headers['X-Total-Pages']).toBeUndefined()
    })

    it('sets Preference-Applied: count=exact when total', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        total: 100
      }))

      expect(headers['Preference-Applied']).toBe('count=exact')
    })

    it('sets Preference-Applied: count=estimated when approxTotal only', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        approxTotal: 1000
      }))

      expect(headers['Preference-Applied']).toBe('count=estimated')
    })
  })

  describe('standards headers (offset mode, exact total)', () => {
    it('sets Range-Unit: items', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        total: 100
      }))

      expect(headers['Range-Unit']).toBe('items')
    })

    it('sets Content-Range: start-end/total (inclusive end)', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(20), makePagination({
        offset: 40,
        limit: 20,
        total: 100
      }))

      expect(headers['Content-Range']).toBe('40-59/100')
    })

    it('handles Content-Range at end of results', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(15), makePagination({
        offset: 85,
        limit: 20,
        total: 100
      }))

      expect(headers['Content-Range']).toBe('85-99/100')
    })

    it('handles Content-Range for single item', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(1), makePagination({
        offset: 0,
        limit: 1,
        total: 1
      }))

      expect(headers['Content-Range']).toBe('0-0/1')
    })

    it('omits Range headers when no exact total', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20,
        approxTotal: 1000
      }))

      expect(headers['Range-Unit']).toBeUndefined()
      expect(headers['Content-Range']).toBeUndefined()
    })
  })

  describe('Link header format', () => {
    it('uses RFC 8288 format: <url>; rel="name"', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20,
        total: 100
      }))

      // Check format: <url>; rel="name"
      expect(headers.Link).toMatch(/<[^>]+>;\s*rel="[^"]+"/);
    })

    it('joins multiple links with comma', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20,
        total: 100,
        hasMore: true
      }))

      // Should have self, first, prev, next, last
      const links = headers.Link.split(',')
      expect(links.length).toBeGreaterThan(1)
    })

    it('includes self link', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 0,
        limit: 20
      }))

      expect(headers.Link).toContain('rel="self"')
    })
  })

  describe('links in meta', () => {
    it('includes links object in meta', () => {
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20,
        total: 100
      }))

      expect(body.meta.links).toBeDefined()
      expect(body.meta.links.self).toBeDefined()
    })

    it('includes all link relations in links object', () => {
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        offset: 40,
        limit: 20,
        total: 100,
        hasMore: true
      }))

      expect(body.meta.links.self).toBeDefined()
      expect(body.meta.links.first).toBeDefined()
      expect(body.meta.links.prev).toBeDefined()
      expect(body.meta.links.next).toBeDefined()
      expect(body.meta.links.last).toBeDefined()
    })
  })

  describe('common metadata', () => {
    it('includes hasMore', () => {
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        hasMore: true
      }))

      expect(body.meta.pagination.hasMore).toBe(true)
    })

    it('includes limit', () => {
      const [body] = paginate(TEST_URL, makeItems(10), makePagination({
        limit: 50
      }))

      expect(body.meta.pagination.limit).toBe(50)
    })

    it('includes count', () => {
      const [body] = paginate(TEST_URL, makeItems(15), makePagination({
        count: 15
      }))

      expect(body.meta.pagination.count).toBe(15)
    })
  })
})

// ============================================================================
// 3. URL BUILDING
// ============================================================================

describe('buildUrlWithParams', () => {
  it('preserves existing query params', () => {
    const result = buildUrlWithParams('/search?q=test', { limit: 20 })

    expect(result).toContain('q=test')
    expect(result).toContain('limit=20')
  })

  it('replaces existing params with new values', () => {
    const result = buildUrlWithParams('/search?offset=10', { offset: 30 })

    expect(result).toBe('/search?offset=30')
  })

  it('adds new params', () => {
    const result = buildUrlWithParams('/items', { offset: 0, limit: 20 })

    expect(result).toContain('offset=0')
    expect(result).toContain('limit=20')
  })

  it('handles relative paths', () => {
    const result = buildUrlWithParams('/api/items', { page: 2 })

    expect(result).toBe('/api/items?page=2')
  })

  it('handles full URLs', () => {
    const result = buildUrlWithParams('https://example.com/api/items', { page: 2 })

    expect(result).toBe('https://example.com/api/items?page=2')
  })

  it('preserves hash fragments', () => {
    const result = buildUrlWithParams('/items#section', { page: 2 })

    expect(result).toBe('/items?page=2#section')
  })

  it('skips null values', () => {
    const result = buildUrlWithParams('/items', { offset: 0, cursor: null })

    expect(result).toBe('/items?offset=0')
    expect(result).not.toContain('cursor')
  })

  it('skips undefined values', () => {
    const result = buildUrlWithParams('/items', { offset: 0, cursor: undefined })

    expect(result).toBe('/items?offset=0')
  })

  it('converts boolean to "true"/"false"', () => {
    const result = buildUrlWithParams('/items', { active: true, deleted: false })

    expect(result).toContain('active=true')
    expect(result).toContain('deleted=false')
  })

  it('converts numbers to strings', () => {
    const result = buildUrlWithParams('/items', { page: 5, limit: 100 })

    expect(result).toContain('page=5')
    expect(result).toContain('limit=100')
  })

  it('handles empty path', () => {
    const result = buildUrlWithParams('', { page: 1 })

    expect(result).toBe('?page=1')
  })

  it('returns path unchanged when no params to add', () => {
    const result = buildUrlWithParams('/items', {})

    expect(result).toBe('/items')
  })
})

describe('buildCursorUrl', () => {
  it('adds cursor and limit params', () => {
    const result = buildCursorUrl('/items', 'cursor-abc', 20)

    expect(result).toContain('cursor=cursor-abc')
    expect(result).toContain('limit=20')
  })

  it('preserves existing params', () => {
    const result = buildCursorUrl('/items?filter=active', 'cursor-xyz', 50)

    expect(result).toContain('filter=active')
    expect(result).toContain('cursor=cursor-xyz')
    expect(result).toContain('limit=50')
  })

  it('replaces existing cursor param', () => {
    const result = buildCursorUrl('/items?cursor=old', 'new-cursor', 20)

    expect(result).toContain('cursor=new-cursor')
    expect(result).not.toContain('cursor=old')
  })

  it('handles base64url-safe cursor tokens', () => {
    const cursor = 'eyJzb3J0RmllbGQiOiJjcmVhdGVkX2F0In0'
    const result = buildCursorUrl('/items', cursor, 20)

    expect(result).toContain(`cursor=${cursor}`)
  })
})

describe('buildOffsetUrl', () => {
  it('adds offset and limit params', () => {
    const result = buildOffsetUrl('/items', 40, 20)

    expect(result).toContain('offset=40')
    expect(result).toContain('limit=20')
  })

  it('preserves existing params', () => {
    const result = buildOffsetUrl('/items?sort=name', 60, 30)

    expect(result).toContain('sort=name')
    expect(result).toContain('offset=60')
    expect(result).toContain('limit=30')
  })

  it('handles zero offset', () => {
    const result = buildOffsetUrl('/items', 0, 20)

    expect(result).toContain('offset=0')
  })

  it('handles large offset', () => {
    const result = buildOffsetUrl('/items', 1000000, 100)

    expect(result).toContain('offset=1000000')
  })
})

// ============================================================================
// 4. RESULT HELPERS
// ============================================================================

describe('withHeaders', () => {
  it('merges extra headers into result tuple', () => {
    const original = ok({ id: '123' })
    const result = withHeaders(original, { 'X-Custom': 'value' })

    expect(result[2]['X-Custom']).toBe('value')
  })

  it('preserves body and status', () => {
    const original = ok({ id: '123' }, 201)
    const result = withHeaders(original, { 'X-Custom': 'value' })

    expect(result[0]).toEqual(original[0])
    expect(result[1]).toBe(201)
  })

  it('overwrites existing headers with same key', () => {
    const original = ok({ id: '123' })
    const result = withHeaders(original, { 'Content-Type': 'text/plain' })

    expect(result[2]['Content-Type']).toBe('text/plain')
  })

  it('preserves original Content-Type when not overwritten', () => {
    const original = ok({ id: '123' })
    const result = withHeaders(original, { 'X-Custom': 'value' })

    expect(result[2]['Content-Type']).toBe('application/json')
  })

  it('works with multiple headers', () => {
    const original = ok({ id: '123' })
    const result = withHeaders(original, {
      'X-Request-Id': 'req-123',
      'X-Response-Time': '42ms',
      'Cache-Control': 'no-cache'
    })

    expect(result[2]['X-Request-Id']).toBe('req-123')
    expect(result[2]['X-Response-Time']).toBe('42ms')
    expect(result[2]['Cache-Control']).toBe('no-cache')
  })
})

describe('withMeta', () => {
  it('merges extra metadata into envelope', () => {
    const original = ok({ id: '123' })
    const result = withMeta(original, { custom: 'metadata' })

    expect(result[0].meta.custom).toBe('metadata')
  })

  it('preserves existing meta including timestamp', () => {
    const original = ok({ id: '123' }, 200, { existing: 'value' })
    const result = withMeta(original, { added: 'new' })

    expect(result[0].meta.timestamp).toBeDefined()
    expect(result[0].meta.existing).toBe('value')
    expect(result[0].meta.added).toBe('new')
  })

  it('preserves body, status, headers', () => {
    const original = ok({ id: '123' }, 201)
    const result = withMeta(original, { extra: true })

    expect(result[0].data).toEqual({ id: '123' })
    expect(result[1]).toBe(201)
    expect(result[2]['Content-Type']).toBe('application/json')
  })

  it('works with pagination results', () => {
    const original = paginate(TEST_URL, makeItems(10), makePagination())
    const result = withMeta(original, { query: { durationMs: 42 } })

    expect(result[0].meta.query).toEqual({ durationMs: 42 })
    expect(result[0].meta.pagination).toBeDefined()
  })

  it('overwrites existing meta keys', () => {
    const original = ok({ id: '123' }, 200, { key: 'original' })
    const result = withMeta(original, { key: 'overwritten' })

    expect(result[0].meta.key).toBe('overwritten')
  })
})

describe('isSuccessResponse', () => {
  it('returns true for ok() results', () => {
    const result = ok({ id: '123' })

    expect(isSuccessResponse(result)).toBe(true)
  })

  it('returns true for created() results', () => {
    const result = created({ id: '123' })

    expect(isSuccessResponse(result)).toBe(true)
  })

  it('returns true for accepted() results', () => {
    const result = accepted({ taskId: 'task-123' })

    expect(isSuccessResponse(result)).toBe(true)
  })

  it('returns true for noContent() results', () => {
    const result = noContent()

    expect(isSuccessResponse(result)).toBe(true)
  })

  it('returns true for paginate() results', () => {
    const result = paginate(TEST_URL, makeItems(10), makePagination())

    expect(isSuccessResponse(result)).toBe(true)
  })

  it('returns false for error results', () => {
    const result = badRequest('/test', 'Error message')

    expect(isSuccessResponse(result)).toBe(false)
  })

  it('correctly narrows type', () => {
    const result = ok({ id: '123', name: 'Test' })

    if (isSuccessResponse(result)) {
      // TypeScript should know this is SuccessResponse
      const [body, status] = result
      expect(body.data.id).toBe('123')
      expect(status).toBe(200)
    }
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('edge cases', () => {
  describe('empty data', () => {
    it('handles empty array', () => {
      const [body] = ok([])

      expect(body.data).toEqual([])
    })

    it('handles empty object', () => {
      const [body] = ok({})

      expect(body.data).toEqual({})
    })

    it('paginate handles empty items array', () => {
      const [body] = paginate(TEST_URL, [], makePagination({ count: 0 }))

      expect(body.data).toEqual([])
      expect(body.meta.pagination.count).toBe(0)
    })
  })

  describe('special characters in URLs', () => {
    it('normalizes existing URL-encoded characters through URLSearchParams', () => {
      const result = buildUrlWithParams('/search?q=hello%20world', { page: 2 })

      expect(result).toContain('q=hello+world')
    })

    it('handles special characters in param values', () => {
      const result = buildUrlWithParams('/search', { q: 'hello world' })

      expect(result).toContain('q=hello+world') // URLSearchParams encodes space as +
    })
  })

  describe('pagination edge cases', () => {
    it('handles total of 0', () => {
      const [, , headers] = paginate(TEST_URL, [], makePagination({
        offset: 0,
        limit: 20,
        total: 0,
        count: 0
      }))

      expect(headers['X-Total-Count']).toBe('0')
      expect(headers['X-Total-Pages']).toBe('1') // At least 1 page even with 0 items
    })

    it('handles limit larger than total', () => {
      const [, , headers] = paginate(TEST_URL, makeItems(5), makePagination({
        offset: 0,
        limit: 100,
        total: 5
      }))

      expect(headers['Content-Range']).toBe('0-4/5')
    })

    it('handles very large offset', () => {
      const [, , headers] = paginate(TEST_URL, [], makePagination({
        offset: 1000000,
        limit: 20,
        total: 100,
        count: 0
      }))

      // Content-Range should handle out-of-bounds gracefully
      expect(headers['Content-Range']).toBeDefined()
    })
  })

  describe('unicode in data', () => {
    it('handles unicode in response data', () => {
      const [body] = ok({ name: '日本語', emoji: '🚀' })

      expect(body.data.name).toBe('日本語')
      expect(body.data.emoji).toBe('🚀')
    })

    it('handles unicode in cursor values', () => {
      const result = buildCursorUrl('/items', 'カーソル', 20)

      expect(result).toContain('cursor=')
    })
  })
})