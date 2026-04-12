// utils/execution/db.ts
/**
 * Drizzle-backed collection query execution helpers.
 *
 * This module translates the repo's normalized query-spec contract into
 * checked Drizzle queries against the shared schema. It keeps relation lookup,
 * field validation, filtering, sorting, pagination, and count strategy logic
 * in one place so handlers can stay focused on endpoint behavior.
 */

import type { Database } from '@utils/db'
import type { SQL, Table } from 'drizzle-orm'
import type { PgColumn, SelectedFieldsFlat } from 'drizzle-orm/pg-core'
import type {
  BaseFilterNormalized as CollectionBaseFilter,
  CursorData as CollectionCursorData,
  FieldSelectionNormalized as CollectionFieldSelection,
  FilterNormalized as CollectionFilter,
  PaginationNormalized as CollectionPagination,
  QuerySpec as CollectionQuerySpec,
  SortNormalized as CollectionSort,
} from '@utils/query/schemas'
import type { ErrorResult } from '@utils/response/schemas'

import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  getTableName,
  gt,
  gte,
  ilike,
  inArray,
  isTable,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'

import { schema } from '../db/schemas/auth.ts'
import { ok } from '@utils/response/success'
import { badRequest, exception, internalServerError } from '@utils/response/errors'

/**
 * Runtime registry of Drizzle tables keyed by shared schema export name.
 *
 * This module keeps the repo's normalized `@utils/query` contract intact while
 * moving execution onto Drizzle and Postgres.js.
 *
 * The flow is:
 *
 * ```text
 * QuerySpec
 *   ├─► resolve relation table and column map
 *   ├─► build filter, sort, and pagination plan
 *   ├─► execute main row query through Drizzle's builder API
 *   └─► optionally compute total count
 *         ├─► exact: Drizzle count()
 *         ├─► planned: PostgreSQL EXPLAIN JSON
 *         └─► estimated: pg_class statistics
 * ```
 *
 * Read the diagram from top to bottom. The main listing query stays on
 * Drizzle's typed builder surface, while the PostgreSQL-specific planner and
 * statistics paths use raw SQL only where Drizzle does not provide a higher-
 * level abstraction.
 */
export const RELATION_TABLES: Readonly<Record<string, Table>> = Object.freeze(
  Object.fromEntries(
    Object.entries(schema).filter(([, value]) => isTable(value)),
  ) as Record<string, Table>,
)

/**
 * Column lookup keyed by the normalized field name exposed through query specs.
 */
export type ColumnMap = Record<string, PgColumn>

/**
 * Drizzle select-shape used for projected collection queries.
 */
export type ColumnSelection = SelectedFieldsFlat

/**
 * Canonical query-normalization constants reused by the execution layer.
 *
 * These stay sourced from `@utils/query` so request parsing, validation, and
 * SQL execution all share the same operator and sort vocabulary.
 */
export {
  FILTER_OPERATORS as COLLECTION_FILTER_OPERATORS,
  SORT_DIRECTIONS as COLLECTION_SORT_DIRECTIONS,
} from '@utils/query/schemas'

/**
 * Canonical normalized query types reused by the execution layer.
 *
 * The executor consumes the same validated query-spec shapes produced by the
 * query package instead of maintaining a parallel set of near-identical types.
 */
export type {
  BaseFilterNormalized as CollectionBaseFilter,
  CursorPaginationNormalized as CollectionCursorPagination,
  CursorData as CollectionCursorData,
  FieldSelectionNormalized as CollectionFieldSelection,
  FilterNormalized as CollectionFilter,
  FiltersNormalized as CollectionFilters,
  FilterOperator as CollectionFilterOperator,
  QuerySpec as CollectionQuerySpec,
  JsonApiFieldSelection as CollectionJsonApiFieldSelection,
  OffsetPaginationNormalized as CollectionOffsetPagination,
  PaginationNormalized as CollectionPagination,
  SimpleFieldSelection as CollectionSimpleFieldSelection,
  SortDirection as CollectionSortDirection,
  SortNormalized as CollectionSort,
  SortsNormalized as CollectionSorts,
} from '@utils/query/schemas'

/**
 * Relation name passed to the generic collection executor.
 *
 * Endpoints choose the relation name they want to expose. The executor resolves
 * that name against the shared Drizzle schema export at runtime rather than
 * baking a package-local allowlist into this module.
 */
export type RelationName = string

/**
 * Runtime row object returned by the generic executor.
 *
 * The exact keys depend on the selected relation and requested fields, so the
 * public execution boundary exposes rows as plain records instead of leaking
 * Drizzle's table-generated types through the package surface.
 */
export type RelationRow = Record<string, unknown>

/**
 * Shared Drizzle database surface used by collection execution.
 *
 * The executor intentionally uses the same database type exported by
 * `@utils/db`. That keeps the row-query path on Drizzle's typed builder API
 * instead of forcing a narrower handwritten wrapper around `execute()`.
 */
export type CollectionDatabase = Database

/**
 * Metadata attached to successful collection query responses.
 */
export interface CollectionQueryMeta {
  /** ISO timestamp generated when the success response tuple was built. */
  timestamp: string

  /** Total row count when requested, otherwise `null`. */
  total: number | null
}

/**
 * Success envelope returned by collection query helpers.
 */
export interface CollectionSuccessEnvelope {
  /** Rows returned for the requested relation. */
  data: RelationRow[]

  /** Metadata attached to the current query execution. */
  meta: CollectionQueryMeta
}

/**
 * Success tuple returned by collection query helpers.
 */
export type CollectionSuccessResult = readonly [
  CollectionSuccessEnvelope,
  number,
  Record<string, string | undefined>,
]

/**
 * Shared RFC 7807 problem-details and error tuple contracts used by execution
 * helpers.
 *
 * These names are re-exported from the response package so the execution
 * module does not drift away from the repo's canonical error boundary.
 */
export type {
  ErrorResult as CollectionErrorResult,
  ProblemDetails as CollectionProblemDetails,
} from '@utils/response/schemas'

/**
 * Complete result type returned by collection query helpers.
 */
export type CollectionQueryResult =
  | CollectionSuccessResult
  | ErrorResult

/**
 * Canonical count strategies exposed by the collection executor.
 */
export const COLLECTION_COUNT_STRATEGIES = ['exact', 'planned', 'estimated'] as const

/**
 * One supported count-strategy name.
 */
export type CollectionCountStrategy = typeof COLLECTION_COUNT_STRATEGIES[number]

/**
 * Options that control how a collection query is executed and summarized.
 *
 * The query spec already defines filtering, sorting, field selection, and
 * pagination. These options cover the extra operational choices around count
 * metadata and server-enforced scoping filters.
 */
export interface CollectionQueryOptions {
  /**
   * Whether to attach total-count metadata to the response.
   *
   * Leave this off when a caller only needs page data. Counting can add extra
   * database work, especially when the query is filtered.
   */
  includeCount?: boolean

  /**
   * Strategy used when `includeCount` is enabled.
   *
   * - `exact` runs `count(*)` and is the most accurate.
   * - `planned` reads PostgreSQL's planner estimate for the filtered query.
   * - `estimated` reads table statistics when possible and falls back to the
   *   planner when filters make raw table statistics misleading.
   */
  countStrategy?: CollectionCountStrategy

  /**
   * Filters applied before caller-provided filters.
   *
   * This is the hook for tenant scoping, soft-delete guards, or other
   * server-enforced constraints that should not depend on user input.
   */
  baseFilters?: CollectionBaseFilter[]
}

/**
 * Normalized pagination instructions ready to be folded into a database query.
 */
export interface PaginationPlan {
  /**
   * Optional boundary clause produced by cursor pagination.
   */
  where?: SQL

  /**
   * Maximum number of rows to request from the database.
   *
   * Cursor pagination intentionally asks for one extra row so callers can infer
   * whether another page exists without issuing a second query.
   */
  limit: number

  /**
   * Offset used for offset-based pagination.
   */
  offset?: number
}

/**
 * Complete query execution plan derived from a validated query spec.
 */
export interface QueryPlan extends PaginationPlan {
  /**
   * Ordered sort expressions to append after filtering.
   */
  orderBy: SQL[]
}

/**
 * Resolves a relation name to a shared Drizzle table.
 *
 * Unknown relations fail here so downstream helpers never need to guess
 * whether a requested table exists.
 */
export function getRelationTable(relation: RelationName): Table {
  const table = RELATION_TABLES[relation]

  if (!table) {
    throw exception(badRequest(relation, `Unknown relation: ${relation}`))
  }

  return table
}

/**
 * Returns the real Drizzle columns available for a relation.
 */
export function getColumnMap(relation: RelationName): ColumnMap {
  return getTableColumns(getRelationTable(relation)) as ColumnMap
}

/**
 * Returns the SQL table name Drizzle registered for a relation.
 */
export function getRelationSqlName(relation: RelationName): string {
  return getTableName(getRelationTable(relation))
}

/**
 * Resolves one field name to a concrete Drizzle column.
 *
 * Query specs arrive with plain string field names such as `email` or
 * `created_at`. Drizzle's comparison and sort helpers must receive real column
 * objects, not unchecked strings. This lookup is the boundary that turns a
 * caller-controlled identifier into a schema-backed column reference.
 *
 * That does two jobs at once:
 *
 * 1. keep the rest of the executor on Drizzle's typed column surface
 * 2. reject unknown field names before they can reach SQL construction
 *
 * The `instance` name is forwarded into the problem-details payload so callers
 * can tell which input object referenced the unknown field.
 *
 * @example Common path
 * ```ts
 * const column = requireColumn(columns, 'email', 'user.list')
 * ```
 *
 * @example Invalid field
 * ```ts
 * requireColumn(columns, 'drop table user', 'user.list')
 * // throws badRequest('user.list', 'Unknown field: drop table user')
 * ```
 */
export function requireColumn(columns: ColumnMap, field: string, instance: string): PgColumn {
  const column = columns[field]

  if (!column) {
    throw exception(badRequest(instance, `Unknown field: ${field}`))
  }

  return column
}

/**
 * Fills in default operators for server-enforced base filters.
 */
export function normalizeBaseFilters(baseFilters?: CollectionBaseFilter[]): CollectionFilter[] | null {
  if (!baseFilters || baseFilters.length === 0) {
    return null
  }

  return baseFilters.map((filter) => Object.assign({ operator: filter.operator ?? 'eq' }, filter))
}

/**
 * Combines optional `where` fragments into one `and` clause.
 */
export function combineWhere(...parts: Array<SQL | undefined>): SQL | undefined {
  const clauses = parts.filter((part): part is SQL => part !== undefined)

  if (clauses.length === 0) {
    return undefined
  }

  if (clauses.length === 1) {
    return clauses[0]
  }

  return and(...clauses)
}

/**
 * Extracts the requested field names from the normalized field-selection shape.
 *
 * JSON:API-style selections may be keyed by resource type. When no resource
 * type is provided, the first field group is used to preserve the current
 * executor behavior.
 */
export function resolveSelectedFieldNames(
  selection: CollectionFieldSelection | null,
  resourceType?: string,
): string[] | null {
  if (!selection) {
    return null
  }

  if (selection.type === 'simple') {
    return selection.fields
  }

  const fields = resourceType
    ? selection.fields[resourceType]
    : Object.values(selection.fields)[0]

  return fields ?? null
}

/**
 * Builds the Drizzle select-shape for the requested field projection.
 *
 * The returned object is fed directly into `db.select(...)`, which keeps field
 * projection on Drizzle's builder surface instead of hand-assembling a raw SQL
 * column list.
 */
export function buildSelectColumns(
  columns: ColumnMap,
  selection: CollectionFieldSelection | null,
  instance: string,
  resourceType?: string,
): ColumnSelection {
  const selectedFields = resolveSelectedFieldNames(selection, resourceType)

  if (!selectedFields || selectedFields.length === 0) {
    return Object.assign({}, columns)
  }

  const selectedColumns: ColumnSelection = Object.create(null)

  for (const field of selectedFields) {
    selectedColumns[field] = requireColumn(columns, field, instance)
  }

  return selectedColumns
}

/**
 * Converts one normalized filter into a checked Drizzle condition.
 */
export function buildFilterCondition(column: PgColumn, filter: CollectionFilter, instance: string): SQL {
  switch (filter.operator) {
    case 'eq':
      return eq(column, filter.value)
    case 'ne':
      return ne(column, filter.value)
    case 'gt':
      return gt(column, filter.value)
    case 'gte':
      return gte(column, filter.value)
    case 'lt':
      return lt(column, filter.value)
    case 'lte':
      return lte(column, filter.value)
    case 'between': {
      const [min, max] = filter.value as [number | string, number | string]
      return and(gte(column, min), lte(column, max)) as SQL
    }
    case 'in': {
      const values = Array.isArray(filter.value)
        ? filter.value
        : String(filter.value).split(',').map((value) => value.trim())
      return inArray(column, values)
    }
    case 'nin': {
      const values = Array.isArray(filter.value)
        ? filter.value
        : String(filter.value).split(',').map((value) => value.trim())
      return notInArray(column, values)
    }
    case 'contains':
      return like(column, `%${String(filter.value)}%`)
    case 'icontains':
      return ilike(column, `%${String(filter.value)}%`)
    case 'startswith':
      return like(column, `${String(filter.value)}%`)
    case 'endswith':
      return like(column, `%${String(filter.value)}`)
    case 'is_null':
      return isNull(column)
    case 'is_not_null':
      return isNotNull(column)
    default: {
      const operator: never = filter.operator
      throw exception(badRequest(instance, `Unknown operator: ${operator}`))
    }
  }
}

/**
 * Builds a validated `where` clause from normalized filters.
 *
 * This helper is the point where string field names from the query spec are
 * resolved against real Drizzle columns. Unknown fields fail here so the rest
 * of the executor never needs to operate on unchecked identifiers.
 *
 * @example Common path
 * ```ts
 * const where = applyFilters(columns, [
 *   { field: 'email', operator: 'icontains', value: '@example.com' },
 *   { field: 'deleted_at', operator: 'is_null', value: null },
 * ])
 * ```
 *
 * @example Disabled filtering
 * ```ts
 * const where = applyFilters(columns, null)
 * // undefined
 * ```
 */
export function applyFilters(
  columns: ColumnMap,
  filters: CollectionFilter[] | null,
  instance: string = 'query',
): SQL | undefined {
  if (!filters || filters.length === 0) {
    return undefined
  }

  const clauses = filters.map((filter) => {
    const column = requireColumn(columns, filter.field, instance)
    return buildFilterCondition(column, filter, instance)
  })

  return combineWhere(...clauses)
}

/**
 * Builds Drizzle order expressions from normalized sort input.
 *
 * Sorting is resolved against the same checked column map used for filters so
 * callers cannot smuggle arbitrary SQL identifiers through query parameters.
 *
 * @example Common path
 * ```ts
 * const orderBy = applySorts(columns, [
 *   { field: 'created_at', direction: 'desc' },
 *   { field: 'id', direction: 'desc' },
 * ])
 * ```
 *
 * @example Disabled sorting
 * ```ts
 * const orderBy = applySorts(columns, null)
 * // []
 * ```
 */
export function applySorts(
  columns: ColumnMap,
  sorts: CollectionSort[] | null,
  instance: string = 'query',
): SQL[] {
  if (!sorts || sorts.length === 0) {
    return []
  }

  return sorts.map((sort) => {
    const column = requireColumn(columns, sort.field, instance)
    return sort.direction === 'asc' ? asc(column) : desc(column)
  })
}

/**
 * Builds the boundary clause for cursor-based pagination.
 *
 * Cursor pagination here means keyset pagination: instead of skipping a number
 * of rows, the query asks for rows that come strictly after a known boundary
 * row in the active sort order. That keeps deep pagination stable and avoids
 * the work that large offsets can force onto PostgreSQL.
 *
 * Read the boundary as two branches:
 *
 * ```text
 * cursor row
 * ├── rows with a smaller or larger primary sort value
 * └── rows with the same sort value but a smaller or larger tiebreaker
 * ```
 *
 * For a descending sort on `created_at, id`, a cursor like
 * `{ sortValue: 10:30, tiebreakerValue: 'b' }` means:
 *
 * ```text
 * keep rows where
 *   created_at < 10:30
 *   OR (created_at = 10:30 AND id < 'b')
 * ```
 *
 * The tiebreaker branch matters because many rows can share the same primary
 * sort value. Without it, rows could be skipped or repeated between pages.
 *
 * The exact comparison direction depends on whether the active sort is
 * ascending or descending.
 *
 * @example Descending cursor page
 * ```ts
 * const plan = applyCursorPagination(columns, {
 *   sortField: 'created_at',
 *   sortValue: '2026-04-05T12:00:00.000Z',
 *   tiebreaker: 'id',
 *   tiebreakerValue: 'user_123',
 *   direction: 'desc',
 * }, 20)
 * ```
 *
 * @example First cursor page without a decoded cursor
 * ```ts
 * const plan = applyPagination(columns, {
 *   type: 'cursor',
 *   limit: 20,
 *   cursor: null,
 *   decodedCursor: null,
 * })
 * // { limit: 21 }
 * ```
 */
export function applyCursorPagination(
  columns: ColumnMap,
  cursor: CollectionCursorData,
  limit: number,
  instance: string = 'query',
): PaginationPlan {
  const sortColumn = requireColumn(columns, cursor.sortField, instance)
  const tiebreakerColumn = requireColumn(columns, cursor.tiebreaker, instance)

  // Keyset pagination compares against the last visible row from the previous
  // page. The first branch advances by the primary sort column. The second
  // branch handles ties so pagination stays stable when several rows share the
  // same primary sort value.
  const boundary = cursor.direction === 'desc'
    ? or(
        lt(sortColumn, cursor.sortValue),
        and(eq(sortColumn, cursor.sortValue), lt(tiebreakerColumn, cursor.tiebreakerValue)),
      )
    : or(
        gt(sortColumn, cursor.sortValue),
        and(eq(sortColumn, cursor.sortValue), gt(tiebreakerColumn, cursor.tiebreakerValue)),
      )

  return {
    where: boundary,
    limit: limit + 1,
  }
}

/**
 * Builds offset-based pagination instructions.
 *
 * Offset pagination stays useful for simple back-office screens and for cases
 * where stable page numbers matter more than deep-scan efficiency.
 */
export function applyOffsetPagination(offset: number, limit: number): PaginationPlan {
  return { offset, limit }
}

/**
 * Chooses the correct pagination plan for a validated query spec.
 *
 * Cursor pagination reserves one extra row to compute `has_more`. Offset
 * pagination uses the requested limit directly.
 *
 * @example Offset pagination
 * ```ts
 * const plan = applyPagination(columns, {
 *   type: 'offset',
 *   offset: 40,
 *   limit: 20,
 * })
 * ```
 *
 * @example Cursor pagination with a decoded cursor
 * ```ts
 * const plan = applyPagination(columns, {
 *   type: 'cursor',
 *   cursor: 'opaque-token',
 *   decodedCursor,
 *   limit: 20,
 * })
 * ```
 */
export function applyPagination(
  columns: ColumnMap,
  params: CollectionPagination,
  instance: string = 'query',
): PaginationPlan {
  if (params.type === 'cursor') {
    if (params.decodedCursor) {
      return applyCursorPagination(columns, params.decodedCursor, params.limit, instance)
    }

    return { limit: params.limit + 1 }
  }

  return applyOffsetPagination(params.offset, params.limit)
}

/**
 * Converts a validated query spec into a SQL execution plan.
 *
 * This is the bridge between the transport-facing query-spec shape and the
 * concrete Drizzle expressions used by the database layer. Callers get one
 * place that resolves field names, sorting, and pagination into checked SQL.
 *
 * @example Common path
 * ```ts
 * const plan = applyQuerySpec('user', spec)
 * ```
 *
 * @example Relation-specific validation
 * ```ts
 * const plan = applyQuerySpec('organization', spec, 'organization.list')
 * ```
 */
export function applyQuerySpec<TRelation extends RelationName>(
  relation: TRelation,
  spec: CollectionQuerySpec,
  instance: string = 'query',
): QueryPlan {
  const columns = getColumnMap(relation)
  const filters = applyFilters(columns, spec.filters, instance)
  const pagination = applyPagination(columns, spec.pagination, instance)

  return {
    where: combineWhere(filters, pagination.where),
    orderBy: applySorts(columns, spec.sorts, instance),
    limit: pagination.limit,
    offset: pagination.offset,
  }
}

/**
 * Builds the main Drizzle row query for a collection request.
 *
 * The query stays on Drizzle's builder API for projection, filtering, sorting,
 * limits, and offsets. Raw SQL is reserved for PostgreSQL-specific count and
 * planner helpers that Drizzle does not model directly.
 *
 * This builder does not use `.$dynamic()` because each clause family is added
 * at most once inside this function. Drizzle's default select builder is
 * enough for this straight-line construction path.
 */
export function buildCollectionQuery(
  database: CollectionDatabase,
  relation: RelationName,
  selectedColumns: ColumnSelection,
  plan: QueryPlan,
) {
  const table = getRelationTable(relation)
  const baseQuery = database.select(selectedColumns).from(table)
  const filteredQuery = plan.where ? baseQuery.where(plan.where) : baseQuery
  const orderedQuery = plan.orderBy.length > 0 ? filteredQuery.orderBy(...plan.orderBy) : filteredQuery
  const limitedQuery = orderedQuery.limit(plan.limit)

  return typeof plan.offset === 'number' ? limitedQuery.offset(plan.offset) : limitedQuery
}

/**
 * Builds the exact-count query for a relation.
 *
 * This uses Drizzle's `count()` helper rather than a handwritten `count(*)`
 * statement so the common count path stays on the typed builder surface.
 * Like `buildCollectionQuery()`, it does not need `.$dynamic()` because the
 * builder is created and conditionally extended in one local control path.
 */
export function buildExactCountQuery(
  database: CollectionDatabase,
  relation: RelationName,
  where?: SQL,
) {
  const table = getRelationTable(relation)
  const baseQuery = database.select({ count: count() }).from(table)

  return where ? baseQuery.where(where) : baseQuery
}

/**
 * Builds the PostgreSQL planner query used for estimated filtered counts.
 *
 * Drizzle does not provide a higher-level abstraction for `EXPLAIN (FORMAT
 * JSON)`, so this remains a deliberate raw-SQL escape hatch.
 *
 * The planner path exists because exact `count(*)` can become the most
 * expensive part of a large filtered listing. `EXPLAIN` asks PostgreSQL for
 * the row count it expects to visit without executing the full count query.
 * That estimate is cheaper, but it is not exact.
 *
 * The interpolation here stays safe for two reasons:
 *
 * 1. `table` comes from the static Drizzle schema registry, not user input
 * 2. `where` is assembled from checked columns plus parameterized Drizzle
 *    values, so values are still bound instead of string-concatenated
 *
 * @example Planned count for a filtered listing
 * ```ts
 * const where = applyFilters(getColumnMap('user'), [
 *   { field: 'email', operator: 'icontains', value: '@example.com' },
 * ])
 * const query = buildPlannedCountQuery('user', where)
 * ```
 */
export function buildPlannedCountQuery(relation: RelationName, where?: SQL) {
  const table = getRelationTable(relation)

  return sql`
    explain (format json)
    select 1
    from ${table}
    ${where ? sql`where ${where}` : sql``}
  `
}

/**
 * Reads PostgreSQL's estimated row count from an `EXPLAIN (FORMAT JSON)` row.
 *
 * PostgreSQL returns the plan as JSON in the first selected column. Some
 * drivers return that JSON already parsed, while others return a string. This
 * helper normalizes both shapes and extracts `Plan Rows`, which is the planner
 * estimate used by `planned` counts.
 *
 * Returning `null` means the response shape was missing or unreadable, not
 * that PostgreSQL estimated zero rows.
 */
export function readExplainPlanRows(row: Record<string, unknown> | undefined): number | null {
  if (!row) {
    return null
  }

  const rawPlan = Object.values(row)[0]

  if (!rawPlan) {
    return null
  }

  let parsedPlan: unknown = rawPlan

  if (typeof rawPlan === 'string') {
    try {
      parsedPlan = JSON.parse(rawPlan)
    } catch {
      return null
    }
  }

  if (!Array.isArray(parsedPlan) || parsedPlan.length === 0) {
    return null
  }

  const firstPlan = parsedPlan[0] as { Plan?: Record<string, unknown> }
  const planRows = firstPlan.Plan?.['Plan Rows']

  if (typeof planRows === 'number') {
    return planRows
  }

  if (typeof planRows === 'string') {
    const parsedValue = Number(planRows)
    return Number.isFinite(parsedValue) ? parsedValue : null
  }

  return null
}

/**
 * Returns PostgreSQL's cheapest available estimate for the requested relation.
 *
 * Unfiltered queries use table statistics from `pg_class`. Filtered queries use
 * `EXPLAIN` so the estimate reflects the active predicates instead of the whole
 * table.
 *
 * Read the strategy split as:
 *
 * ```text
 * no filters     ─► use pg_class.reltuples
 * with filters   ─► use EXPLAIN plan rows
 * ```
 *
 * `reltuples` is cheap because it comes from PostgreSQL statistics rather than
 * scanning the table. That estimate becomes misleading once filters are added,
 * so filtered estimated counts fall back to the planner instead of pretending
 * raw table statistics still describe the filtered result set.
 */
export async function getEstimatedCount(
  database: CollectionDatabase,
  relation: RelationName,
  where?: SQL,
): Promise<number | null> {
  if (where) {
    const planResult = await database.execute<Record<string, unknown>>(buildPlannedCountQuery(relation, where))
    return readExplainPlanRows(planResult[0])
  }

  const relationName = getRelationSqlName(relation)

  const statsResult = await database.execute<{ estimate: number | null }>(sql`
    select cast(reltuples as integer) as estimate
    from pg_class
    where oid = to_regclass(${relationName})
  `)

  return statsResult[0]?.estimate ?? null
}

/**
 * Resolves the total-count metadata for one collection query.
 *
 * Strategy trade-offs:
 *
 * - `exact`: accurate, but can be the most expensive option on large filtered
 *   tables because PostgreSQL must execute the real count query
 * - `planned`: cheaper estimate from `EXPLAIN`, useful when UI only needs an
 *   approximate total for pagination chrome
 * - `estimated`: use the cheapest table-level estimate when unfiltered, then
 *   fall back to the planner once filters make table-wide statistics too blunt
 */
export async function getTotalCount(
  database: CollectionDatabase,
  relation: RelationName,
  strategy: NonNullable<CollectionQueryOptions['countStrategy']>,
  where?: SQL,
): Promise<number | null> {
  if (strategy === 'exact') {
    const countResult = await buildExactCountQuery(database, relation, where)
    return countResult[0]?.count ?? 0
  }

  if (strategy === 'planned') {
    const planResult = await database.execute<Record<string, unknown>>(buildPlannedCountQuery(relation, where))
    return readExplainPlanRows(planResult[0])
  }

  return getEstimatedCount(database, relation, where)
}

/**
 * Executes a validated collection query against the shared Drizzle database.
 *
 * This helper exists so service code can keep using the repo's normalized
 * query-spec contract while the storage layer moves away from Supabase and onto
 * Drizzle plus Postgres.js. It applies server-enforced base filters, resolves
 * caller filters and sorts against real schema columns, runs the query, and
 * optionally attaches count metadata.
 *
 * @example Common path
 * ```ts
 * const result = await executeCollectionQuery(database, 'user', spec)
 * ```
 *
 * @example Tenant-scoped query with count metadata
 * ```ts
 * const result = await executeCollectionQuery(database, 'organization', spec, {
 *   includeCount: true,
 *   countStrategy: 'planned',
 *   baseFilters: [
 *     { field: 'owner_id', operator: 'eq', value: currentUserId },
 *   ],
 * })
 * ```
 */
export async function executeCollectionQuery<TRelation extends RelationName>(
  database: CollectionDatabase,
  relation: TRelation,
  spec: CollectionQuerySpec,
  options?: CollectionQueryOptions,
): Promise<CollectionQueryResult> {
  const {
    includeCount = false,
    countStrategy = 'exact',
    baseFilters,
  } = options ?? {}

  try {
    const columns = getColumnMap(relation)
    const baseWhere = applyFilters(columns, normalizeBaseFilters(baseFilters), relation)
    const specPlan = applyQuerySpec(relation, spec, relation)
    const plan: QueryPlan = {
      where: combineWhere(baseWhere, specPlan.where),
      orderBy: specPlan.orderBy,
      limit: specPlan.limit,
      offset: specPlan.offset,
    }

    const selectedColumns = buildSelectColumns(columns, spec.fields, relation)
    const rows = await buildCollectionQuery(database, relation, selectedColumns, plan) as RelationRow[]
    const total = includeCount
      ? await getTotalCount(database, relation, countStrategy, plan.where)
      : null

    return ok(rows as RelationRow[], 200, { total })
  } catch (error) {
    return internalServerError(
      'database',
      error instanceof Error ? error.message : 'Unknown database error',
    )
  }
}

/**
 * Executes a collection query without total-count metadata.
 *
 * Use this when the caller only needs the current page of rows and does not
 * need a total for UI pagination chrome.
 *
 * @example Common path
 * ```ts
 * const result = await queryCollection(database, 'user', spec)
 * ```
 *
 * @example Server-enforced scoping
 * ```ts
 * const result = await queryCollection(database, 'member', spec, [
 *   { field: 'organization_id', operator: 'eq', value: organizationId },
 * ])
 * ```
 */
export function queryCollection<TRelation extends RelationName>(
  database: CollectionDatabase,
  relation: TRelation,
  spec: CollectionQuerySpec,
  baseFilters?: CollectionQueryOptions['baseFilters'],
): Promise<CollectionQueryResult> {
  return executeCollectionQuery(database, relation, spec, {
    includeCount: false,
    baseFilters,
  })
}

/**
 * Executes a collection query and attaches total-count metadata.
 *
 * This wrapper keeps the common counted-query call site compact while still
 * making the caller choose the count trade-off explicitly.
 *
 * @example Exact count for small result sets
 * ```ts
 * const result = await queryCollectionWithCount({
 *   database,
 *   table: 'user',
 *   spec,
 *   countStrategy: 'exact',
 * })
 * ```
 *
 * @example Planned count for large filtered listings
 * ```ts
 * const result = await queryCollectionWithCount({
 *   database,
 *   table: 'organization',
 *   spec,
 *   countStrategy: 'planned',
 *   baseFilters: [
 *     { field: 'owner_id', operator: 'eq', value: currentUserId },
 *   ],
 * })
 * ```
 */
export function queryCollectionWithCount<TRelation extends RelationName>(opts: {
  /**
   * Shared Drizzle database connection.
   */
  database: CollectionDatabase

  /**
   * Relation to query from the supported table registry.
   */
  table: TRelation

  /**
   * Validated transport-level query spec.
   */
  spec: CollectionQuerySpec

  /**
   * Count strategy to apply for this request.
   */
  countStrategy: 'exact' | 'planned' | 'estimated'

  /**
   * Optional server-enforced filters that run before user filters.
   */
  baseFilters?: CollectionQueryOptions['baseFilters']
}): Promise<CollectionQueryResult> {
  const { database, table, spec, countStrategy = 'exact', baseFilters } = opts

  return executeCollectionQuery(database, table, spec, {
    includeCount: true,
    countStrategy,
    baseFilters,
  })
}