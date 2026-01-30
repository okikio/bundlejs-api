/**
 * Generic SPARQL query execution utility.
 * 
 * Mirrors the Supabase execution architecture for consistency across data sources.
 * Provides composable query building with proper type safety using @okikio/sparql.
 */

import type { QuerySpec, FilterOperator, SortDirection } from '../query/schemas.ts'
import { 
  type select, 
  triple, 
  v, 
  raw,
  type SparqlValue,
  type TripleSubject,
  type TriplePredicate,
  type TripleObject,
} from '@okikio/sparql'
import { 
  executeSparql,
  transformResults,
  QueryError,
  type QueryResult,
  type BindingMap,
} from '@okikio/sparql/executor'

import type { ErrorResult } from '../response/schemas.ts'
import {
	badGateway,
	badRequest,
	gatewayTimeout,
	rateLimitExceeded,
	requestTimeout,
	serviceUnavailable,
} from '../response/errors.ts'

// ============================================================================
// Types
// ============================================================================

/**
 * Base triple pattern for security/scoping (applied before QuerySpec filters).
 */
interface BaseSparqlPattern {
  subject: TripleSubject
  predicate: TriplePredicate
  object: TripleObject
}

/**
 * Options for SPARQL query execution.
 */
interface SparqlQueryOptions {
  /** SPARQL endpoint URL */
  endpoint: string
  /** Base patterns for security/scoping (e.g., tenant isolation, soft deletes) */
  basePatterns?: BaseSparqlPattern[]
  /** Query timeout in milliseconds (default: 30000) */
  timeout?: number
  /** Additional namespace prefixes beyond standard ones */
  additionalPrefixes?: Record<string, string>
}

/**
 * Discriminated error types for proper error handling.
 */
type SparqlErrorKind = 'syntax' | 'timeout' | 'unavailable' | 'database' | 'unknown'

// ============================================================================
// Filter Operator Mapping
// ============================================================================

/**
 * Maps QuerySpec filter operators to SPARQL fluent expressions.
 * 
 * Uses the fluent API from @okikio/sparql for type-safe comparisons.
 */
const OPERATOR_MAP: Record<
  FilterOperator,
  (field: string, value: unknown) => SparqlValue
> = {
  // Equality
  eq: (field, value) => v(field).eq(value as string | number | boolean),
  ne: (field, value) => v(field).neq(value as string | number | boolean),
  
  // Comparisons
  gt: (field, value) => v(field).gt(value as string | number),
  gte: (field, value) => v(field).gte(value as string | number),
  lt: (field, value) => v(field).lt(value as string | number),
  lte: (field, value) => v(field).lte(value as string | number),
  
  // String operations (case-sensitive)
  contains: (field, value) => v(field).contains(value as string),
  startswith: (field, value) => v(field).startsWith(value as string),
  endswith: (field, value) => v(field).endsWith(value as string),
  
  // String operations (case-insensitive)
  icontains: (field, value) => v(field).lcase().contains((value as string).toLowerCase()),
  
  // Null checks
  is_null: (field) => v(field).isNull(),
  is_not_null: (field) => v(field).isNotNull(),
  
  // Special operators (handled separately)
  in: () => { throw new Error('IN operator handled separately') },
  nin: () => { throw new Error('NOT IN operator handled separately') },
  between: () => { throw new Error('BETWEEN operator handled separately') },
}

// ============================================================================
// Query Building Functions
// ============================================================================

/**
 * Convert QuerySpec filters to SPARQL filter expressions.
 * 
 * Handles:
 * - Standard operators via fluent API
 * - Special operators (in, nin, between) with custom logic
 * - Multiple filters combined with AND
 */
function buildFilters(filters: QuerySpec['filters']): SparqlValue[] {
  if (!filters || filters.length === 0) return []

  return filters.map((filter) => {
    const { field, operator, value } = filter

    // Handle special operators
    if (operator === 'in') {
      // Build OR chain: ?field = val1 OR ?field = val2 ...
      const values = value as unknown[]
      const conditions = values.map(val => v(field).eq(val as string | number | boolean))
      // Use raw to combine with OR since fluent .or() takes single arg
      return raw(`(${conditions.map(c => c.value).join(' || ')})`)
    }

    if (operator === 'nin') {
      // Build AND chain: ?field != val1 AND ?field != val2 ...
      const values = value as unknown[]
      const conditions = values.map(val => v(field).neq(val as string | number | boolean))
      return raw(`(${conditions.map(c => c.value).join(' && ')})`)
    }

    if (operator === 'between') {
      // Convert to: ?field >= min AND ?field <= max
      const [min, max] = value as [number, number]
      return raw(`(${v(field).gte(min).value} && ${v(field).lte(max).value})`)
    }

    // Standard operators via map
    const mapFn = OPERATOR_MAP[operator]
    if (!mapFn) {
      throw new Error(`Unsupported filter operator: ${operator}`)
    }

    return mapFn(field, value)
  })
}

/**
 * Convert QuerySpec sorts to SPARQL ORDER BY specifications.
 */
function buildSorts(sorts: QuerySpec['sorts']): Array<{ variable: string; direction?: 'ASC' | 'DESC' }> {
  if (!sorts || sorts.length === 0) return []

  return sorts.map(({ field, direction }) => ({
    variable: field,
    direction: direction === 'asc' ? 'ASC' : 'DESC',
  }))
}

/**
 * Build cursor pagination filter.
 * 
 * Generates comparison based on sort direction:
 * - DESC: sortField < sortValue OR (sortField = sortValue AND tiebreaker < tiebreakerValue)
 * - ASC: sortField > sortValue OR (sortField = sortValue AND tiebreaker > tiebreakerValue)
 */
function buildCursorFilter(
  sortField: string,
  sortValue: string | number | Date,
  tiebreaker: string,
  tiebreakerValue: string | number,
  direction: SortDirection,
): SparqlValue {
  // Handle date encoding for temporal fields
  const encodedValue = sortValue instanceof Date
    ? `"${sortValue.toISOString().split('T')[0]}"^^xsd:date`
    : sortValue

  if (direction === 'desc') {
    // For DESC: next page has smaller values
    return raw(
      `(${v(sortField).lt(encodedValue).value} || ` +
      `(${v(sortField).eq(encodedValue).value} && ` +
      `STR(${v(tiebreaker).value}) < ${JSON.stringify(String(tiebreakerValue))}))`
    )
  } else {
    // For ASC: next page has larger values
    return raw(
      `(${v(sortField).gt(encodedValue).value} || ` +
      `(${v(sortField).eq(encodedValue).value} && ` +
      `STR(${v(tiebreaker).value}) > ${JSON.stringify(String(tiebreakerValue))}))`
    )
  }
}

/**
 * Apply QuerySpec to a SPARQL query builder.
 * 
 * Applies in order:
 * 1. Base patterns (security/scoping)
 * 2. Filters (WHERE + FILTER)
 * 3. Cursor filter (if cursor pagination)
 * 4. Sorts (ORDER BY)
 * 5. Pagination (LIMIT/OFFSET)
 */
function applyQuerySpec(
  builder: ReturnType<typeof select>,
  querySpec: QuerySpec,
  options: SparqlQueryOptions,
): ReturnType<typeof select> {
  let query = builder

  // 1. Apply base patterns (security/scoping)
  if (options.basePatterns && options.basePatterns.length > 0) {
    for (const pattern of options.basePatterns) {
      query = query.where(
        triple(pattern.subject, pattern.predicate, pattern.object)
      )
    }
  }

  // 2. Apply filters
  const filterExprs = buildFilters(querySpec.filters)
  for (const filterExpr of filterExprs) {
    query = query.filter(filterExpr)
  }

  // 3. Apply cursor filter if present
  if (querySpec.pagination.type === 'cursor' && querySpec.pagination.decodedCursor) {
    const { sortField, sortValue, tiebreaker, tiebreakerValue, direction } = 
      querySpec.pagination.decodedCursor
    
    const cursorFilter = buildCursorFilter(
      sortField,
      sortValue,
      tiebreaker,
      tiebreakerValue,
      direction
    )
    query = query.filter(cursorFilter)
  }

  // 4. Apply sorts
  const sorts = buildSorts(querySpec.sorts)
  for (const sort of sorts) {
    query = query.orderBy(sort.variable, sort.direction)
  }

  // 5. Apply pagination
  if (querySpec.pagination.type === 'offset') {
    const { limit, offset } = querySpec.pagination
    query = query.limit(limit).offset(offset)
  } else {
    // Cursor pagination uses limit only
    query = query.limit(querySpec.pagination.limit)
  }

  return query
}

// ============================================================================
// Main Execution Function
// ============================================================================

/**
 * Execute a SPARQL query with error handling and result transformation.
 * 
 * Returns the raw SPARQL JSON result, throwing on error. Use transformSparqlResults
 * to convert bindings to plain objects.
 */
async function executeSparqlQuery<T extends BindingMap = BindingMap>(
  query: ReturnType<typeof select>,
  querySpec: QuerySpec,
  options: SparqlQueryOptions,
): Promise<QueryResult<T>> {
  try {
    // Build final query with prefixes
    const builtQuery = applyQuerySpec(query, querySpec, options).build()

    // Execute query
    const result = await executeSparql<QueryResult<T>>(
      {
        endpoint: options.endpoint,
        timeoutMs: options.timeout ?? 30000,
      },
      builtQuery,
      { timeoutMs: options.timeout ?? 30000 }
    )

    return result
  } catch (error) {
    // executeSparql throws QueryError, not returns error object
    if (error instanceof QueryError) {
      // Re-throw with error kind for downstream handling
      throw error
    }

    // Unknown error type
    throw new QueryError({
      kind: 'unknown',
      message: error instanceof Error ? error.message : 'Unknown error during SPARQL execution',
      query: query.build().value,
      cause: error,
    })
  }
}

/**
 * Transform SPARQL JSON bindings to plain objects.
 * 
 * Uses the library's transformResults to handle type coercion:
 * - xsd:integer → number
 * - xsd:decimal/double → number
 * - xsd:boolean → boolean
 * - Literals → string
 */
function transformSparqlResults<T extends BindingMap>(
  result: QueryResult<T>
): Array<{ [K in keyof T]: unknown }> {
  return transformResults(result)
}

// ============================================================================
// Convenience Wrappers
// ============================================================================

/**
 * Execute a SPARQL query without base patterns.
 * 
 * For queries that don't need security/scoping constraints.
 */
export async function querySparql<T extends BindingMap = BindingMap>(
  query: ReturnType<typeof select>,
  querySpec: QuerySpec,
  options: Omit<SparqlQueryOptions, 'basePatterns'>,
): Promise<Array<{ [K in keyof T]: unknown }>> {
  const fullOptions: SparqlQueryOptions = {
    ...options,
    basePatterns: undefined,
  }

  const result = await executeSparqlQuery<T>(query, querySpec, fullOptions)
  return transformSparqlResults(result)
}

/**
 * Execute a SPARQL query with base security patterns.
 * 
 * Base patterns are applied before QuerySpec filters for tenant isolation,
 * soft deletes, etc.
 */
export async function querySparqlWithBase<T extends BindingMap = BindingMap>(
  query: ReturnType<typeof select>,
  querySpec: QuerySpec,
  options: SparqlQueryOptions,
): Promise<Array<{ [K in keyof T]: unknown }>> {
  const result = await executeSparqlQuery<T>(query, querySpec, options)
  return transformSparqlResults(result)
}


export function queryPreview(query: string, maxLen: number = 200): string {
	const cleaned = query.replace(/\s+/g, ' ').trim()
	return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned
}

/**
 * Map QueryError.kind to RFC7807 utility factories.
 *
 * Policy decisions:
 * - Upstream timeouts => 504 (gatewayTimeout)
 * - Upstream connectivity issues => 503 (serviceUnavailable)
 * - Upstream protocol mismatch => 502 (badGateway)
 * - Upstream 4xx:
 *   - 400/422 => treat as client query issue (badRequest / unprocessableEntity if you prefer)
 *   - 429 => rateLimitExceeded (if you have retryAfter; else pick a default)
 *   - 401/403 and most other 4xx => treat as upstream misconfig (badGateway), not client auth
 * - Upstream 5xx => badGateway/serviceUnavailable depending on status
 */
export function mapSparqlQueryErrorToProblem(
	instance: string,
	query: string,
	error: QueryError,
): ErrorResult {
	switch (error.kind) {
		case 'timeout': {
			return gatewayTimeout(
				instance,
				`SPARQL upstream timed out: ${error.message}`,
				Object.assign(
					{ query_preview: queryPreview(query) },
					typeof error?.status === 'number'
						? { upstream_status: error?.status }
						: {},
				),
			)
		}

		case 'abort': {
			// Closest standard utility you already have is 408.
			// If you later add a dedicated 499 handler, swap it.
			return requestTimeout(
				instance,
				`SPARQL request was aborted: ${error.message}`,
				{ query_preview: queryPreview(query) },
			)
		}

		case 'network': {
			return serviceUnavailable(
				instance,
				'graph-database',
				`Unable to reach SPARQL upstream: ${error.message}`,
				Object.assign(
					{ query_preview: queryPreview(query) },
					{ kind: 'network' },
				),
			)
		}

		case 'protocol': {
			return badGateway(
				instance,
				`SPARQL upstream returned an unexpected response format: ${error.message}`,
				{ query_preview: queryPreview(query) },
			)
		}

		case 'http': {
			const upstreamStatus =
				typeof error?.status === 'number'
					? error?.status
					: 502

			// Prefer structured hints, but do not leak giant bodies.
			const responseBody =
				(error as { responseBody?: unknown }).responseBody

			// Upstream says: "your query is invalid"
			if (upstreamStatus === 400 || upstreamStatus === 422) {
				return badRequest(
					instance,
					`SPARQL query rejected by upstream: ${error.message}`,
					Object.assign(
						{ query_preview: queryPreview(query) },
						responseBody !== undefined ? { upstream_body: responseBody } : {},
						{ upstream_status: upstreamStatus },
					),
				)
			}

			// Upstream rate limiting
			if (upstreamStatus === 429) {
				// If you later plumb Retry-After from upstream headers, use it here.
				const retryAfter = 60
				return rateLimitExceeded(
					instance,
					retryAfter,
					Object.assign(
						{ query_preview: queryPreview(query) },
						{ upstream_status: upstreamStatus },
					),
				)
			}

			// Upstream is unhealthy
			if (upstreamStatus === 503) {
				return serviceUnavailable(
					instance,
					'graph-database',
					`SPARQL upstream service unavailable: ${error.message}`,
					Object.assign(
						{ query_preview: queryPreview(query) },
						{ upstream_status: upstreamStatus },
						responseBody !== undefined ? { upstream_body: responseBody } : {},
					),
				)
			}

			if (upstreamStatus === 504) {
				return gatewayTimeout(
					instance,
					`SPARQL upstream gateway timed out: ${error.message}`,
					Object.assign(
						{ query_preview: queryPreview(query) },
						{ upstream_status: upstreamStatus },
					),
				)
			}

			// Do NOT leak upstream auth/permission failures as if they were *your* API auth.
			// These are typically config issues (bad credentials between services).
			if (upstreamStatus === 401 || upstreamStatus === 403) {
				return badGateway(
					instance,
					`SPARQL upstream authorization failure: ${error.message}`,
					Object.assign(
						{ query_preview: queryPreview(query) },
						{ upstream_status: upstreamStatus },
						responseBody !== undefined ? { upstream_body: responseBody } : {},
					),
				)
			}

			// All other upstream HTTP errors => Bad Gateway by default
			return badGateway(
				instance,
				`SPARQL upstream HTTP ${upstreamStatus}: ${error.message}`,
				Object.assign(
					{ query_preview: queryPreview(query) },
					{ upstream_status: upstreamStatus },
					responseBody !== undefined ? { upstream_body: responseBody } : {},
				),
			)
		}

		case 'unknown':
		default: {
			// If this can only happen inside executeSparql, it's usually upstream-adjacent.
			// If you want strictly-server errors here, switch to internalServerError().
			return badGateway(
				instance,
				`Unexpected SPARQL error: ${error.message}`,
				{ query_preview: queryPreview(query) },
			)
		}
	}
}


// Export for use in handlers
export { executeSparqlQuery, transformSparqlResults, applyQuerySpec }