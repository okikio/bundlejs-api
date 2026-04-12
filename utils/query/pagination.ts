// utils/query/pagination.ts
/**
 * Cursor-based and offset-based pagination with multi-source support
 * 
 * Features:
 * - Auto-detects cursor vs offset from any source
 * - HMAC-signed cursors with expiration
 * - Configurable limits per endpoint
 * - 410 Gone for expired cursors
 * - Query/JSON/FormData source adapters
 */

import type {
  CursorData,
  CursorPaginationNormalized,
  OffsetPaginationNormalized,
  PaginationConfig,
  PaginationNormalized,
  QueryPaginationMetadata,
  QuerySpec,
  SortDirection,
} from './schemas.ts'
import type { Pagination } from '@utils/response'

import { z } from 'zod'
import { decodeBase64Url, encodeBase64Url } from '@std/encoding/base64url'
import { createHmac } from "node:crypto"

import { BaseQuerySchema, BaseJsonSchema, BaseFormSchema, ZStringOrStringArray } from '@utils/endpoint/schemas'
import {
  PaginationNormalizedSchema,
  CursorDataSchema,
} from './schemas.ts'
import { badRequest, ok, gone } from '@utils/response'
import { isSuccessResponse } from '@utils/response/success'

/**
 * One decoded cursor payload handled by this module.
 *
 * Runtime validation still flows through `CursorDataSchema.parse(...)`. This
 * interface only describes the validated shape accepted and returned by the
 * public helpers below.
 */
export interface CursorPayload extends CursorData {
  /** Primary sort field captured at the page boundary. */
  sortField: string

  /** Sort-field value captured at the page boundary. */
  sortValue: string | number | Date

  /** Stable tiebreaker field captured with the primary sort. */
  tiebreaker: string

  /** Tiebreaker value captured at the page boundary. */
  tiebreakerValue: string | number

  /** Traversal direction encoded into the cursor. */
  direction: 'asc' | 'desc'

  /** Cursor mint timestamp used for TTL checks. */
  createdAt: Date
}

// ============================================================================
// CURSOR ENCODING/DECODING
// ============================================================================

const EncodedCursorSchema = z.object({
  data: CursorDataSchema,
  signature: z.hex(),
}).strict()

/**
 * @based on `@mofax/sorted-stringify` https://jsr.io/@mofax/sorted-stringify/0.0.4/index.ts
 * Recursively sorts the keys of an object or elements of an array.
 *
 * - If the input is not an object or array, the value is returned as is.
 * - If the input is an array, it recursively sorts each element in the array.
 * - If the input is an object, it sorts the object by its keys and recursively sorts the values.
 *
 * @param obj - The input object, array, or any other value to be sorted.
 * @returns The sorted object, array, or the original value if it's not an object or array.
 *
 * @example Common path
 * ```ts
 * sortObject({ z: 1, a: { c: 3, b: 2 } })
 * // { a: { b: 2, c: 3 }, z: 1 }
 * ```
 *
 * @example Date payloads
 * ```ts
 * sortObject({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
 * // { createdAt: '2026-01-01T00:00:00.000Z' }
 * ```
 */
export function sortObject<T>(obj: T): T {
  if (obj instanceof Date) return obj.toISOString() as T; // normalize precision
  if (obj == null || typeof obj !== "object") return obj;
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return obj as T;
  if (Array.isArray(obj)) return obj.map(sortObject) as T;

  return Object.entries(obj)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .reduce((sortedObj: Record<string, unknown>, [key, value]) => {
      sortedObj[key] = sortObject(value);
      return sortedObj;
    }, {}) as T;
}

/**
 * 
 * Encode and decode the transport-safe cursor token envelope.
 *
 * The wire format is a base64url JSON payload containing both the normalized
 * cursor data and the detached HMAC signature used to prevent tampering.
 * 
 * Codec: string (base64url string)  <->  { data, signature }
 * - decode(): wire -> structured
 * - encode(): structured -> wire
 */
export const Base64UrlJsonCursorCodec = z.codec(
  z.string(),                // wire type (Input)
  EncodedCursorSchema,       // domain type (Output)
  {
    decode: (token) => {
      // base64url decode
      const bytes = decodeBase64Url(token);
      const json = new TextDecoder().decode(bytes);
      return JSON.parse(json);
    },
    encode: (obj) => {
      const json = JSON.stringify(obj);
      const bytes = new TextEncoder().encode(json);
      return encodeBase64Url(bytes);
    },
  }
);

/**
 * Web-standard HMAC-SHA256 signature, hex-encoded.
 */
export function hmacSha256Hex(secret: string, payload: unknown): string {
  // Important: canonicalize to avoid key-order signature drift.
  // If you don't have a stable stringify util, ensure 'data' is serialized consistently.
  // The order of the objects keys affects how the object is stringified
  const data = sortObject(payload);
  const json = JSON.stringify(data);
  return createHmac("sha256", secret)
    .update(json)
    .digest("hex");
}

/**
 * Decode + verify a cursor token. Return domain result or throw mapped HTTP errors.
 * - 400 if format/signature invalid
 * - 410 if expired
 */
export function decodeAndVerifyCursor(
  token: string,
  secret: string,
  ttlSeconds = 86_400, // 24h
) {
  if (!token) {
    return badRequest(token, "Invalid cursor token")
  }

  // 1) Decode token -> { data, signature }
  const { data: decoded, error } = Base64UrlJsonCursorCodec.safeDecode(token);
  if (error) {
    return badRequest(token, "Cannot decode cursor token")
  }

  const parsed = EncodedCursorSchema.safeParse(decoded);

  if (!parsed.success) {
    // Map Zod issues to your error envelope at the HTTP boundary:
    return badRequest(token, `Invalid cursor: ${parsed.error.issues?.[0]?.message}`)
  }

  const { data, signature } = parsed.data;

  // 2) Verify HMAC
  const expected = hmacSha256Hex(secret, data);
  if (signature !== expected) {
    return badRequest(token, "Cursor signature mismatch")
  }

  // 3) Verify TTL (use epoch seconds; avoid Date#getDate bug)
  const nowSec = Math.floor(Date.now() / 1000);
  const createdSec = Math.floor(data.createdAt.getTime() / 1000);
  const age = nowSec - createdSec;

  if (age > ttlSeconds) {
    return gone(String(age), `Cursor has expired (${age - ttlSeconds})`, {
      deltaSeconds: age - ttlSeconds,
    });
  }

  // 4) Success: return normalized CursorData
  return ok<CursorPayload>(data, 200);
}

/**
 * Create a new signed cursor token from CursorData.
 * Uses Base64UrlJsonCursorCodec.encode() - this is why it stays a codec
 */
export function encodeCursor(data: CursorPayload, secret: string): string {
  const envelope = {
    data,
    signature: hmacSha256Hex(secret, data),
  };

  return Base64UrlJsonCursorCodec.encode(envelope);
}

// ============================================================================
// WIRE SCHEMAS
// ============================================================================

/**
 * Raw query-string pagination inputs before normalization.
 *
 * This schema mirrors the three supported query styles: offset/limit,
 * page/per_page, and cursor/limit.
 */
export const PaginationQueryWire = BaseQuerySchema.extend({
  offset: ZStringOrStringArray.optional(),
  limit: ZStringOrStringArray.optional(),
  page: ZStringOrStringArray.optional(),
  per_page: ZStringOrStringArray.optional(),
  cursor: ZStringOrStringArray.optional()
})

/**
 * Raw pagination JSON before normalization.
 *
 * JSON callers can post the same pagination keys as query callers, but the
 * endpoint still decides how those values become normalized pagination state.
 */
export const PaginationJsonWire = BaseJsonSchema

/**
 * Raw pagination form-data before normalization.
 *
 * Form submissions use the same key names as query parameters, but values
 * arrive through the form-data adapter instead of the URL.
 */
export const PaginationFormWire = BaseFormSchema

/**
 * One supported transport source for pagination input.
 */
export type PaginationSource = 'query' | 'json' | 'form'

/**
 * Options for building an endpoint-specific pagination decoder.
 *
 * This keeps the transport source explicit and lets each endpoint choose its
 * own limit policy and optional cursor secret without re-implementing the
 * decode pipeline.
 */
export interface CreatePaginationSchemaOptions extends PaginationConfig {
  /** Limit policy enforced after decoding raw pagination input. */
  limits?: {
    /** Minimum accepted page size. */
    minLimit?: number

    /** Maximum accepted page size. */
    maxLimit?: number

    /** Fallback page size when the caller omits one. */
    defaultLimit?: number

    /** Maximum accepted offset for offset pagination. */
    maxOffset?: number

    /** Cursor time-to-live in seconds. */
    cursorTTL?: number
  }

  /** Optional secret used to verify signed cursor tokens. */
  cursorSecret?: string

  /** Which transport shape the decoder should accept. */
  source: PaginationSource
}

/**
 * Options for deriving cursor data from one returned row.
 *
 * These fields must match the sort plan used by the database query. Otherwise
 * the next cursor can point at the wrong boundary row.
 */
export interface CursorRowConfig {
  /** Primary sort field used by the listing query. */
  sortField: string

  /** Stable tiebreaker field used when multiple rows share the same sort value. */
  tiebreaker: string

  /** Direction used for the current page traversal. */
  direction: SortDirection
}

/**
 * Options for generating cursor tokens from one page of rows.
 */
export interface CursorTokenOptions<Row extends Record<string, unknown>> {
  /** Rows that will be returned to the caller after any limit+1 trimming. */
  items: Row[]

  /** Requested page size. Included for symmetry with the surrounding pagination flow. */
  limit: number

  /** Primary sort field used by the database query. */
  sortField: string

  /** Stable tiebreaker field used when sort values collide. */
  tiebreaker: string

  /** Secret used to sign generated cursor tokens. */
  secret: string

  /** Direction of the current keyset traversal. */
  direction: 'asc' | 'desc'

  /** Whether there are more rows after the last returned row. */
  hasMoreForward: boolean

  /** Whether there are rows before the first returned row. */
  hasMoreBackward?: boolean
}

/**
 * Options for computing a page expiry timestamp.
 */
export interface ComputeExpiresAtOptions {
  /** Override current time in tests or deterministic callers. */
  now?: Date

  /** Cursor or page time-to-live in seconds. */
  ttlSecs?: number

  /** Whether the current response minted cursor tokens. */
  hasCursor?: boolean
}

/**
 * Result returned by `buildPaginationMeta()`.
 *
 * The helper returns the trimmed page items plus the pagination metadata and
 * original query context that higher-level response helpers need.
 */
export type BuiltPaginationMeta<Row extends Record<string, unknown>> = QueryPaginationMetadata & {
  /** Rows that remain after limit+1 trimming. */
  items: Row[]

  /** Pagination metadata returned to the caller. */
  pagination: {
    /** Whether another page exists after this one. */
    hasMore: boolean

    /** Page size used for this response. */
    limit: number

    /** Number of rows returned in this page. */
    count: number

    /** Exact total count when one was requested. */
    total?: number

    /** Approximate total count when only an estimate is available. */
    approxTotal?: number

    /** Page-level expiry timestamp for cursor responses. */
    expiresAt?: Date

    /** Next cursor token when cursor pagination is active. */
    nextCursor?: string

    /** Previous cursor token when cursor pagination is active. */
    prevCursor?: string

    /** Current offset when offset pagination is active. */
    offset?: number

    /** Next offset when another offset page exists. */
    nextOffset?: number

    /** Previous offset when one exists. */
    prevOffset?: number
  }

  /** Normalized pagination subset echoed back to the caller. */
  query?: {
    pagination: {
      /** Pagination mode for the current response. */
      type: 'offset' | 'cursor'

      /** Page size used for the current response. */
      limit: number

      /** Current offset when offset pagination is active. */
      offset?: number
    }
  }
}

/**
 * Options for building normalized pagination metadata from database rows.
 */
export interface BuildPaginationMetaOptions<Row extends Record<string, unknown>> {
  /** Rows fetched from the database, usually with limit+1 semantics. */
  rows: Row[]

  /** Parsed pagination subset that drove the listing query. */
  query: QuerySpec

  /** Primary sort field used for cursor generation. Defaults to `id`. */
  sortField?: string

  /** Stable tiebreaker field used for cursor generation. Defaults to `id`. */
  tiebreaker?: string

  /** Cursor traversal direction. Defaults to `asc`. */
  direction?: 'asc' | 'desc'

  /** Secret used to sign cursor tokens. */
  secret?: string

  /** Optional TTL used to compute `expiresAt`. */
  ttlSec?: number

  /** Exact total count when the caller requested one. */
  total?: number

  /** Approximate total count when only an estimate is available. */
  approxTotal?: number
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Extract first value if array
const getString = (val: unknown): string | undefined => {
  if (Array.isArray(val)) return val[0]
  if (typeof val === 'string') return val
  return undefined
}

// Extract first value of a specific key if array of string
const pickForm = (raw: Record<string, unknown>, key: string): string | undefined => {
  const val = getString(raw[key])
  if (val) return String(val)
  return val
}

/**
 * Decodes raw query or form values into the normalized pagination shape.
 *
 * This is the common boundary shared by the query-string and form-data
 * adapters. It accepts three wire styles and normalizes all of them into the
 * same runtime contract:
 *
 * ```text
 * cursor input          ─► { type: 'cursor', ... }
 * page/per_page input   ─► { type: 'offset', offset, limit }
 * offset/limit input    ─► { type: 'offset', offset, limit }
 * ```
 */
function decodePagination(raw: Record<string, unknown>, defaultLimit: number): PaginationNormalized {
  const cursor = pickForm(raw, "cursor")
  const offset = pickForm(raw, "offset")
  const page = pickForm(raw, "page")
  const limit = pickForm(raw, "limit")
  const perPage = pickForm(raw, "per_page")

  // Cursor-based
  if (cursor !== undefined) {
    return {
      type: 'cursor',
      cursor: cursor || undefined,
      limit: parseInt(limit ?? String(defaultLimit), 10)
    } as CursorPaginationNormalized
  }

  // Page-based
  if (page !== undefined) {
    const pageNum = parseInt(page, 10)
    const limitNum = parseInt(perPage ?? limit ?? String(defaultLimit), 10)
    return {
      type: 'offset',
      offset: (pageNum - 1) * limitNum,
      limit: limitNum
    } as OffsetPaginationNormalized
  }

  // Offset-based
  return {
    type: 'offset',
    offset: offset ? parseInt(offset, 10) : 0,
    limit: parseInt(limit ?? String(defaultLimit), 10)
  } as OffsetPaginationNormalized
}

/**
 * Encodes normalized pagination back into a plain wire shape.
 *
 * This is mainly for round-trip tests of the adapters rather than production
 * response generation.
 */
function encodePagination(norm: PaginationNormalized): Record<string, string> {
  if (norm.type === "cursor") {
    const result: Record<string, string> = { limit: String(norm.limit) }
    if (norm.cursor) result.cursor = norm.cursor
    return result
  }
  
  return {
    offset: String(norm.offset),
    limit: String(norm.limit),
  }
}

// ============================================================================
// SOURCE ADAPTERS (bidirectional codecs for testing)
// ============================================================================

/**
 * Builds a query-parameter codec for pagination.
 *
 * Use this when pagination comes from a URL query string and you want a
 * bidirectional codec for decoding requests and round-trip testing.
 *
 * Supported wire shapes:
 * - `?offset=0&limit=20`
 * - `?page=1&per_page=20`
 * - `?cursor=abc&limit=20`
 *
 * @example Decode offset pagination
 * const adapter = createPaginationQueryAdapter()
 * const normalized = adapter.decode({ offset: '0', limit: '20' })
 * // => { type: 'offset', offset: 0, limit: 20 }
 *
 * @example Encode pagination for a round-trip test
 * const wire = adapter.encode(normalized)
 * // => { offset: '0', limit: '20' }
 */
export function createPaginationQueryAdapter(defaultLimit: number = 20) {
  return z.codec(
    PaginationQueryWire,
    PaginationNormalizedSchema,
    {
      decode: (raw): PaginationNormalized => {
        return decodePagination(raw, defaultLimit)
      },
      encode: (norm): z.input<typeof PaginationQueryWire> => {
        const normalized = PaginationNormalizedSchema.parse(norm)
        return encodePagination(normalized)
      },
    }
  )
}

/**
 * Builds a JSON-body codec for pagination.
 *
 * Use this when the transport wraps pagination inside a request body such as
 * `{ pagination: ... }`.
 *
 * @example Decode a JSON pagination envelope
 * const adapter = createPaginationJsonAdapter()
 * const normalized = adapter.decode({ 
 *   pagination: { type: 'offset', offset: 0, limit: 20 } 
 * })
 *
 * @example Encode a normalized pagination object back to JSON
 * const wire = adapter.encode({ type: 'offset', offset: 0, limit: 20 })
 * // => { pagination: { type: 'offset', offset: 0, limit: 20 } }
 */
export function createPaginationJsonAdapter(defaultLimit: number = 20) {
  const JsonEnvelope = z.object({
    pagination: PaginationNormalizedSchema.optional().default({
      type: 'offset',
      offset: 0,
      limit: defaultLimit
    })
  })

  return z.codec(
    PaginationJsonWire,
    PaginationNormalizedSchema,
    {
      decode: (raw): PaginationNormalized => {
        return JsonEnvelope.parse(raw).pagination
      },
      encode: (norm): z.input<typeof PaginationJsonWire> => {
        return { pagination: norm }
      },
    }
  )
}

/**
 * Builds a `FormData` codec for pagination.
 *
 * It accepts the same wire keys as the query adapter, but reads them from a
 * form-shaped object instead of a URL.
 *
 * @example Decode form pagination
 * const adapter = createPaginationFormAdapter()
 * const formData = new FormData()
 * formData.append('offset', '0')
 * formData.append('limit', '20')
 * const normalized = adapter.decode(formData)
 *
 * @example Encode normalized pagination for a form-style test
 * const wire = adapter.encode({ type: 'offset', offset: 0, limit: 20 })
 * // => { offset: '0', limit: '20' }
 */
export function createPaginationFormAdapter(defaultLimit: number = 20) {
  return z.codec(
    PaginationFormWire,
    PaginationNormalizedSchema,
    {
      decode: (raw): PaginationNormalized => {
        return decodePagination(raw, defaultLimit)
      },
      encode: (norm): z.input<typeof PaginationFormWire> => {
        const normalized = PaginationNormalizedSchema.parse(norm)
        return encodePagination(normalized)
      },
    }
  )
}

// ============================================================================
// SCHEMA COMPOSITION WITH VALIDATION
// ============================================================================

/**
 * Creates an endpoint-specific pagination decoder with validation.
 *
 * This is the high-level entrypoint most handlers should use. It chooses the
 * right transport adapter, validates limit policy, and optionally decodes a
 * signed cursor into `decodedCursor` for downstream query execution.
 *
 * Read the pipeline from left to right:
 *
 * ```text
 * raw input ─► source adapter ─► limit checks ─► optional cursor decode ─► normalized pagination
 * ```
 *
 * This schema is intentionally decode-only because cursor verification is not a
 * reversible transformation. Use the transport adapters directly when a test
 * needs round-trip encode/decode behavior.
 *
 * @example Minimal endpoint configuration
 * createPaginationSchema({ source: 'query' })
 *
 * @example Query pagination with custom limits and cursor verification
 * createPaginationSchema({
 *   source: 'query',
 *   limits: { maxLimit: 50 },
 *   cursorSecret: 'my-secret'
 * })
 */
export function createPaginationSchema(config: CreatePaginationSchemaOptions) {
  const limits = config.limits ?? {}
  const defaultLimit = config.limits?.defaultLimit ?? 20

  const adapter =
    config.source === 'query' ? createPaginationQueryAdapter(defaultLimit) :
    config.source === 'json' ? createPaginationJsonAdapter(defaultLimit) :
    createPaginationFormAdapter(defaultLimit)

  return adapter
    // Step 1: Validate limits
    .check((ctx) => {
      const pagination = ctx.value

      // Validate limits
      if (pagination.limit < (limits.minLimit ?? 1)) {
        ctx.issues.push({
          code: "too_small",
          minimum: limits.minLimit ?? 1,
          origin: "number",
          path: ['limit'],
          message: `Limit must be between ${limits.minLimit ?? 1} and ${limits.maxLimit ?? 100} (exclusive), got ${pagination.limit}`,
          input: pagination
        })
      }

      if (pagination.limit > (limits.maxLimit ?? 100)) {
        ctx.issues.push({
          code: "too_big",
          maximum: limits.maxLimit ?? 100,
          origin: "number",
          path: ['limit'],
          message: `Limit must be between ${limits.minLimit ?? 1} and ${limits.maxLimit ?? 100} (exclusive), got ${pagination.limit}`,
          input: pagination
        })
      }

      // Validate offset for DoS protection
      if (pagination.type === 'offset' && pagination.offset > (limits.maxOffset ?? 10000)) {
        ctx.issues.push({
          code: "too_big",
          maximum: limits.maxOffset ?? 10000,
          origin: "number",
          path: ['offset'],
          message: `Offset cannot exceed ${limits.maxOffset ?? 10000} (DoS protection), got ${pagination.offset}`,
          input: pagination
        })
      }
    })

    // Step 2: Decode cursor (runtime operation, in transform)
    .transform((pagination, ctx): PaginationNormalized => {
      // Skip if validation failed
      if (ctx.issues.length > 0) return z.NEVER

      // Decode cursor if present
      if (pagination.type === 'cursor' && pagination.cursor && config.cursorSecret) {
        const result = decodeAndVerifyCursor(
          pagination.cursor, 
          config.cursorSecret, 
          limits.cursorTTL ?? 86400
        )
        
        if (isSuccessResponse(result)) {
          const [decoded] = result
          return {
            ...pagination,
            decodedCursor: decoded.data
          } as CursorPaginationNormalized
        } else { 
          const [error] = result
          ctx.issues.push({
            code: "custom",
            path: ['cursor'],
            message: error.detail || 'Invalid or expired cursor',
            input: pagination
          })
          return z.NEVER
        }
      }

      return pagination
    })
}

// ============================================================================
// RESPONSE GENERATION
// ============================================================================

/**
 * Creates cursor payload data from one returned database row.
 *
 * Keep this close to the query code so the mapping between database sort fields
 * and cursor fields stays obvious. The caller must pass the same `sortField`,
 * `tiebreaker`, and `direction` that were used to fetch the current page.
 *
 * @example Build a next cursor from the last returned row
 *   const head = rows[0], tail = rows[rows.length - 1]
 *   const nextData  = cursorFromRow(tail,  { sortField: "created_at", tiebreaker: "id", direction: "asc"  })
 *
 * @example Build a previous cursor from the first returned row
 *   const prevData  = cursorFromRow(head,  { sortField: "created_at", tiebreaker: "id", direction: "desc" })
 */
export function cursorFromRow<Row extends Record<string, unknown>>(row: Row, cfg: CursorRowConfig): CursorData {
  const sortValue = row[cfg.sortField];
  const tieValue = row[cfg.tiebreaker];

  // Normalize known primitives; let CursorDataSchema enforce the rest.
  const data = {
    sortField: cfg.sortField,
    // sortValue can be string, number, or Date - schema handles coercion
    sortValue: sortValue as string | number | Date,
    tiebreaker: cfg.tiebreaker,
    tiebreakerValue: tieValue as string | number,
    direction: cfg.direction,
    createdAt: new Date(), // mint time the cursor was issued
  };

  // Validate to keep types honest
  return CursorDataSchema.parse(data);
}

/**
 * Computes next and previous cursor tokens for one keyset page.
 *
 * The helper uses the first and last returned rows as page boundaries. `next`
 * points just after the last returned row. `prev` points just before the first
 * returned row and flips direction so a caller can walk backward.
 *
 * @example Forward-only cursor page
 * ```ts
 * const tokens = makeCursorTokens({
 *   items,
 *   limit: 20,
 *   sortField: 'created_at',
 *   tiebreaker: 'id',
 *   secret: 'cursor-secret',
 *   direction: 'asc',
 *   hasMoreForward: true,
 * })
 * ```
 *
 * @example Bidirectional cursor page
 * ```ts
 * const tokens = makeCursorTokens({
 *   items,
 *   limit: 20,
 *   sortField: 'created_at',
 *   tiebreaker: 'id',
 *   secret: 'cursor-secret',
 *   direction: 'desc',
 *   hasMoreForward: true,
 *   hasMoreBackward: true,
 * })
 * ```
 */
export function makeCursorTokens<Row extends Record<string, unknown>>(
  args: CursorTokenOptions<Row>,
): { next: string | undefined; prev: string | undefined } {
  const count = args.items.length;
  if (count === 0) {
    return {
      next: undefined as string | undefined,
      prev: undefined as string | undefined
    };
  }

  const head = args.items[0];
  const tail = args.items[count - 1];

  // For "next" we point past the last item we actually returned.
  const nextData: CursorData | undefined = args.hasMoreForward
    ? cursorFromRow(tail, { sortField: args.sortField, tiebreaker: args.tiebreaker, direction: args.direction })
    : undefined;

  // For "prev" we point before the first item; invert direction to walk back.
  const prevData: CursorData | undefined = args.hasMoreBackward
    ? cursorFromRow(head, { sortField: args.sortField, tiebreaker: args.tiebreaker, direction: args.direction === "asc" ? "desc" : "asc" })
    : undefined;

  return {
    next: nextData ? encodeCursor(nextData, args.secret) : undefined,
    prev: prevData ? encodeCursor(prevData, args.secret) : undefined,
  };
}

/**
 * Computes a page expiry timestamp for cursor-aware pagination metadata.
 *
 * This stays separate from cursor encoding so callers can expose one page-level
 * `expiresAt` value without re-parsing individual tokens.
 *
 * @example Cursor page with a one-hour TTL
 * ```ts
 * const expiresAt = computeExpiresAt({ ttlSecs: 3600, hasCursor: true })
 * ```
 *
 * @example Offset page without cursor tokens
 * ```ts
 * const expiresAt = computeExpiresAt({ ttlSecs: 3600, hasCursor: false })
 * // undefined
 * ```
 */
export function computeExpiresAt(opts: ComputeExpiresAtOptions): Date | undefined {
  const now = opts.now ?? new Date()
  if (opts.hasCursor && typeof opts.ttlSecs === 'number') {
    const expiry = new Date(now.getTime() + opts.ttlSecs * 1000)
    return expiry
  }
  return undefined
}

/**
 * Builds normalized pagination metadata from raw database rows.
 *
 * This is the bridge between database pagination and response metadata. It
 * expects the common `limit + 1` query pattern and turns that into trimmed page
 * items plus either cursor metadata or offset metadata.
 *
 * Read the flow as:
 *
 * ```text
 * fetched rows
 *   ├─► rows.length > limit ? trim one extra row and set hasMore
 *   └─► rows.length <= limit ? keep rows as-is
 *        ├─► cursor mode: mint next/prev tokens
 *        └─► offset mode: compute next/prev offsets
 * ```
 *
 * @example Cursor response metadata from limit+1 rows
 * ```ts
 * const meta = buildPaginationMeta({
 *   rows,
 *   query: spec,
 *   sortField: 'created_at',
 *   tiebreaker: 'id',
 *   direction: 'desc',
 *   secret: 'cursor-secret',
 *   ttlSec: 3600,
 * })
 * ```
 *
 * @example Offset response metadata with a known total
 * ```ts
 * const meta = buildPaginationMeta({
 *   rows,
 *   query: spec,
 *   total: 250,
 * })
 * ```
 */
export function buildPaginationMeta<Row extends Record<string, unknown>>(
  args: BuildPaginationMetaOptions<Row>,
): BuiltPaginationMeta<Row> {
  const { rows, query } = args;
  const limit = query.pagination.limit;

  // finalizePage logic
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  // common base
  const base: Pagination = {
    hasMore,
    limit,
    count: items.length,
    total: args.total,
    approxTotal: args.approxTotal,
  };

  if (query.pagination.type === "cursor") {
    const { sortField = "id", tiebreaker = "id", direction = "asc", secret = "" } = args;

    const { next, prev } = makeCursorTokens({
      items,
      limit,
      sortField,
      tiebreaker,
      secret,
      direction,
      hasMoreForward: hasMore,
      // hasMoreBackward could be probed separately if needed
    });

    // optional expiry
    if (args.ttlSec && args.ttlSec > 0) {
      const expiresAt = computeExpiresAt({
        ttlSecs: args.ttlSec,
        hasCursor: query.pagination.type === "cursor"
      })
      base.expiresAt = expiresAt;
    }

    return {
      items,
      pagination: {
        ...base,
        nextCursor: next,
        prevCursor: prev,
      },
      query
    };
  }

  if (query.pagination.type === "offset") {
    const nextOffset = hasMore ? query.pagination.offset + limit : undefined;
    const prevOffset = query.pagination.offset > 0 ? Math.max(0, query.pagination.offset - limit) : undefined;

    return {
      items,
      pagination: {
        ...base,
        offset: query.pagination.offset,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        ...(prevOffset !== undefined ? { prevOffset } : {}),
      },
      query
    };
  }

  // exhaustive guard
  return { items, pagination: base };
}
