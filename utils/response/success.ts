import type { ContentlessStatusCode, ContentfulStatusCode, StatusCode } from 'hono/utils/http-status'
import type { ContentlessResult, Pagination, SuccessResult, PaginationResult, DataMetadata, JsonHeadersWithLinks, StandardHeaders, ResponseResult, SuccessResponse, SuccessEnvelope, GenericSuccessResult, PaginationMetadata, LinkMap } from './schemas.ts'

/**
 * Build the standard success tuple used by Hono handlers in this repo.
 *
 * This helper keeps successful responses aligned on one envelope shape:
 * `{ data, meta }` plus a JSON content type header. Callers can use it for
 * ordinary 200 responses or for the small set of success statuses that still
 * carry a body, such as 201 Created and 202 Accepted.
 *
 * When the status code forbids a body, this helper returns the contentless
 * tuple shape instead. That lets route handlers keep one helper for both
 * payload-bearing and no-content success cases without lying about the result.
 *
 * @example Common 200 response
 * return c.json(...ok({ id: 'like-1' }))
 *
 * @example Contentless success
 * return c.json(...ok(null, 204))
 */
export function ok<T extends undefined | null | ''>(
  data: T,
  statusCode: ContentlessStatusCode,
): ContentlessResult;

export function ok<T = unknown, M extends DataMetadata = DataMetadata>(
  data: T,
  statusCode?: ContentfulStatusCode,
  meta?: M
): SuccessResult<T, M>;

export function ok<T = unknown, M extends DataMetadata = DataMetadata>(
  data: T,
  statusCode: StatusCode = 200,
  meta = {} as M
): SuccessResult<T, M> | ContentlessResult {
  switch (statusCode) {
    case 101:
    case 204:
    case 205:
    case 304:
      return [undefined, statusCode as ContentlessStatusCode, { 'Content-Type': 'application/json' }] as const
  }

  return [
    {
      data,
      meta: Object.assign({ timestamp: new Date().toISOString() }, (meta ?? {})),
    },
    statusCode as ContentfulStatusCode,
    { 'Content-Type': 'application/json' },
  ] as const
}

/**
 * Build a `201 Created` response and optionally attach a `Location` header.
 *
 * Use this when a write operation produced a new resource and the caller may
 * need a canonical URI for follow-up reads. The body still uses the shared
 * success envelope so create routes stay consistent with ordinary `ok()`
 * responses.
 *
 * @example Created resource with a canonical URL
 * return c.json(...created({ id }, `/api/orders/${id}`))
 *
 * @example Created resource without a location header
 * return c.json(...created({ id, state: 'draft' }))
 */
export function created<T = unknown, M extends DataMetadata = DataMetadata>(
  data: T,
  location?: string,
  meta?: M
): SuccessResult<T> {
  const result = ok<T>(data, 201, meta)
  return location ? withHeaders(result, { Location: location }) : result
}

/**
 * Build a `202 Accepted` response for work that will complete asynchronously.
 *
 * This keeps the response shape identical to `ok()` while making the status
 * code explicit. Callers can attach tracking metadata so clients know how to
 * poll, subscribe, or correlate later status updates.
 *
 * @example Queue background work
 * return c.json(...accepted({ taskId }))
 *
 * @example Include tracking metadata for follow-up polling
 * return c.json(...accepted({ taskId }, {
 *   tracking: { taskId, status: 'queued' },
 * }))
 */
export function accepted<T = unknown, M extends DataMetadata = DataMetadata>(
  data: T,
  meta?: M
): SuccessResult<T> {
  return ok<T>(data, 202, meta)
}

/**
 * Build a `204 No Content` success tuple with the repo's standard JSON header.
 *
 * This exists so handlers that intentionally return no body do not need to
 * remember which status codes forbid payloads or manually assemble the tuple.
 *
 * @example Delete action with no response body
 * return c.json(...noContent())
 *
 * @example Idempotent mutation that has nothing else to report
 * return c.json(...noContent())
 */
export function noContent(): ContentlessResult {
  return ok<null>(null, 204)
}

/**
 * Build a paginated success response with normalized metadata and navigation headers.
 *
 * The helper supports both cursor-based and offset-based pagination because
 * different endpoints in this repo need different tradeoffs. It keeps those
 * strategies on one response contract by returning:
 *
 * - a success envelope whose `meta.pagination` field mirrors the paging state
 * - a normalized `links` object for application code and tests
 * - RFC 8288-style `Link` headers plus common pagination counters for clients
 *
 * For offset pagination, the helper only emits totals and last-page data when
 * the server actually knows them. Estimated totals are surfaced as best-effort
 * hints and are marked in `Preference-Applied` so clients do not confuse them
 * with exact counts.
 *
 * We never guess `first` or `last` for cursor pagination because those links
 * are usually unstable once the underlying collection changes.
 *
 * @example Cursor pagination response
 * return c.json(...paginate(c.req.url, items, { hasMore: true, nextCursor: 'abc', limit: 20 }))
 *
 * @example Offset pagination with exact totals
 * return c.json(...paginate(c.req.url, items, {
 *   hasMore: true,
 *   offset: 20,
 *   limit: 20,
 *   count: items.length,
 *   total: 87,
 * }))
 */
export function paginate<T = unknown>(
  url = "/",
  data: T,
  pagination: Pagination
): PaginationResult<T> {
  // --- headers & links -------------------------------------------------------
  const headers: StandardHeaders = {}
	const linkMap: LinkMap = { self: url }; 
  const linkHeaderParts: string[] = [];

  // Self link (current page)
  if (pagination.offset !== undefined && pagination.limit) {
    // Canonical offset-based URL for this page
    const selfUrl = buildOffsetUrl(url, pagination.offset, pagination.limit);
    linkHeaderParts.push(`<${selfUrl}>; rel="self"`)
    linkMap.self = selfUrl
  } else {
    // Fallback: treat `path` as already representing the current URL (path + query)
    linkHeaderParts.push(`<${url}>; rel="self"`)
    linkMap.self = url
  }

  // Cursor links
  if (pagination.nextCursor) {
    const nextUrl = buildCursorUrl(url, pagination.nextCursor, pagination.limit)
    linkHeaderParts.push(`<${nextUrl}>; rel="next"`)
    linkMap.next = nextUrl
  }
  if (pagination.prevCursor) {
    const prevUrl = buildCursorUrl(url, pagination.prevCursor, pagination.limit)
    linkHeaderParts.push(`<${prevUrl}>; rel="prev"`)
    linkMap.prev = prevUrl
  }

  // Offset links + extra headers
  if (pagination.offset !== undefined && pagination.limit) {
    const firstOffset = 0;
    const nextOffset = pagination.offset + pagination.limit
    const prevOffset = Math.max(pagination.offset - pagination.limit, 0)

    const total = pagination.total
    const approx = pagination.approxTotal

		const firstUrl = buildOffsetUrl(url, firstOffset, pagination.limit);
		const nextUrl = buildOffsetUrl(url, nextOffset, pagination.limit);
		const prevUrl = buildOffsetUrl(url, prevOffset, pagination.limit);

		linkHeaderParts.push(`<${firstUrl}>; rel="first"`);
    linkMap.first = firstUrl;
    
    // prev: only when not on first page
    if (pagination.offset > 0) {
      linkHeaderParts.push(`<${prevUrl}>; rel="prev"`);
      linkMap.prev ??= prevUrl;
    }

		// next: only when we can prove there is a next page
		// - prefer hasMore if provided
		// - otherwise, if exact total is known, compute it
    if (pagination.hasMore || (typeof total === "number" ? nextOffset < total : false)) {
      linkHeaderParts.push(`<${nextUrl}>; rel="next"`);
      linkMap.next ??= nextUrl;
    }

    // De-facto admin-friendly counters
    // Prefer exact `total`; fall back to `approxTotal` if present.
    if (typeof total === "number" || typeof approx === "number") {
      const totalCount = typeof total === "number" ? total : (approx as number)
      headers["X-Total-Count"] = String(totalCount)
      headers["X-Per-Page"] = String(pagination.limit)
      headers["X-Page"] = String(Math.floor((pagination.offset ?? 0) / pagination.limit) + 1)

      // Only compute total pages when exact total is known
      if (typeof total === "number" && pagination.limit > 0) {
        headers["X-Total-Pages"] = String(Math.max(Math.ceil(total / pagination.limit), 1))
      }

      // Signal whether the server used exact or estimated counts
      headers["Preference-Applied"] = typeof total === "number" ? "count=exact" : "count=estimated"
    }

    // Standards-aligned range headers (only when exact total is known)
    //  - Range-Unit: items
    //  - Content-Range: start-end/total (end is inclusive)
    if (typeof total === "number") {
      const start = Math.max(pagination.offset, 0)
      const end = Math.max(Math.min(start + pagination.limit - 1, Math.max(total - 1, 0)), 0)
      headers["Range-Unit"] = "items"
      headers["Content-Range"] = `${start}-${end}/${total}`
    }

    // Last link only when exact total is known (so it's meaningful)
    if (typeof total === "number" && total > 0) {
      const lastOffset = Math.max(total - pagination.limit, 0)
			const lastUrl = buildOffsetUrl(url, lastOffset, pagination.limit);
			linkHeaderParts.push(`<${lastUrl}>; rel="last"`);
			linkMap.last = lastUrl;
    }
  }

  if (linkHeaderParts.length > 0) {
    headers["Link"] = Array.from(new Set(linkHeaderParts)).join(", ").trim()
  }

  // --- meta envelope ---------------------------------------------------------
  const paginationMeta = Object.assign(
    {
      hasMore: pagination.hasMore,
      limit: pagination.limit,
      count: pagination.count,
    },
    pagination.nextCursor !== undefined ? { nextCursor: pagination.nextCursor } : {},
    pagination.prevCursor !== undefined ? { prevCursor: pagination.prevCursor } : {},
    pagination.offset !== undefined ? { offset: pagination.offset } : {},
    pagination.total !== undefined ? { total: pagination.total } : {},
    (pagination.approxTotal !== undefined || pagination.total !== undefined)
      ? { approxTotal: pagination.total ?? pagination.approxTotal }
      : {},
    pagination.expiresAt !== undefined ? { expiresAt: pagination.expiresAt } : {},
  ) as Pagination;


	const meta: PaginationMetadata = { pagination: paginationMeta, links: linkMap };

  // Return typed pagination tuple with headers
  return withHeaders(ok(data, 200, meta), headers as JsonHeadersWithLinks) satisfies PaginationResult<T>
}

/**
 * Allowed values for query parameters.
 * `null` and `undefined` are treated as "do not include".
 */
type QueryValue = string | number | boolean | null | undefined;

/**
 * Add or replace query parameters on a relative path or full URL string.
 *
 * Pagination helpers use this instead of hand-building query strings so they
 * preserve unrelated filters, search terms, and hash fragments when generating
 * navigation links.
 *
 * `null` and `undefined` values are skipped, which lets callers pass optional
 * parameters without pre-filtering an object first.
 * Existing query values are normalized through `URLSearchParams`, so the
 * serialized encoding may change even when the decoded value stays the same.
 *
 * @example Extend an existing relative URL
 * buildUrlWithParams('/search?q=superman', { cursor: 'abc', limit: 20 })
 * // '/search?q=superman&cursor=abc&limit=20'
 *
 * @example Replace a parameter on an absolute URL
 * buildUrlWithParams('https://example.com/list?offset=10', { offset: 30 })
 * // 'https://example.com/list?offset=30'
 */
export function buildUrlWithParams(
  path: string,
  paramsToSet: Record<string, QueryValue>,
): string {
  // Split off hash fragment (if any) so we can re-attach it later
  const [beforeHash, hash = ""] = path.split("#", 2);
  // Split path and existing query string (if any)
  const [base, existingQuery = ""] = beforeHash.split("?", 2);

  const searchParams = new URLSearchParams(existingQuery);

  // Apply new/updated params
  for (const [key, value] of Object.entries(paramsToSet)) {
    if (value === null || value === undefined) {
      // Skip nullish values (could also choose to delete instead)
      continue;
    }

    let stringValue: string;

    if (typeof value === "boolean") {
      stringValue = value ? "true" : "false";
    } else {
      stringValue = String(value);
    }

    searchParams.set(key, stringValue);
  }

  const queryString = searchParams.toString();
  const hashPart = hash ? `#${hash}` : "";

  if (queryString.length === 0) {
    return `${base}${hashPart}`;
  }

  return `${base}?${queryString}${hashPart}`;
}

/**
 * Build a cursor-pagination link while preserving the rest of the URL state.
 *
 * This keeps cursor navigation consistent with filters already present on the
 * request URL instead of forcing callers to rebuild the full query string.
 *
 * @example Next page for a filtered search
 * buildCursorUrl('/search?q=superman', 'abc123', 20)
 * // '/search?q=superman&cursor=abc123&limit=20'
 *
 * @example Cursor link from the default root path
 * buildCursorUrl('/', 'next-1', 50)
 * // '/?cursor=next-1&limit=50'
 */
export function buildCursorUrl(
  path = "/",
  cursor: string,
  limit: number,
): string {
  return buildUrlWithParams(path, {
    cursor,
    limit,
  });
}

/**
 * Build an offset-pagination link while preserving existing query parameters.
 *
 * This is used for `self`, `first`, `prev`, `next`, and `last` links when an
 * endpoint exposes numbered pages or offset-style navigation.
 *
 * @example Offset link for a sorted list
 * buildOffsetUrl('/list?sort=desc', 40, 20)
 * // '/list?sort=desc&offset=40&limit=20'
 *
 * @example First page link
 * buildOffsetUrl('/list?sort=desc', 0, 20)
 * // '/list?sort=desc&offset=0&limit=20'
 */
export function buildOffsetUrl(
  path: string,
  offset: number,
  limit: number,
): string {
  return buildUrlWithParams(path, {
    offset,
    limit,
  });
}

/**
 * Merge additional headers into a tuple returned by the response helpers.
 *
 * This preserves the original body and status types so callers can enrich a
 * response with transport-level metadata such as `Location`, caching headers,
 * or pagination headers without reassembling the tuple by hand.
 *
 * @example Add a location header after building a created response
 * const response = created({ id: 'ord_1' })
 * return c.json(...withHeaders(response, { Location: '/orders/ord_1' }))
 *
 * @example Add cache headers to a standard success response
 * return c.json(...withHeaders(ok(data), { 'Cache-Control': 'private, max-age=60' }))
 */
export function withHeaders<
  TBody,
  const T extends readonly [TBody, StatusCode, StandardHeaders],
  const E extends StandardHeaders
>(
  result: T,
  extra: E
): readonly [T[0], T[1], T[2] & E] {
  const [body, status, headers] = result
  return [
    body,
    status,
    { ...headers, ...extra } as T[2] & E,
  ] as const
}

/**
 * Merge additional metadata into the success envelope without changing the response tuple shape.
 *
 * This exists for cross-cutting metadata that is discovered after the base
 * response was created, such as query diagnostics, backend provenance, or
 * pagination-adjacent information. The merge is shallow by key, so callers
 * should provide fully assembled nested objects when they need precise control.
 *
 * The original `timestamp` produced by `ok()` remains intact unless the caller
 * explicitly overwrites it in `extra`.
 *
 * @example Add query diagnostics to a paginated response
 * const response = paginate(url, items, pagination)
 * return c.json(...withMeta(response, {
 *   query: { durationMs, filters, sorts },
 * }))
 *
 * @example Attach backend provenance to a standard success response
 * return c.json(...withMeta(ok(data), {
 *   source: { backend: 'postgres', adapter: 'drizzle-query' },
 * }))
 */
export function withMeta<
  const T extends GenericSuccessResult,
  const M extends DataMetadata
>(
  result: T,
  extra: M
): readonly [
  SuccessEnvelope<T[0]['data'], T[0]['meta'] & M>,
  T[1],
  T[2]
] {
  const [body, status, headers] = result

  const mergedMeta = Object.assign(
    {},
    body.meta ?? {},
    extra ?? {},
  )

  return [
    Object.assign(body, {
      data: body.data,
      meta: mergedMeta as T[0]['meta'] & M,
    }),
    status,
    headers,
  ] as const
}

/**
 * Narrow a response tuple to the success branch by inspecting its content type.
 *
 * The shared response helpers distinguish success and RFC 7807 problem tuples
 * through the `Content-Type` header. This guard lets callers branch on that
 * contract without manually casting the tuple.
 *
 * @example Branch between success and problem responses
 * if (isSuccessResponse(result)) {
 *   return result[0].data
 * }
 *
 * @example Preserve type narrowing in helper code
 * const body = isSuccessResponse(result) ? result[0].meta : result[0].detail
 */
export function isSuccessResponse<T>(response: ResponseResult<T>): response is SuccessResponse<T> {
  return response[2]['Content-Type'] !== 'application/problem+json'
}
