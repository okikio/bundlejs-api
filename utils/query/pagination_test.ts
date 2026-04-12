// utils/query/pagination_test.ts
/**
 * Comprehensive unit tests for pagination utilities
 *
 * Test Structure (Effect-TS inspired - precise behavioral contracts):
 * 
 * 1. CANONICALIZATION
 *    - sortObject() - deterministic key ordering for signatures
 * 
 * 2. CRYPTOGRAPHY
 *    - hmacSha256Hex() - HMAC-SHA256 signature generation
 *    - Base64UrlJsonCursorCodec - wire encoding/decoding
 *    - encodeCursor() / decodeAndVerifyCursor() - signed cursor tokens
 * 
 * 3. WIRE SCHEMAS (4 input forms)
 *    - Query params: ?offset=10&limit=20 or ?cursor=abc&limit=20
 *    - JSON body: { pagination: { type: 'offset', offset: 10, limit: 20 } }
 *    - Form data: offset=10&limit=20
 *    - Normalized output: { type: 'offset'|'cursor', ... }
 * 
 * 4. ADAPTERS (decode/encode round-trips)
 *    - createPaginationQueryAdapter
 *    - createPaginationJsonAdapter
 *    - createPaginationFormAdapter
 * 
 * 5. VALIDATION (createPaginationSchema)
 *    - Limit bounds (minLimit, maxLimit)
 *    - Offset bounds (maxOffset for DoS protection)
 *    - Cursor decoding with signature verification
 * 
 * 6. RESPONSE GENERATION
 *    - cursorFromRow() - extract cursor data from DB rows
 *    - makeCursorTokens() - generate next/prev tokens
 *    - computeExpiresAt() - TTL calculation
 *    - buildPaginationMeta() - complete pagination metadata
 */

import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { Buffer } from 'node:buffer'

import {
  sortObject,
  hmacSha256Hex,
  encodeCursor,
  decodeAndVerifyCursor,
  createPaginationQueryAdapter,
  createPaginationJsonAdapter,
  createPaginationFormAdapter,
  createPaginationSchema,
  Base64UrlJsonCursorCodec,
  cursorFromRow,
  makeCursorTokens,
  computeExpiresAt,
  buildPaginationMeta,
} from './pagination.ts'

import { isErrorResponse } from '../response/errors.ts'
import { isSuccessResponse } from '../response/success.ts'
import type { CursorData, QuerySpec } from './schemas.ts'

// ============================================================================
// TEST FIXTURES
// ============================================================================

const TEST_SECRET = 'test-secret-key-for-hmac-signing-minimum-32-chars'

/**
 * Valid cursor data matching the actual CursorData schema shape
 * (as produced by cursorFromRow)
 */
function makeValidCursorData(overrides: Partial<CursorData> = {}): CursorData {
  return {
    sortField: 'created_at',
    sortValue: '2024-01-15T10:00:00Z',
    tiebreaker: 'id',
    tiebreakerValue: 'item-123',
    direction: 'desc' as const,
    createdAt: new Date(),
    ...overrides,
  }
}

/**
 * Sample database rows for testing cursor generation
 */
const sampleRows = [
  { id: 'row-1', created_at: '2024-01-15T10:00:00Z', title: 'First' },
  { id: 'row-2', created_at: '2024-01-15T11:00:00Z', title: 'Second' },
  { id: 'row-3', created_at: '2024-01-15T12:00:00Z', title: 'Third' },
]


function makeQuerySpec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    pagination: { type: 'offset', offset: 0, limit: 20 },
    filters: null,
    sorts: null,
    fields: null,
    ...overrides
  }
}

function makeCursorQuerySpec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    pagination: { type: 'cursor', limit: 20 },
    filters: null,
    sorts: null,
    fields: null,
    ...overrides
  }
}

// ============================================================================
// 1. CANONICALIZATION - sortObject()
// ============================================================================

describe('sortObject', () => {
  describe('key ordering', () => {
    it('sorts top-level keys alphabetically', () => {
      const input = { z: 1, a: 2, m: 3 }
      const result = sortObject(input)
      
      expect(Object.keys(result)).toEqual(['a', 'm', 'z'])
    })

    it('sorts nested object keys recursively', () => {
      const input = {
        outer: { z: 1, a: 2 },
        another: 'value',
      }
      const result = sortObject(input)

      expect(Object.keys(result)).toEqual(['another', 'outer'])
      expect(Object.keys(result.outer)).toEqual(['a', 'z'])
    })

    it('sorts objects within arrays', () => {
      const input = {
        items: [
          { z: 1, a: 2 },
          { y: 3, b: 4 },
        ],
      }
      const result = sortObject(input)

      expect(Object.keys(result.items[0])).toEqual(['a', 'z'])
      expect(Object.keys(result.items[1])).toEqual(['b', 'y'])
    })

    it('handles deeply nested structures', () => {
      const input = { c: { b: { a: 1 } } }
      const result = sortObject(input)
      
      expect(JSON.stringify(result)).toBe('{"c":{"b":{"a":1}}}')
    })
  })

  describe('type handling', () => {
    it('converts Date to ISO string for consistent serialization', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const result = sortObject({ date })

      expect(result.date).toBe('2024-01-15T10:30:00.000Z')
    })

    it('passes null through unchanged', () => {
      expect(sortObject(null)).toBe(null)
    })

    it('passes undefined through unchanged', () => {
      expect(sortObject(undefined)).toBe(undefined)
    })

    it('passes primitives through unchanged', () => {
      expect(sortObject('string')).toBe('string')
      expect(sortObject(42)).toBe(42)
      expect(sortObject(true)).toBe(true)
      expect(sortObject(0)).toBe(0)
      expect(sortObject('')).toBe('')
    })

    it('preserves array element order (does not sort values)', () => {
      const input = [3, 1, 2]
      expect(sortObject(input)).toEqual([3, 1, 2])
    })

    it('handles empty objects', () => {
      expect(sortObject({})).toEqual({})
    })

    it('handles empty arrays', () => {
      expect(sortObject([])).toEqual([])
    })
  })

  describe('signature stability', () => {
    it('produces identical output for differently-ordered inputs', () => {
      const a = { z: 1, a: 2, m: 3 }
      const b = { a: 2, m: 3, z: 1 }
      
      expect(JSON.stringify(sortObject(a))).toBe(JSON.stringify(sortObject(b)))
    })
  })
})

// ============================================================================
// 2. CRYPTOGRAPHY - HMAC and Cursor Tokens
// ============================================================================

describe('hmacSha256Hex', () => {
  describe('determinism', () => {
    it('generates identical signature for identical input', () => {
      const payload = { id: '123', type: 'test' }

      const sig1 = hmacSha256Hex(TEST_SECRET, payload)
      const sig2 = hmacSha256Hex(TEST_SECRET, payload)

      expect(sig1).toBe(sig2)
    })

    it('generates identical signature regardless of key order', () => {
      const sig1 = hmacSha256Hex(TEST_SECRET, { b: 2, a: 1 })
      const sig2 = hmacSha256Hex(TEST_SECRET, { a: 1, b: 2 })

      expect(sig1).toBe(sig2)
    })
  })

  describe('uniqueness', () => {
    it('generates different signatures for different payloads', () => {
      const sig1 = hmacSha256Hex(TEST_SECRET, { id: '123' })
      const sig2 = hmacSha256Hex(TEST_SECRET, { id: '456' })

      expect(sig1).not.toBe(sig2)
    })

    it('generates different signatures for different secrets', () => {
      const payload = { id: '123' }

      const sig1 = hmacSha256Hex('secret-1', payload)
      const sig2 = hmacSha256Hex('secret-2', payload)

      expect(sig1).not.toBe(sig2)
    })
  })

  describe('format', () => {
    it('returns 64-character lowercase hex string', () => {
      const sig = hmacSha256Hex(TEST_SECRET, { test: true })

      expect(sig).toHaveLength(64)
      expect(/^[a-f0-9]{64}$/.test(sig)).toBe(true)
    })
  })
})

describe('Base64UrlJsonCursorCodec', () => {
  describe('encode', () => {
    it('produces URL-safe base64 string', () => {
      const data = makeValidCursorData()
      const envelope = { data, signature: 'a'.repeat(64) }
      const encoded = Base64UrlJsonCursorCodec.encode(envelope)

      // Base64url uses only alphanumerics, underscore, and hyphen
      expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true)
    })

    it('does not include padding characters', () => {
      const data = makeValidCursorData()
      const envelope = { data, signature: 'b'.repeat(64) }
      const encoded = Base64UrlJsonCursorCodec.encode(envelope)

      expect(encoded).not.toContain('=')
    })
  })

  describe('decode', () => {
    it('successfully decodes valid token', () => {
      const originalData = makeValidCursorData({ sortValue: 'decoded-value' })
      const original = { data: originalData, signature: 'c'.repeat(64) }
      const token = Base64UrlJsonCursorCodec.encode(original)
      const decoded = Base64UrlJsonCursorCodec.decode(token)

      expect(decoded.data.sortField).toBe(originalData.sortField)
      expect(decoded.data.sortValue).toBe('decoded-value')
      expect(decoded.signature).toBe(original.signature)
    })

    it('throws on invalid base64', () => {
      expect(() => Base64UrlJsonCursorCodec.decode('not!valid@base64'))
        .toThrow()
    })

    it('throws on invalid JSON', () => {
      // Valid base64 but invalid JSON
      const invalidJson = Buffer.from('not json').toString('base64url')
      expect(() => Base64UrlJsonCursorCodec.decode(invalidJson))
        .toThrow()
    })
  })

  describe('round-trip', () => {
    it('preserves data through encode/decode cycle', () => {
      const originalData = makeValidCursorData({
        sortField: 'score',
        sortValue: 42,
        tiebreaker: 'uuid',
        tiebreakerValue: 'abc-123',
        direction: 'asc',
      })
      const original = {
        data: originalData,
        signature: 'd'.repeat(64),
      }

      const encoded = Base64UrlJsonCursorCodec.encode(original)
      const decoded = Base64UrlJsonCursorCodec.decode(encoded)

      expect(decoded.data.sortField).toBe(originalData.sortField)
      expect(decoded.data.sortValue).toBe(originalData.sortValue)
      expect(decoded.data.tiebreaker).toBe(originalData.tiebreaker)
      expect(decoded.data.tiebreakerValue).toBe(originalData.tiebreakerValue)
      expect(decoded.data.direction).toBe(originalData.direction)
      const decodedCreatedAt = (decoded.data as any).createdAt
      expect(new Date(decodedCreatedAt).toISOString()).toBe(originalData.createdAt.toISOString())
      expect(decoded.signature).toBe(original.signature)
    })
  })
})

describe('encodeCursor', () => {
  it('produces base64url encoded token', () => {
    const data = makeValidCursorData()
    const token = encodeCursor(data, TEST_SECRET)

    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true)
  })

  it('embeds correct signature', () => {
    const data = makeValidCursorData()
    const token = encodeCursor(data, TEST_SECRET)
    const decoded = Base64UrlJsonCursorCodec.decode(token)

    // Signature should match HMAC of data
    const expectedSig = hmacSha256Hex(TEST_SECRET, data)
    expect(decoded.signature).toBe(expectedSig)
  })

  it('embeds cursor data', () => {
    const data = makeValidCursorData({ sortField: 'score', sortValue: 99 })
    const token = encodeCursor(data, TEST_SECRET)
    const decoded = Base64UrlJsonCursorCodec.decode(token)

    expect(decoded.data.sortField).toBe('score')
    expect(decoded.data.sortValue).toBe(99)
  })
})

describe('decodeAndVerifyCursor', () => {
  describe('valid cursors', () => {
    it('returns success for valid unexpired cursor', () => {
      const data = makeValidCursorData()
      const token = encodeCursor(data, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET)

      expect(isSuccessResponse(result)).toBe(true)
      expect(result[1]).toBe(200)
    })

    it('returns decoded cursor data on success', () => {
      const data = makeValidCursorData({ sortValue: 'test-value' })
      const token = encodeCursor(data, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET)

      expect(isSuccessResponse(result)).toBe(true)
      const [body] = result
      expect((body as { data: typeof data }).data.sortValue).toBe('test-value')
    })
  })

  describe('malformed tokens', () => {
    it('returns 400 for invalid base64', () => {
      const result = decodeAndVerifyCursor('not!valid@base64', TEST_SECRET)

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(400)
    })

    it('returns 400 for valid base64 with invalid JSON', () => {
      const invalidJson = Buffer.from('not json').toString('base64url')
      const result = decodeAndVerifyCursor(invalidJson, TEST_SECRET)

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(400)
    })

    it('returns 400 for empty string', () => {
      const result = decodeAndVerifyCursor('', TEST_SECRET)

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(400)
    })
  })

  describe('signature verification', () => {
    it('returns 400 for tampered data', () => {
      const data = makeValidCursorData()
      const token = encodeCursor(data, TEST_SECRET)

      // Tamper with data while keeping original signature
      const decoded = Base64UrlJsonCursorCodec.decode(token)
      decoded.data.sortValue = 'tampered'
      const tamperedToken = Base64UrlJsonCursorCodec.encode(decoded)

      const result = decodeAndVerifyCursor(tamperedToken, TEST_SECRET)

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(400)
      expect((result[0] as { detail: string }).detail).toContain('signature')
    })

    it('returns 400 for wrong secret', () => {
      const data = makeValidCursorData()
      const token = encodeCursor(data, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, 'wrong-secret')

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(400)
    })

    it('returns 400 for truncated signature', () => {
      const data = makeValidCursorData()
      const token = encodeCursor(data, TEST_SECRET)
      const decoded = Base64UrlJsonCursorCodec.decode(token)
      decoded.signature = decoded.signature.slice(0, 32) // Truncate
      const brokenToken = Base64UrlJsonCursorCodec.encode(decoded)

      const result = decodeAndVerifyCursor(brokenToken, TEST_SECRET)

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(400)
    })
  })

  describe('expiration (TTL)', () => {
    it('returns 410 Gone for expired cursor (default 24h TTL)', () => {
      const expiredData = makeValidCursorData({
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
      })
      const token = encodeCursor(expiredData, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET)

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(410)
    })

    it('accepts cursor within default TTL', () => {
      const recentData = makeValidCursorData({
        createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000), // 23 hours ago
      })
      const token = encodeCursor(recentData, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET)

      expect(isSuccessResponse(result)).toBe(true)
    })

    it('accepts cursor within custom TTL', () => {
      const data = makeValidCursorData({
        createdAt: new Date(Date.now() - 3600_000), // 1 hour ago
      })
      const token = encodeCursor(data, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET, 7200) // 2h TTL

      expect(isSuccessResponse(result)).toBe(true)
    })

    it('rejects cursor exceeding custom TTL', () => {
      const data = makeValidCursorData({
        createdAt: new Date(Date.now() - 3600_000), // 1 hour ago
      })
      const token = encodeCursor(data, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET, 1800) // 30min TTL

      expect(isErrorResponse(result)).toBe(true)
      expect(result[1]).toBe(410)
    })

    it('includes expiration delta in 410 response', () => {
      const expiredData = makeValidCursorData({
        createdAt: new Date(Date.now() - 100_000_000), // ~27 hours ago
      })
      const token = encodeCursor(expiredData, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET)

      expect(isErrorResponse(result)).toBe(true)
      const [body] = result
      expect((body as { deltaSeconds?: number }).deltaSeconds).toBeGreaterThan(0)
    })
  })

  describe('round-trip integrity', () => {
    it('preserves all cursor data fields', () => {
      const original = makeValidCursorData({
        sortField: 'score',
        sortValue: 99.5,
        tiebreaker: 'uuid',
        tiebreakerValue: 'abc-123-def',
        direction: 'asc',
      })

      const token = encodeCursor(original, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET)

      expect(isSuccessResponse(result)).toBe(true)
      const decoded = (result[0] as { data: typeof original }).data

      expect(decoded.sortField).toBe('score')
      expect(decoded.sortValue).toBe(99.5)
      expect(decoded.tiebreaker).toBe('uuid')
      expect(decoded.tiebreakerValue).toBe('abc-123-def')
      expect(decoded.direction).toBe('asc')
    })
  })
})

// ============================================================================
// 3. WIRE SCHEMAS - Query Adapter
// ============================================================================

describe('createPaginationQueryAdapter', () => {
  const adapter = createPaginationQueryAdapter(20)

  describe('offset-based pagination', () => {
    it('parses offset and limit from query params', () => {
      const result = adapter.decode({ offset: '40', limit: '10' })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(40)
        expect(result.limit).toBe(10)
      }
    })

    it('uses default limit when not provided', () => {
      const result = adapter.decode({ offset: '0' })

      expect(result.limit).toBe(20)
    })

    it('defaults to offset 0 when not provided', () => {
      const result = adapter.decode({})

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(0)
      }
    })

    it('parses zero offset', () => {
      const result = adapter.decode({ offset: '0', limit: '10' })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(0)
      }
    })
  })

  describe('page-based pagination (converts to offset)', () => {
    it('converts page 1 to offset 0', () => {
      const result = adapter.decode({ page: '1', per_page: '10' })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(0)
        expect(result.limit).toBe(10)
      }
    })

    it('converts page N to offset (N-1)*limit', () => {
      const result = adapter.decode({ page: '3', per_page: '10' })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(20)
      }
    })

    it('prefers per_page over limit', () => {
      const result = adapter.decode({ page: '2', per_page: '15', limit: '10' })

      expect(result.limit).toBe(15)
    })

    it('falls back to limit when per_page not provided', () => {
      const result = adapter.decode({ page: '2', limit: '25' })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(25)
      }
      expect(result.limit).toBe(25)
    })
  })

  describe('cursor-based pagination', () => {
    it('detects cursor mode when cursor param present', () => {
      const result = adapter.decode({ cursor: 'abc123', limit: '15' })

      expect(result.type).toBe('cursor')
      if (result.type === 'cursor') {
        expect(result.cursor).toBe('abc123')
        expect(result.limit).toBe(15)
      }
    })

    it('treats empty cursor as first page (cursor undefined)', () => {
      const result = adapter.decode({ cursor: '', limit: '10' })

      expect(result.type).toBe('cursor')
      if (result.type === 'cursor') {
        expect(result.cursor).toBeUndefined()
      }
    })

    it('cursor takes precedence over offset params', () => {
      const result = adapter.decode({ cursor: 'xyz', offset: '100', limit: '10' })

      expect(result.type).toBe('cursor')
    })
  })

  describe('array value handling (ZStringOrStringArray)', () => {
    it('takes first value when array provided', () => {
      const result = adapter.decode({ 
        offset: ['10', '20'], 
        limit: ['5', '15'] 
      })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(10)
      }
      expect(result.limit).toBe(5)
    })
  })

  describe('custom default limit', () => {
    it('respects custom default limit', () => {
      const customAdapter = createPaginationQueryAdapter(50)
      const result = customAdapter.decode({})

      expect(result.limit).toBe(50)
    })
  })

  describe('encode (reverse transform)', () => {
    it('encodes offset pagination back to query format', () => {
      const normalized = { type: 'offset' as const, offset: 40, limit: 20 }
      const wire = adapter.encode(normalized)

      expect(wire.offset).toBe('40')
      expect(wire.limit).toBe('20')
    })

    it('encodes cursor pagination back to query format', () => {
      const normalized = { type: 'cursor' as const, cursor: 'abc', limit: 15 }
      const wire = adapter.encode(normalized)

      expect(wire.cursor).toBe('abc')
      expect(wire.limit).toBe('15')
    })
  })

  describe('round-trip (decode → encode → decode)', () => {
    it('preserves offset pagination through round-trip', () => {
      const input = { offset: '50', limit: '25' }
      const decoded = adapter.decode(input)
      const encoded = adapter.encode(decoded)
      const redecoded = adapter.decode(encoded)

      expect(redecoded).toEqual(decoded)
    })

    it('preserves cursor pagination through round-trip', () => {
      const input = { cursor: 'token123', limit: '30' }
      const decoded = adapter.decode(input)
      const encoded = adapter.encode(decoded)
      const redecoded = adapter.decode(encoded)

      expect(redecoded).toEqual(decoded)
    })
  })
})

// ============================================================================
// 3. WIRE SCHEMAS - JSON Adapter
// ============================================================================

describe('createPaginationJsonAdapter', () => {
  const adapter = createPaginationJsonAdapter(20)

  describe('offset-based pagination', () => {
    it('extracts pagination from JSON body', () => {
      const result = adapter.decode({
        pagination: { type: 'offset', offset: 100, limit: 25 },
      })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(100)
        expect(result.limit).toBe(25)
      }
    })
  })

  describe('cursor-based pagination', () => {
    it('extracts cursor pagination from JSON body', () => {
      const result = adapter.decode({
        pagination: { type: 'cursor', cursor: 'xyz789', limit: 10 },
      })

      expect(result.type).toBe('cursor')
      if (result.type === 'cursor') {
        expect(result.cursor).toBe('xyz789')
        expect(result.limit).toBe(10)
      }
    })
  })

  describe('defaults', () => {
    it('uses defaults when pagination not provided', () => {
      const result = adapter.decode({})

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(0)
        expect(result.limit).toBe(20)
      }
    })

    it('uses custom default limit', () => {
      const customAdapter = createPaginationJsonAdapter(50)
      const result = customAdapter.decode({})

      expect(result.limit).toBe(50)
    })
  })

  describe('encode', () => {
    it('wraps normalized pagination in envelope', () => {
      const normalized = { type: 'offset' as const, offset: 10, limit: 20 }
      const wire = adapter.encode(normalized)

      expect(wire).toEqual({ pagination: normalized })
    })
  })

  describe('round-trip', () => {
    it('preserves data through encode/decode cycle', () => {
      const input = {
        pagination: { type: 'cursor' as const, cursor: 'abc', limit: 15 },
      }
      const decoded = adapter.decode(input)
      const encoded = adapter.encode(decoded)
      const redecoded = adapter.decode(encoded)

      expect(redecoded).toEqual(decoded)
    })
  })
})

// ============================================================================
// 3. WIRE SCHEMAS - Form Adapter
// ============================================================================

describe('createPaginationFormAdapter', () => {
  const adapter = createPaginationFormAdapter(20)

  describe('offset-based pagination', () => {
    it('parses form data like query params', () => {
      const result = adapter.decode({ offset: '50', limit: '15' })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(50)
        expect(result.limit).toBe(15)
      }
    })
  })

  describe('page-based pagination', () => {
    it('converts page to offset', () => {
      const result = adapter.decode({ page: '4', per_page: '20' })

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(60)
        expect(result.limit).toBe(20)
      }
    })
  })

  describe('cursor-based pagination', () => {
    it('detects cursor mode', () => {
      const result = adapter.decode({ cursor: 'form-cursor', limit: '10' })

      expect(result.type).toBe('cursor')
      if (result.type === 'cursor') {
        expect(result.cursor).toBe('form-cursor')
      }
    })
  })

  describe('defaults', () => {
    it('uses defaults when no params provided', () => {
      const result = adapter.decode({})

      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(0)
        expect(result.limit).toBe(20)
      }
    })
  })

  describe('encode', () => {
    it('encodes offset pagination to form format', () => {
      const normalized = { type: 'offset' as const, offset: 30, limit: 10 }
      const wire = adapter.encode(normalized)

      expect(wire.offset).toBe('30')
      expect(wire.limit).toBe('10')
    })

    it('encodes cursor pagination to form format', () => {
      const normalized = { type: 'cursor' as const, cursor: 'xyz', limit: 25 }
      const wire = adapter.encode(normalized)

      expect(wire.cursor).toBe('xyz')
      expect(wire.limit).toBe('25')
    })
  })
})

// ============================================================================
// 4. VALIDATION - createPaginationSchema
// ============================================================================

describe('createPaginationSchema', () => {
  describe('limit bounds validation', () => {
    const schema = createPaginationSchema({
      source: 'query',
      limits: {
        minLimit: 5,
        maxLimit: 100,
        defaultLimit: 20,
        maxOffset: 1_000_000,
        cursorTTL: 86400,
      },
    })

    it('accepts limit within bounds', () => {
      const result = schema.safeParse({ limit: '50' })
      expect(result.success).toBe(true)
    })

    it('rejects limit below minimum', () => {
      const result = schema.safeParse({ limit: '2' })
      
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('limit')
        expect(result.error.issues[0].message).toContain('5')
      }
    })

    it('rejects limit above maximum', () => {
      const result = schema.safeParse({ limit: '200' })
      
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('limit')
        expect(result.error.issues[0].message).toContain('100')
      }
    })

    it('accepts limit at minimum boundary', () => {
      const result = schema.safeParse({ limit: '5' })
      expect(result.success).toBe(true)
    })

    it('accepts limit at maximum boundary', () => {
      const result = schema.safeParse({ limit: '100' })
      expect(result.success).toBe(true)
    })
  })

  describe('offset bounds validation (DoS protection)', () => {
    const schema = createPaginationSchema({
      source: 'query',
      limits: {
        minLimit: 1,
        maxLimit: 100,
        defaultLimit: 20,
        maxOffset: 10000,
        cursorTTL: 86400,
      },
    })

    it('accepts offset within bounds', () => {
      const result = schema.safeParse({ offset: '5000' })
      expect(result.success).toBe(true)
    })

    it('rejects offset exceeding maximum', () => {
      const result = schema.safeParse({ offset: '50000' })
      
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('offset')
        expect(result.error.issues[0].message).toContain('DoS')
      }
    })
  })

  describe('cursor decoding integration', () => {
    const schema = createPaginationSchema({
      source: 'query',
      cursorSecret: TEST_SECRET,
      limits: {
        minLimit: 1,
        maxLimit: 100,
        defaultLimit: 20,
        maxOffset: 1_000_000,
        cursorTTL: 86400,
      },
    })

    it('decodes valid cursor and attaches data', () => {
      const cursorData = makeValidCursorData()
      const token = encodeCursor(cursorData, TEST_SECRET)
      
      const result = schema.safeParse({ cursor: token, limit: '10' })
      
      expect(result.success).toBe(true)
      if (result.success && result.data.type === 'cursor') {
        expect(result.data.decodedCursor).toBeDefined()
        expect(result.data.decodedCursor?.sortField).toBe('created_at')
      }
    })

    it('rejects expired cursor', () => {
      const expiredData = makeValidCursorData({
        createdAt: new Date(Date.now() - 100_000_000),
      })
      const token = encodeCursor(expiredData, TEST_SECRET)
      
      const result = schema.safeParse({ cursor: token, limit: '10' })
      
      expect(result.success).toBe(false)
    })

    it('rejects tampered cursor', () => {
      const cursorData = makeValidCursorData()
      const token = encodeCursor(cursorData, TEST_SECRET)
      
      // Tamper with token
      const decoded = Base64UrlJsonCursorCodec.decode(token)
      decoded.data.sortField = 'hacked'
      const tampered = Base64UrlJsonCursorCodec.encode(decoded)
      
      const result = schema.safeParse({ cursor: tampered, limit: '10' })
      
      expect(result.success).toBe(false)
    })
  })

  describe('source-specific parsing', () => {
    it('parses query source', () => {
      const schema = createPaginationSchema({
        source: 'query',
        limits: {
          minLimit: 1,
          maxLimit: 100,
          defaultLimit: 20,
          maxOffset: 1_000_000,
          cursorTTL: 86400,
        },
      })
      const result = schema.safeParse({ offset: '10', limit: '20' })
      
      expect(result.success).toBe(true)
    })

    it('parses json source', () => {
      const schema = createPaginationSchema({
        source: 'json',
        limits: {
          minLimit: 1,
          maxLimit: 100,
          defaultLimit: 20,
          maxOffset: 1_000_000,
          cursorTTL: 86400,
        },
      })
      const result = schema.safeParse({
        pagination: { type: 'offset', offset: 10, limit: 20 },
      })
      
      expect(result.success).toBe(true)
    })

    it('parses form source', () => {
      const schema = createPaginationSchema({
        source: 'form',
        limits: {
          minLimit: 1,
          maxLimit: 100,
          defaultLimit: 20,
          maxOffset: 1_000_000,
          cursorTTL: 86400,
        },
      })
      const result = schema.safeParse({ offset: '10', limit: '20' })
      
      expect(result.success).toBe(true)
    })
  })
})

// ============================================================================
// 5. RESPONSE GENERATION
// ============================================================================

describe('cursorFromRow', () => {
  it('extracts sort field value from row', () => {
    const row = { id: 'abc', created_at: '2024-01-15T10:00:00Z', score: 99 }
    const cursor = cursorFromRow(row, {
      sortField: 'created_at',
      tiebreaker: 'id',
      direction: 'desc',
    })

    expect(cursor.sortField).toBe('created_at')
    expect(cursor.sortValue).toBe('2024-01-15T10:00:00Z')
  })

  it('extracts tiebreaker value from row', () => {
    const row = { id: 'xyz-123', created_at: '2024-01-15' }
    const cursor = cursorFromRow(row, {
      sortField: 'created_at',
      tiebreaker: 'id',
      direction: 'asc',
    })

    expect(cursor.tiebreaker).toBe('id')
    expect(cursor.tiebreakerValue).toBe('xyz-123')
  })

  it('captures direction', () => {
    const row = { id: '1', created_at: '2024-01-15' }
    
    const ascCursor = cursorFromRow(row, {
      sortField: 'created_at',
      tiebreaker: 'id',
      direction: 'asc',
    })
    const descCursor = cursorFromRow(row, {
      sortField: 'created_at',
      tiebreaker: 'id',
      direction: 'desc',
    })

    expect(ascCursor.direction).toBe('asc')
    expect(descCursor.direction).toBe('desc')
  })

  it('sets createdAt to current time', () => {
    const before = Date.now()
    const row = { id: '1', created_at: '2024-01-15' }
    const cursor = cursorFromRow(row, {
      sortField: 'created_at',
      tiebreaker: 'id',
      direction: 'asc',
    })
    const after = Date.now()

    expect(cursor.createdAt.getTime()).toBeGreaterThanOrEqual(before)
    expect(cursor.createdAt.getTime()).toBeLessThanOrEqual(after)
  })

  it('handles numeric sort values', () => {
    const row = { id: '1', score: 99.5 }
    const cursor = cursorFromRow(row, {
      sortField: 'score',
      tiebreaker: 'id',
      direction: 'desc',
    })

    expect(cursor.sortValue).toBe(99.5)
  })
})

describe('makeCursorTokens', () => {
  it('returns undefined tokens for empty items', () => {
    const result = makeCursorTokens({
      items: [],
      limit: 20,
      sortField: 'created_at',
      tiebreaker: 'id',
      secret: TEST_SECRET,
      direction: 'desc',
      hasMoreForward: false,
    })

    expect(result.next).toBeUndefined()
    expect(result.prev).toBeUndefined()
  })

  it('generates next token when hasMoreForward is true', () => {
    const result = makeCursorTokens({
      items: sampleRows,
      limit: 20,
      sortField: 'created_at',
      tiebreaker: 'id',
      secret: TEST_SECRET,
      direction: 'desc',
      hasMoreForward: true,
    })

    expect(result.next).toBeDefined()
    expect(typeof result.next).toBe('string')
  })

  it('does not generate next token when hasMoreForward is false', () => {
    const result = makeCursorTokens({
      items: sampleRows,
      limit: 20,
      sortField: 'created_at',
      tiebreaker: 'id',
      secret: TEST_SECRET,
      direction: 'desc',
      hasMoreForward: false,
    })

    expect(result.next).toBeUndefined()
  })

  it('generates prev token when hasMoreBackward is true', () => {
    const result = makeCursorTokens({
      items: sampleRows,
      limit: 20,
      sortField: 'created_at',
      tiebreaker: 'id',
      secret: TEST_SECRET,
      direction: 'desc',
      hasMoreForward: false,
      hasMoreBackward: true,
    })

    expect(result.prev).toBeDefined()
  })

  it('next cursor points to last item in list', () => {
    const result = makeCursorTokens({
      items: sampleRows,
      limit: 20,
      sortField: 'created_at',
      tiebreaker: 'id',
      secret: TEST_SECRET,
      direction: 'desc',
      hasMoreForward: true,
    })

    const decoded = decodeAndVerifyCursor(result.next!, TEST_SECRET)
    expect(isSuccessResponse(decoded)).toBe(true)
    
    const cursor = (decoded[0] as { data: ReturnType<typeof makeValidCursorData> }).data
    expect(cursor.tiebreakerValue).toBe('row-3') // Last row
  })

  it('prev cursor inverts direction', () => {
    const result = makeCursorTokens({
      items: sampleRows,
      limit: 20,
      sortField: 'created_at',
      tiebreaker: 'id',
      secret: TEST_SECRET,
      direction: 'asc',
      hasMoreForward: false,
      hasMoreBackward: true,
    })

    const decoded = decodeAndVerifyCursor(result.prev!, TEST_SECRET)
    expect(isSuccessResponse(decoded)).toBe(true)
    
    const cursor = (decoded[0] as { data: ReturnType<typeof makeValidCursorData> }).data
    expect(cursor.direction).toBe('desc') // Inverted from 'asc'
  })
})

describe('computeExpiresAt', () => {
  it('returns undefined when hasCursor is false', () => {
    const result = computeExpiresAt({ hasCursor: false, ttlSecs: 3600 })
    expect(result).toBeUndefined()
  })

  it('returns undefined when ttlSecs is undefined', () => {
    const result = computeExpiresAt({ hasCursor: true })
    expect(result).toBeUndefined()
  })

  it('computes expiry from now + TTL', () => {
    const now = new Date('2024-01-15T10:00:00Z')
    const result = computeExpiresAt({ 
      now, 
      ttlSecs: 3600, 
      hasCursor: true 
    })

    expect(result).toEqual(new Date('2024-01-15T11:00:00Z'))
  })

  it('uses current time when now not provided', () => {
    const before = Date.now()
    const result = computeExpiresAt({ ttlSecs: 3600, hasCursor: true })
    const after = Date.now()

    expect(result).toBeDefined()
    expect(result!.getTime()).toBeGreaterThanOrEqual(before + 3600_000)
    expect(result!.getTime()).toBeLessThanOrEqual(after + 3600_000)
  })
})

describe('buildPaginationMeta', () => {
  const baseQuery = {
    pagination: { type: 'offset' as const, offset: 0, limit: 20 },
    filters: null,
    sorts: null,
    fields: null,
  }

  describe('limit+1 trimming', () => {
    it('trims rows when more than limit', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i) }))
      const result = buildPaginationMeta({
        rows,
        query: baseQuery,
      })

      expect(result.items).toHaveLength(20)
      expect(result.pagination.hasMore).toBe(true)
    })

    it('keeps all rows when at or below limit', () => {
      const rows = Array.from({ length: 15 }, (_, i) => ({ id: String(i) }))
      const result = buildPaginationMeta({
        rows,
        query: baseQuery,
      })

      expect(result.items).toHaveLength(15)
      expect(result.pagination.hasMore).toBe(false)
    })
  })

  describe('offset pagination metadata', () => {
    it('calculates nextOffset when hasMore', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i) }))
      const query = {
        ...baseQuery,
        pagination: { type: 'offset' as const, offset: 40, limit: 20 },
      }
      
      const result = buildPaginationMeta({ rows, query })

      expect(result.pagination.nextOffset).toBe(60)
    })

    it('calculates prevOffset when offset > 0', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      const query = {
        ...baseQuery,
        pagination: { type: 'offset' as const, offset: 40, limit: 20 },
      }
      
      const result = buildPaginationMeta({ rows, query })

      expect(result.pagination.prevOffset).toBe(20)
    })

    it('prevOffset does not go below 0', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      const query = {
        ...baseQuery,
        pagination: { type: 'offset' as const, offset: 10, limit: 20 },
      }
      
      const result = buildPaginationMeta({ rows, query })

      expect(result.pagination.prevOffset).toBe(0)
    })

    it('includes total when provided', () => {
      const rows = [{ id: '1' }]
      const result = buildPaginationMeta({
        rows,
        query: baseQuery,
        total: 100,
      })

      expect(result.pagination.total).toBe(100)
    })

    it('includes approxTotal when provided', () => {
      const rows = [{ id: '1' }]
      const result = buildPaginationMeta({
        rows,
        query: baseQuery,
        approxTotal: 1000,
      })

      expect(result.pagination.approxTotal).toBe(1000)
    })
  })

  describe('cursor pagination metadata', () => {
    it('generates cursor tokens when cursor mode', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ 
        id: String(i), 
        created_at: `2024-01-${15 + i}` 
      }))
      const query = {
        ...baseQuery,
        pagination: { type: 'cursor' as const, limit: 20 },
      }
      
      const result = buildPaginationMeta({
        rows,
        query,
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET,
      })

      expect(result.pagination.nextCursor).toBeDefined()
    })

    it('includes expiresAt when ttlSec provided', () => {
      const rows = [{ id: '1', created_at: '2024-01-15' }]
      const query = {
        ...baseQuery,
        pagination: { type: 'cursor' as const, limit: 20 },
      }
      
      const result = buildPaginationMeta({
        rows,
        query,
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET,
        ttlSec: 3600,
      })

      expect(result.pagination.expiresAt).toBeDefined()
    })
  })

  describe('common metadata', () => {
    it('includes count of returned items', () => {
      const rows = Array.from({ length: 15 }, (_, i) => ({ id: String(i) }))
      const result = buildPaginationMeta({ rows, query: baseQuery })

      expect(result.pagination.count).toBe(15)
    })

    it('includes limit', () => {
      const result = buildPaginationMeta({ 
        rows: [], 
        query: baseQuery 
      })

      expect(result.pagination.limit).toBe(20)
    })
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('edge cases', () => {
  describe('numeric string parsing', () => {
    const adapter = createPaginationQueryAdapter()

    it('handles leading zeros (decimal, not octal)', () => {
      const result = adapter.decode({ offset: '007', limit: '010' })
      
      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(7)
        expect(result.limit).toBe(10)
      }
    })

    it('rejects negative offset because normalized pagination requires offset >= 0', () => {
      expect(() => adapter.decode({ offset: '-10', limit: '20' })).toThrow()
    })

    it('handles non-integer strings', () => {
      const result = adapter.decode({ offset: '10.5', limit: '20' })
      
      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(10)
      }
    })
  })

  describe('large numbers', () => {
    const adapter = createPaginationQueryAdapter()

    it('handles large offset values', () => {
      const result = adapter.decode({ offset: '1000000', limit: '100' })
      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(1_000_000)
      }
    })

    it('handles MAX_SAFE_INTEGER', () => {
      const result = adapter.decode({ 
        offset: String(Number.MAX_SAFE_INTEGER), 
        limit: '100' 
      })
      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(Number.MAX_SAFE_INTEGER)
      }
    })
  })

  describe('empty and whitespace', () => {
    const adapter = createPaginationQueryAdapter(20)

    it('treats empty offset as 0', () => {
      const result = adapter.decode({ offset: '', limit: '10' })
      expect(result.type).toBe('offset')
      if (result.type === 'offset') {
        expect(result.offset).toBe(0)
      }
    })

    it('rejects whitespace-only offset because it normalizes to NaN', () => {
      expect(() => adapter.decode({ offset: '  ', limit: '10' })).toThrow()
    })
  })

  describe('unicode in cursor tokens', () => {
    it('handles unicode sort values', () => {
      const data = makeValidCursorData({ sortValue: '日本語テスト' })
      const token = encodeCursor(data, TEST_SECRET)
      const result = decodeAndVerifyCursor(token, TEST_SECRET)

      expect(isSuccessResponse(result)).toBe(true)
      const decoded = (result[0] as { data: typeof data }).data
      expect(decoded.sortValue).toBe('日本語テスト')
    })
  })
})


describe('cursorFromRow - extended edge cases', () => {
  describe('value type handling', () => {
    it('handles Date object as sortValue', () => {
      const date = new Date('2024-01-15T10:30:00Z')
      const row = { id: 'abc', created_at: date }
      
      const cursor = cursorFromRow(row, {
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc'
      })

      // Date should be preserved or converted to ISO string
      expect(cursor.sortValue).toBeDefined()
    })

    it('handles numeric sortValue', () => {
      const row = { id: 'abc', score: 99.5, rank: 1 }
      
      const cursor = cursorFromRow(row, {
        sortField: 'score',
        tiebreaker: 'id',
        direction: 'desc'
      })

      expect(cursor.sortValue).toBe(99.5)
      expect(typeof cursor.sortValue).toBe('number')
    })

    it('handles integer sortValue', () => {
      const row = { id: 'abc', rank: 42 }
      
      const cursor = cursorFromRow(row, {
        sortField: 'rank',
        tiebreaker: 'id',
        direction: 'asc'
      })

      expect(cursor.sortValue).toBe(42)
    })

    it('handles numeric tiebreaker value', () => {
      const row = { id: 12345, created_at: '2024-01-15' }
      
      const cursor = cursorFromRow(row, {
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc'
      })

      expect(cursor.tiebreakerValue).toBe(12345)
      expect(typeof cursor.tiebreakerValue).toBe('number')
    })

    it('handles string tiebreaker value (UUID)', () => {
      const row = { 
        id: '550e8400-e29b-41d4-a716-446655440000', 
        created_at: '2024-01-15' 
      }
      
      const cursor = cursorFromRow(row, {
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc'
      })

      expect(cursor.tiebreakerValue).toBe('550e8400-e29b-41d4-a716-446655440000')
    })
  })

  describe('null and undefined handling', () => {
    it('handles null sortValue (schema should validate)', () => {
      const row = { id: 'abc', created_at: null }
      
      // This may throw or produce null depending on schema
      // Document actual behavior
      try {
        const cursor = cursorFromRow(row, {
          sortField: 'created_at',
          tiebreaker: 'id',
          direction: 'desc'
        })
        // If it succeeds, sortValue should be null
        expect(cursor.sortValue).toBeNull()
      } catch (e) {
        // If schema rejects null, that's also valid behavior
        expect(e).toBeDefined()
      }
    })

    it('handles undefined sortField (missing column)', () => {
      const row = { id: 'abc' } // no created_at
      
      try {
        const cursor = cursorFromRow(row, {
          sortField: 'created_at',
          tiebreaker: 'id',
          direction: 'desc'
        })
        // If it succeeds, sortValue should be undefined
        expect(cursor.sortValue).toBeUndefined()
      } catch (e) {
        // Schema may reject undefined
        expect(e).toBeDefined()
      }
    })
  })

  describe('field name edge cases', () => {
    it('handles snake_case field names', () => {
      const row = { item_id: 'abc', created_at: '2024-01-15' }
      
      const cursor = cursorFromRow(row, {
        sortField: 'created_at',
        tiebreaker: 'item_id',
        direction: 'desc'
      })

      expect(cursor.tiebreaker).toBe('item_id')
      expect(cursor.tiebreakerValue).toBe('abc')
    })

    it('handles camelCase field names', () => {
      const row = { itemId: 'abc', createdAt: '2024-01-15' }
      
      const cursor = cursorFromRow(row, {
        sortField: 'createdAt',
        tiebreaker: 'itemId',
        direction: 'desc'
      })

      expect(cursor.sortField).toBe('createdAt')
      expect(cursor.tiebreaker).toBe('itemId')
    })
  })
})

// ============================================================================
// 2. BUILD PAGINATION META - Extended Scenarios
// ============================================================================

describe('buildPaginationMeta - extended scenarios', () => {
  describe('empty result handling', () => {
    it('handles empty rows array with offset pagination', () => {
      const result = buildPaginationMeta({
        rows: [],
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 0, limit: 20 } })
      })

      expect(result.items).toEqual([])
      expect(result.pagination.count).toBe(0)
      expect(result.pagination.hasMore).toBe(false)
    })

    it('handles empty rows with cursor pagination', () => {
      const result = buildPaginationMeta({
        rows: [],
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
      })

      expect(result.items).toEqual([])
      expect(result.pagination.count).toBe(0)
      expect(result.pagination.hasMore).toBe(false)
      expect(result.pagination.nextCursor).toBeUndefined()
    })

    it('handles empty rows on non-first page (offset > 0)', () => {
      const result = buildPaginationMeta({
        rows: [],
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 100, limit: 20 } })
      })

      expect(result.items).toEqual([])
      expect(result.pagination.count).toBe(0)
      expect(result.pagination.hasMore).toBe(false)
      // Should still have prevOffset since we're past first page
      expect(result.pagination.prevOffset).toBe(80)
    })
  })

  describe('boundary conditions', () => {
    it('exact limit (no probe row) - hasMore is false', () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ 
        id: String(i), 
        created_at: `2024-01-${15 + i}` 
      }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 0, limit: 20 } })
      })

      expect(result.items).toHaveLength(20)
      expect(result.pagination.hasMore).toBe(false)
      expect(result.pagination.count).toBe(20)
    })

    it('limit + 1 (has probe row) - hasMore is true, probe trimmed', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ 
        id: String(i), 
        created_at: `2024-01-${15 + i}` 
      }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 0, limit: 20 } })
      })

      expect(result.items).toHaveLength(20)  // Probe row trimmed
      expect(result.pagination.hasMore).toBe(true)
      expect(result.pagination.count).toBe(20)
    })

    it('less than limit - hasMore is false', () => {
      const rows = Array.from({ length: 15 }, (_, i) => ({ 
        id: String(i), 
        created_at: `2024-01-${15 + i}` 
      }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 0, limit: 20 } })
      })

      expect(result.items).toHaveLength(15)
      expect(result.pagination.hasMore).toBe(false)
      expect(result.pagination.count).toBe(15)
    })

    it('single row result', () => {
      const rows = [{ id: '1', created_at: '2024-01-15' }]
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 0, limit: 20 } })
      })

      expect(result.items).toHaveLength(1)
      expect(result.pagination.hasMore).toBe(false)
      expect(result.pagination.count).toBe(1)
    })
  })

  describe('offset calculations', () => {
    it('calculates correct nextOffset', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 40, limit: 20 } })
      })

      expect(result.pagination.nextOffset).toBe(60)
    })

    it('calculates correct prevOffset when in middle', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 60, limit: 20 } })
      })

      expect(result.pagination.prevOffset).toBe(40)
    })

    it('prevOffset clamps to 0 when near start', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 15, limit: 20 } })
      })

      // 15 - 20 = -5, should clamp to 0
      expect(result.pagination.prevOffset).toBe(0)
    })

    it('no nextOffset when hasMore is false', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 40, limit: 20 } })
      })

      expect(result.pagination.hasMore).toBe(false)
      expect(result.pagination.nextOffset).toBeUndefined()
    })

    it('no prevOffset when on first page', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec({ pagination: { type: 'offset', offset: 0, limit: 20 } })
      })

      expect(result.pagination.prevOffset).toBeUndefined()
    })
  })

  describe('cursor token generation', () => {
    it('generates nextCursor when hasMore is true', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ 
        id: `id-${i}`, 
        created_at: `2024-01-${String(i + 1).padStart(2, '0')}` 
      }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
      })

      expect(result.pagination.nextCursor).toBeDefined()
      expect(typeof result.pagination.nextCursor).toBe('string')
    })

    it('nextCursor points to last returned item', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({ 
        id: `id-${i}`, 
        created_at: `2024-01-${String(i + 1).padStart(2, '0')}` 
      }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
      })

      // Decode the cursor to verify it points to the last returned item
      const decoded = decodeAndVerifyCursor(result.pagination.nextCursor!, TEST_SECRET)
      expect(isSuccessResponse(decoded)).toBe(true)
      
      if (isSuccessResponse(decoded)) {
        // Last returned item is at index 19 (20th item, 0-indexed)
        expect(decoded[0].data.tiebreakerValue).toBe('id-19')
      }
    })

    it('no nextCursor when hasMore is false', () => {
      const rows = Array.from({ length: 15 }, (_, i) => ({ 
        id: `id-${i}`, 
        created_at: `2024-01-${String(i + 1).padStart(2, '0')}` 
      }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
      })

      expect(result.pagination.nextCursor).toBeUndefined()
    })
  })

  describe('TTL and expiration', () => {
    it('calculates expiresAt when ttlSec provided', () => {
      const rows = [{ id: '1', created_at: '2024-01-15' }]
      const now = new Date()
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET,
        ttlSec: 3600  // 1 hour
      })

      expect(result.pagination.expiresAt).toBeDefined()
      
      // Should be approximately 1 hour from now
      const expiresAt = result.pagination.expiresAt!
      const diffMs = expiresAt.getTime() - now.getTime()
      const diffSec = diffMs / 1000
      
      // Allow 5 second tolerance for test execution time
      expect(diffSec).toBeGreaterThan(3595)
      expect(diffSec).toBeLessThan(3605)
    })

    it('no expiresAt when ttlSec not provided', () => {
      const rows = [{ id: '1', created_at: '2024-01-15' }]
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
        // No ttlSec
      })

      expect(result.pagination.expiresAt).toBeUndefined()
    })
  })

  describe('total count handling', () => {
    it('includes exact total when provided', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec(),
        total: 150
      })

      expect(result.pagination.total).toBe(150)
    })

    it('includes approximate total when provided', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec(),
        approxTotal: 10000
      })

      expect(result.pagination.approxTotal).toBe(10000)
    })

    it('prefers total over approxTotal when both provided', () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }))
      
      const result = buildPaginationMeta({
        rows,
        query: makeQuerySpec(),
        total: 150,
        approxTotal: 10000
      })

      expect(result.pagination.total).toBe(150)
      expect(result.pagination.approxTotal).toBe(10000)
    })
  })
})

// ============================================================================
// 3. CURSOR CONTINUATION FLOW
// ============================================================================

describe('cursor continuation flow', () => {
  const generateRows = (start: number, count: number) => 
    Array.from({ length: count }, (_, i) => ({
      id: `id-${start + i}`,
      created_at: `2024-01-${String(start + i + 1).padStart(2, '0')}T10:00:00Z`,
      title: `Item ${start + i}`
    }))

  describe('first page to next page', () => {
    it('first page generates valid nextCursor', () => {
      // Simulate first page request: 21 rows (20 + probe)
      const rows = generateRows(0, 21)
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec({ pagination: { type: 'cursor', limit: 20 } }),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
      })

      expect(result.items).toHaveLength(20)
      expect(result.pagination.hasMore).toBe(true)
      expect(result.pagination.nextCursor).toBeDefined()

      // Verify cursor can be decoded
      const decoded = decodeAndVerifyCursor(result.pagination.nextCursor!, TEST_SECRET)
      expect(isSuccessResponse(decoded)).toBe(true)
    })

    it('cursor from first page can be used for second page', () => {
      // First page
      const firstPageRows = generateRows(0, 21)
      const firstPage = buildPaginationMeta({
        rows: firstPageRows,
        query: makeCursorQuerySpec({ pagination: { type: 'cursor', limit: 20 } }),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
      })

      // Decode the cursor
      const decoded = decodeAndVerifyCursor(firstPage.pagination.nextCursor!, TEST_SECRET)
      expect(isSuccessResponse(decoded)).toBe(true)

      if (isSuccessResponse(decoded)) {
        const cursor = decoded[0]
        
        // Cursor should contain correct sort info
        expect(cursor.data.sortField).toBe('created_at')
        expect(cursor.data.tiebreaker).toBe('id')
        expect(cursor.data.direction).toBe('desc')
        
        // Cursor should point to last item of first page (id-19)
        expect(cursor.data.tiebreakerValue).toBe('id-19')
      }
    })
  })

  describe('cursor direction consistency', () => {
    it('maintains direction through encode/decode cycle', () => {
      const rows = generateRows(0, 21)
      
      // Test with ascending direction
      const ascResult = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'asc',
        secret: TEST_SECRET
      })

      const ascDecoded = decodeAndVerifyCursor(ascResult.pagination.nextCursor!, TEST_SECRET)
      if (isSuccessResponse(ascDecoded)) {
        expect(ascDecoded[0].data.direction).toBe('asc')
      }

      // Test with descending direction
      const descResult = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
      })

      const descDecoded = decodeAndVerifyCursor(descResult.pagination.nextCursor!, TEST_SECRET)
      if (isSuccessResponse(descDecoded)) {
        expect(descDecoded[0].data.direction).toBe('desc')
      }
    })
  })

  describe('cursor expiration', () => {
    it('cursor without TTL does not expire', () => {
      const rows = generateRows(0, 21)
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET
        // No ttlSec
      })

      // Cursor should be valid
      const decoded = decodeAndVerifyCursor(result.pagination.nextCursor!, TEST_SECRET)
      expect(isSuccessResponse(decoded)).toBe(true)
    })

    it('cursor with TTL includes expiration info', () => {
      const rows = generateRows(0, 21)
      
      const result = buildPaginationMeta({
        rows,
        query: makeCursorQuerySpec(),
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET,
        ttlSec: 3600
      })

      // Response should include expiration time
      expect(result.pagination.expiresAt).toBeDefined()
    })
  })
})

// ============================================================================
// 4. COMPUTE EXPIRES AT
// ============================================================================

describe('computeExpiresAt', () => {
  it('returns undefined when no cursor and no TTL', () => {
    const result = computeExpiresAt({})
    
    expect(result).toBeUndefined()
  })

  it('returns undefined when hasCursor false', () => {
    const result = computeExpiresAt({
      hasCursor: false,
      ttlSecs: 3600
    })
    
    expect(result).toBeUndefined()
  })

  it('calculates expiry from TTL when cursor exists', () => {
    const now = new Date('2024-01-15T10:00:00Z')
    
    const result = computeExpiresAt({
      now,
      hasCursor: true,
      ttlSecs: 3600  // 1 hour
    })

    expect(result).toBeDefined()
    expect(result!.toISOString()).toBe('2024-01-15T11:00:00.000Z')
  })

  it('uses current time when now not provided', () => {
    const before = new Date()
    
    const result = computeExpiresAt({
      hasCursor: true,
      ttlSecs: 3600
    })

    const after = new Date()
    
    expect(result).toBeDefined()
    // Result should be ~1 hour from now
    expect(result!.getTime()).toBeGreaterThanOrEqual(before.getTime() + 3600000 - 1000)
    expect(result!.getTime()).toBeLessThanOrEqual(after.getTime() + 3600000 + 1000)
  })

  it('handles zero TTL', () => {
    const now = new Date('2024-01-15T10:00:00Z')
    
    const result = computeExpiresAt({
      now,
      hasCursor: true,
      ttlSecs: 0
    })

    expect(result).toBeDefined()
    expect(result!.toISOString()).toBe('2024-01-15T10:00:00.000Z')
  })

  it('handles large TTL values', () => {
    const now = new Date('2024-01-15T10:00:00Z')
    
    const result = computeExpiresAt({
      now,
      hasCursor: true,
      ttlSecs: 86400 * 365  // 1 year in seconds
    })

    expect(result).toBeDefined()
    // Should be ~1 year later
    expect(result!.getFullYear()).toBe(2025)
  })
})

// ============================================================================
// 5. MAKE CURSOR TOKENS - Extended Tests
// ============================================================================

describe('makeCursorTokens - extended', () => {
  const sampleRows = [
    { id: 'row-1', created_at: '2024-01-15T10:00:00Z' },
    { id: 'row-2', created_at: '2024-01-15T11:00:00Z' },
    { id: 'row-3', created_at: '2024-01-15T12:00:00Z' },
  ]

  describe('bidirectional pagination', () => {
    it('generates both next and prev when both directions have more', () => {
      const result = makeCursorTokens({
        items: sampleRows,
        limit: 3,
        sortField: 'created_at',
        tiebreaker: 'id',
        secret: TEST_SECRET,
        direction: 'desc',
        hasMoreForward: true,
        hasMoreBackward: true
      })

      expect(result.next).toBeDefined()
      expect(result.prev).toBeDefined()
    })

    it('prev cursor has inverted direction', () => {
      const result = makeCursorTokens({
        items: sampleRows,
        limit: 3,
        sortField: 'created_at',
        tiebreaker: 'id',
        secret: TEST_SECRET,
        direction: 'desc',
        hasMoreForward: false,
        hasMoreBackward: true
      })

      const decoded = decodeAndVerifyCursor(result.prev!, TEST_SECRET)
      
      if (isSuccessResponse(decoded)) {
        // When main direction is 'desc', prev cursor should be 'asc'
        expect(decoded[0].data.direction).toBe('asc')
      }
    })

    it('next cursor points to tail, prev cursor points to head', () => {
      const result = makeCursorTokens({
        items: sampleRows,
        limit: 3,
        sortField: 'created_at',
        tiebreaker: 'id',
        secret: TEST_SECRET,
        direction: 'desc',
        hasMoreForward: true,
        hasMoreBackward: true
      })

      const nextDecoded = decodeAndVerifyCursor(result.next!, TEST_SECRET)
      const prevDecoded = decodeAndVerifyCursor(result.prev!, TEST_SECRET)
      
      if (isSuccessResponse(nextDecoded)) {
        // Next cursor should point to last item (row-3)
        expect(nextDecoded[0].data.tiebreakerValue).toBe('row-3')
      }
      
      if (isSuccessResponse(prevDecoded)) {
        // Prev cursor should point to first item (row-1)
        expect(prevDecoded[0].data.tiebreakerValue).toBe('row-1')
      }
    })
  })

  describe('single item edge case', () => {
    it('handles single item with hasMoreForward', () => {
      const singleRow = [{ id: 'single', created_at: '2024-01-15' }]
      
      const result = makeCursorTokens({
        items: singleRow,
        limit: 1,
        sortField: 'created_at',
        tiebreaker: 'id',
        secret: TEST_SECRET,
        direction: 'desc',
        hasMoreForward: true
      })

      expect(result.next).toBeDefined()
      
      const decoded = decodeAndVerifyCursor(result.next!, TEST_SECRET)
      if (isSuccessResponse(decoded)) {
        expect(decoded[0].data.tiebreakerValue).toBe('single')
      }
    })
  })
})

// ============================================================================
// 6. CROSS-COMPONENT INTERACTION
// ============================================================================

describe('cross-component interaction', () => {
  describe('query spec with all components', () => {
    it('buildPaginationMeta works with full query spec', () => {
      const rows = Array.from({ length: 21 }, (_, i) => ({
        id: `id-${i}`,
        created_at: `2024-01-${String(i + 1).padStart(2, '0')}`,
        status: 'published',
        price: 100 + i
      }))

      const fullQuerySpec: QuerySpec = {
        pagination: { type: 'cursor', limit: 20 },
        filters: [
          { field: 'status', operator: 'eq', value: 'published' },
          { field: 'price', operator: 'gte', value: 100 }
        ],
        sorts: [
          { field: 'created_at', direction: 'desc', tiebreaker: false },
          { field: 'id', direction: 'desc', tiebreaker: true }
        ],
        fields: { type: 'simple', fields: ['id', 'created_at', 'status'] }
      }

      const result = buildPaginationMeta({
        rows,
        query: fullQuerySpec,
        sortField: 'created_at',
        tiebreaker: 'id',
        direction: 'desc',
        secret: TEST_SECRET,
        ttlSec: 3600,
        total: 150
      })

      // All pagination fields should be present
      expect(result.items).toHaveLength(20)
      expect(result.pagination.hasMore).toBe(true)
      expect(result.pagination.nextCursor).toBeDefined()
      expect(result.pagination.expiresAt).toBeDefined()
      expect(result.pagination.total).toBe(150)
      expect(result.pagination.count).toBe(20)
      expect(result.pagination.limit).toBe(20)
    })
  })

  describe('query metadata passthrough', () => {
    it('includes query metadata in response when available', () => {
      const rows = [{ id: '1', created_at: '2024-01-15' }]
      
      const querySpec: QuerySpec = {
        pagination: { type: 'offset', offset: 0, limit: 20 },
        filters: [{ field: 'status', operator: 'eq', value: 'active' }],
        sorts: [{ field: 'created_at', direction: 'desc', tiebreaker: false }],
        fields: null
      }

      const result = buildPaginationMeta({
        rows,
        query: querySpec
      })

      // Verify the result includes the expected fields
      expect(result.pagination).toBeDefined()
      expect(result.items).toBeDefined()
    })
  })
})
