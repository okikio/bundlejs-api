// utils/query/types.ts
/**
 * Core types and schemas for query processing
 * 
 * Provides:
 * - Registry schemas for allowlists and validation
 * - Normalized intermediary schemas
 * - Zod schemas for all query features
 * - QuerySpecSchema now has nullable filters and sorts for disable functionality
 * - EndpointQueryConfig gains disableFiltering, disableSorting, disableFields flags
 */

import { z } from 'zod'
import type { ValidationErrorDetail } from '@utils/response/schemas'
import { LinkMapSchema, PaginationSchema } from '@utils/response/schemas'

// Re-export for convenience
export type { ValidationErrorDetail }

// ---------------------------------------------
// Shared primitives
// ---------------------------------------------

export const NonEmptyStringSchema = z.string().trim().min(1, 'Value cannot be empty')

// ============================================================================
// FILTER SCHEMAS
// ============================================================================

/**
 * Canonical filter operators accepted by the query layer.
 *
 * Keeping the allowed values in one exported constant lets validators,
 * adapters, execution helpers, and docs all point at the same source of truth.
 */
export const FILTER_OPERATORS = [
  'eq', 'ne',
  'gt', 'gte',
  'lt', 'lte',
  'between',
  'in', 'nin',
  'contains', 'icontains',
  'startswith', 'endswith',
  'is_null', 'is_not_null'
] as const

/**
 * One allowed filter operator name.
 */
export type FilterOperator = typeof FILTER_OPERATORS[number]

/**
 * Available filter operators.
 */
export const FilterOperatorSchema = z.enum(FILTER_OPERATORS)

/**
 * Normalized filter schema.
 */
export const FilterNormalizedSchema = z.object({
  field: NonEmptyStringSchema,
  operator: FilterOperatorSchema,
  value: z.unknown().optional()
})

/**
 * Normalized caller-provided filter inferred from the schema.
 */
export type FilterNormalized = z.output<typeof FilterNormalizedSchema>

/**
 * Array of normalized filters
 */
export const FiltersNormalizedSchema = z.array(FilterNormalizedSchema)

/**
 * Ordered list of normalized caller-provided filters inferred from the schema.
 */
export type FiltersNormalized = z.output<typeof FiltersNormalizedSchema>

/**
 * Normalized base-filter schema.
 */
export const BaseFilterNormalizedSchema = z.object({
  field: NonEmptyStringSchema,
  operator: FilterOperatorSchema.optional(),
  value: z.unknown().optional()
})

/**
 * Normalized server-enforced filter inferred from the schema.
 */
export type BaseFilterNormalized = z.output<typeof BaseFilterNormalizedSchema>

/**
 * Array of normalized filters
 */
export const BaseFiltersNormalizedSchema = z.array(BaseFilterNormalizedSchema)

/**
 * Ordered list of normalized base filters inferred from the schema.
 */
export type BaseFiltersNormalized = z.output<typeof BaseFiltersNormalizedSchema>

/**
 * `OperatorDefinitionSchema`
 *
 * Describes *per-field* filtering rules:
 * - `operators`: which operators are allowed for this field (allowlist).
 * - `type`: the scalar type used for value coercion (`string|number|boolean|date|enum|uuid`).
 * - `values` (optional): enum allowlist for `type: 'enum'`.
 * - `arrayOperators` (optional): which operators for this field *expect arrays*.
 *
 * Why `arrayOperators`?
 * - Avoids hardcoding that `'in'`/`'nin'` (or future operators like `between`, `overlaps`, geo/json operators)
 *   always consume lists. Instead, each field opts into multi-value semantics explicitly, enabling
 *   field-specific policy, schema-driven validation, and accurate auto-docs/UI hints. 
 *
 * How it interacts with URLs:
 * - Bracket notation clients send comma-separated values (e.g., `filter[tag][in]=a,b,c`), which the validator
 *   converts to arrays *only if* the field’s `arrayOperators` includes that operator. JSON clients send arrays
 *   directly for `value`. Either way, normalization ends at the same `FiltersNormalized` shape. 
 */
export const OperatorDefinitionSchema = z.object({
  operators: z.array(FilterOperatorSchema).min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'enum', 'uuid']),
  values: z.array(z.string()).optional(), // For enum types
  arrayOperators: z.array(FilterOperatorSchema).optional() // Operators that require arrays
})

/**
 * See {@link OperatorDefinitionSchema} for full schema details.
 */
export type OperatorDefinition = z.output<typeof OperatorDefinitionSchema>

/**
 * Filter registry for a resource
 */
export const FilterRegistrySchema = z.record(
  z.string(),
  OperatorDefinitionSchema
)

export type FilterRegistry = z.output<typeof FilterRegistrySchema>

// ============================================================================
// SORT SCHEMAS
// ============================================================================

/**
 * Canonical sort directions accepted by the query layer.
 */
export const SORT_DIRECTIONS = ['asc', 'desc'] as const

/**
 * One allowed sort direction.
 */
export type SortDirection = typeof SORT_DIRECTIONS[number]

/**
 * Sort direction schema.
 */
export const SortDirectionSchema = z.enum(SORT_DIRECTIONS)

/**
 * Normalized sort schema.
 */
export const SortNormalizedSchema = z.object({
  field: NonEmptyStringSchema,
  direction: SortDirectionSchema,
  tiebreaker: z.boolean().default(false)
})

/**
 * Normalized sort instruction inferred from the schema.
 */
export type SortNormalized = z.output<typeof SortNormalizedSchema>

/**
 * Array of normalized sorts
 */
export const SortsNormalizedSchema = z.array(SortNormalizedSchema)

/**
 * Ordered list of normalized sort instructions inferred from the schema.
 */
export type SortsNormalized = z.output<typeof SortsNormalizedSchema>

// ============================================================================
// FIELD SELECTION SCHEMAS
// ============================================================================

/**
 * Simple field-selection schema.
 */
export const SimpleFieldSelectionSchema = z.object({
  type: z.literal('simple'),
  fields: z.array(NonEmptyStringSchema).min(1)
})

/**
 * Simple `fields=a,b,c` field selection inferred from the schema.
 */
export type SimpleFieldSelection = z.output<typeof SimpleFieldSelectionSchema>

/**
 * JSON:API field-selection schema.
 */
export const JsonApiFieldSelectionSchema = z.object({
  type: z.literal('jsonapi'),
  fields: z.record(z.string(), z.array(NonEmptyStringSchema))
})

/**
 * JSON:API-style field selection inferred from the schema.
 */
export type JsonApiFieldSelection = z.output<typeof JsonApiFieldSelectionSchema>

/**
 * Normalized field selection (output from adapters)
 */
export const FieldSelectionNormalizedSchema = z.discriminatedUnion('type', [
  SimpleFieldSelectionSchema,
  JsonApiFieldSelectionSchema
])

/**
 * Supported normalized field-selection shapes inferred from the schema.
 */
export type FieldSelectionNormalized = z.output<typeof FieldSelectionNormalizedSchema>

// ============================================================================
// PAGINATION SCHEMAS
// ============================================================================

/**
 * Cursor payload schema.
 */
export const CursorDataSchema = z.object({
  /** Column name used for primary sort (e.g., 'created_at', 'score') */
  sortField: NonEmptyStringSchema,
  /** Value of sortField from the boundary row */
  sortValue: z.union([
    z.string(),
    z.number(),
    z.coerce.date()
  ]),
  /** Column name used for tiebreaker (usually 'id') */
  tiebreaker: z.string(),
  /** Value of tiebreaker from the boundary row */
  tiebreakerValue: z.union([z.string(), z.number()]),
  /** Sort direction for this cursor */
  direction: SortDirectionSchema,
  /** When this cursor was created (for TTL expiration) */
  createdAt: z.coerce.date()
})

/**
 * Decoded cursor payload inferred from the schema.
 */
export type CursorData = z.output<typeof CursorDataSchema>

export const OffsetPaginationNormalizedSchema = z.object({
  type: z.literal('offset'),
  offset: z.number().int().min(0),
  limit: z.number().int().positive(),
})

/**
 * Offset pagination inferred from the schema.
 */
export type OffsetPaginationNormalized = z.output<typeof OffsetPaginationNormalizedSchema>

export const CursorPaginationNormalizedSchema = z.object({
  type: z.literal('cursor'),
  limit: z.number().int().positive(),
  /** Raw cursor token (before decoding) */
  cursor: NonEmptyStringSchema.optional(),
  /** Decoded and verified cursor data (populated during validation, not parsing) */
  decodedCursor: CursorDataSchema.optional(),
})

/**
 * Cursor pagination inferred from the schema.
 */
export type CursorPaginationNormalized = z.output<typeof CursorPaginationNormalizedSchema>

/**
 * Normalized pagination (union)
 */
export const PaginationNormalizedSchema = z.discriminatedUnion('type', [
  OffsetPaginationNormalizedSchema,
  CursorPaginationNormalizedSchema
])

/**
 * Supported normalized pagination shapes inferred from the schema.
 */
export type PaginationNormalized = z.output<typeof PaginationNormalizedSchema>

// ============================================================================
// QUERY SPEC SCHEMA
// ============================================================================

/**
 * Pagination configuration
 * 
 * All options for pagination in one place
 */
export const PaginationConfigSchema = z.object({
  limits: z.object({
    minLimit: z.number().int().positive().default(1),
    maxLimit: z.number().int().positive().default(100),
    defaultLimit: z.number().int().positive().default(20),
    maxOffset: z.number().int().positive().default(1_000_000),
    cursorTTL: z.number().int().positive().default(86400), // 24 hours
  }).default({
    minLimit: 1,
    maxLimit: 100,
    defaultLimit: 20,
    maxOffset: 1_000_000,
    cursorTTL: 86400
  }),
  cursorSecret: z.string().optional(),
})

/**
 * Caller-facing pagination config input inferred from the schema.
 */
export type PaginationConfig = z.input<typeof PaginationConfigSchema>

/**
 * Resolved pagination config after schema defaults are applied.
 */
export type ResolvedPaginationConfig = z.output<typeof PaginationConfigSchema>

/**
 * Filters configuration
 * 
 * All options for filtering in one place
 */
export const FiltersConfigSchema = z.object({
  registry: FilterRegistrySchema.optional(),
  defaults: FiltersNormalizedSchema.optional(),
  mergeDefaults: z.boolean().default(true),
  disabled: z.boolean().default(false),
  limits: z.object({
    maxFilters: z.number().int().positive().default(20),
  }).default({ maxFilters: 20 }),
})

export type FiltersConfig = z.input<typeof FiltersConfigSchema>

/**
 * Resolved filters config after schema defaults are applied.
 */
export type ResolvedFiltersConfig = z.output<typeof FiltersConfigSchema>

/**
 * Sorts configuration
 * 
 * All options for sorting in one place
 */
export const SortsConfigSchema = z.object({
  tiebreaker: z.string().default('id'),
  allowedFields: z.array(z.string()).optional(),
  mergeDefaults: z.boolean().default(true),
  defaults: SortsNormalizedSchema.optional(),
  disabled: z.boolean().default(false),
  limits: z.object({
    maxSorts: z.number().int().positive().default(5),
  }).default({ maxSorts: 5 }),
})

export type SortsConfig = z.input<typeof SortsConfigSchema>

/**
 * Resolved sorts config after schema defaults are applied.
 */
export type ResolvedSortsConfig = z.output<typeof SortsConfigSchema>

/**
 * Fields configuration
 * 
 * All options for field selection in one place
 */
export const FieldsConfigSchema = z.object({
  allowedFields: z.array(z.string()).optional(),
  defaults: z.array(z.string()).optional(),
  disabled: z.boolean().default(false),
  resourceType: z.string().optional(), // For JSON:API format
}).default({ disabled: false })

export type FieldsConfig = z.input<typeof FieldsConfigSchema>

/**
 * Resolved fields config after schema defaults are applied.
 */
export type ResolvedFieldsConfig = z.output<typeof FieldsConfigSchema>

/**
 * Complete query specification (output from composite schema)
 * 
 * This is the normalized, validated output that contains all query parameters
 * ready to be applied to a database query.
 */
export const QuerySpecSchema = z.object({
  pagination: PaginationNormalizedSchema,
  filters: FiltersNormalizedSchema.nullable(),
  sorts: SortsNormalizedSchema.nullable(),
  fields: FieldSelectionNormalizedSchema.nullable(),
})

/**
 * Fully normalized validated query specification inferred from the schema.
 */
export type QuerySpec = z.output<typeof QuerySpecSchema>

/**
 * Query-aware pagination metadata for handlers that want to echo back the
 * normalized query spec alongside the paginated response metadata.
 *
 * `@utils/response` owns the generic pagination envelope. This query-specific
 * extension lives here so the response package stays a leaf dependency.
 *
 * @example Common path
 * ```ts
 * const meta = QueryPaginationMetadataSchema.parse({
 *   pagination: { hasMore: true, limit: 20, count: 20 },
 *   query: spec,
 * })
 * ```
 *
 * @example With response links added later by the response helper
 * ```ts
 * const meta = QueryPaginationMetadataSchema.parse({
 *   pagination: { hasMore: false, limit: 20, count: 12 },
 *   query: spec,
 *   links: { self: '/users?limit=20' },
 * })
 * ```
 */
export const QueryPaginationMetadataSchema = z.object({
  pagination: PaginationSchema,
  links: LinkMapSchema.optional(),
  query: QuerySpecSchema.optional(),
}).catchall(z.unknown())

/**
 * Query-aware pagination metadata inferred from the Zod schema.
 */
export type QueryPaginationMetadata = z.output<typeof QueryPaginationMetadataSchema>

// ============================================================================
// ENDPOINT CONFIGURATION (UPDATED)
// ============================================================================

/**
 * Endpoint query configuration
 * 
 * FIXED: All component configs are optional and have sensible defaults
 * TypeScript types are clean (no | undefined noise)
 * 
 * @example
 * ```typescript
 * // Minimal config
 * const config = {
 *   tiebreaker: 'id'
 * }
 * 
 * // Full config
 * const config = {
 *   tiebreaker: 'id',
 *   pagination: {
 *     limits: { defaultLimit: 50, maxLimit: 100 },
 *     cursorSecret: CURSOR_SECRET
 *   },
 *   filters: {
 *     registry: { ...  },
 *     defaults: [ ... ],
 *     mergeDefaults: true,
 *     disabled: false,
 *     limits: { maxFilters: 10 }
 *   },
 *   sorts: {
 *     allowedFields: ['created_at', 'id'],
 *     defaults: [ ... ],
 *     disabled: false,
 *     limits: { maxSorts: 3 }
 *   },
 *   fields: {
 *     allowedFields: ['id', 'title'],
 *     defaults: ['id'],
 *     disabled: false
 *   }
 * }
 * ```
 */
export const EndpointQueryConfigSchema = z.object({
  pagination: PaginationConfigSchema,
  filters: FiltersConfigSchema,
  sorts: SortsConfigSchema,
  fields: FieldsConfigSchema,
})

export type EndpointQueryConfig = z.input<typeof EndpointQueryConfigSchema>

/**
 * Resolved endpoint query config after schema defaults are applied.
 */
export type ResolvedEndpointQueryConfig = z.output<typeof EndpointQueryConfigSchema>