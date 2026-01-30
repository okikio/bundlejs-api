// utils/query/sorting.ts
/**
 * Query sorting with multi-source support and validation
 * 
 * Features:
 * - Explicit direction: sort=field:direction,field:direction
 * - Field allowlists via registry
 * - Max sort count (DoS protection)
 * - Always adds tiebreaker for deterministic ordering
 * - Query/JSON/FormData source adapters
 */

import { z } from 'zod'

import { BaseQuerySchema, BaseJsonSchema, BaseFormSchema, ZStringOrStringArray } from '../server/schemas.ts'
import {
  SortsNormalizedSchema,
  type SortNormalized,
  type SortsNormalized,
  type SortDirection,
  type SortsConfig,
} from './schemas.ts'

// ============================================================================
// WIRE SCHEMAS (raw incoming data)
// ============================================================================

/**
 * Query parameter wire schema (raw incoming)
 * Supports: ?sort=created_at:desc,id:asc
 */
export const SortsQueryWire = BaseQuerySchema.extend({
  sort: ZStringOrStringArray.optional()
})

/**
 * JSON body wire schema (raw incoming)
 * Expects: { sorts: [{ field: 'created_at', direction: 'desc' }] }
 */
export const SortsJsonWire = BaseJsonSchema.pipe(
  z.object({ sorts: SortsNormalizedSchema.default([]) })
)

/**
 * FormData wire schema (raw incoming)
 */
export const SortsFormWire = BaseFormSchema

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse colon syntax from string
 * Syntax: created_at:desc,id:asc
 */
function parseColonSyntax(data: string | undefined): SortsNormalized {
  if (typeof data !== 'string' || !data?.trim()) return []

  const sorts: SortNormalized[] = []
  const segments = data.split(',').map(s => s.trim()).filter(Boolean)

  for (const segment of segments) {
    const [fieldRaw, dirRaw] = segment.split(':')
    const field = (fieldRaw ?? '').trim()
    const direction = (dirRaw ?? 'asc').trim().toLowerCase()

    if (!field) continue;
    if (direction !== 'asc' && direction !== 'desc') continue;

    sorts.push({
      field: field,
      direction: direction as SortDirection,
      tiebreaker: false,
    })
  }

  return sorts
}

/**
 * Encode sorts back to colon syntax
 * Used for round-trip testing
 */
function encodeColonSyntax(sorts: SortsNormalized): string {
  return sorts
    .filter(s => !s.tiebreaker) // Don't encode tiebreakers (they're added by schema)
    .map(s => `${s.field}:${s.direction}`)
    .join(',')
}

// ============================================================================
// SOURCE ADAPTERS (unidirectional - decode only)
// ============================================================================

/**
 * Query parameter adapter (codec for round-trip testing)
 * Supports: ?sort=created_at:desc,id:asc
 * 
 * @example
 * const adapter = createSortsQueryAdapter()
 * 
 * // Decode
 * const normalized = adapter.decode({ sort: 'created_at:desc,id:asc' })
 * // => [{ field: 'created_at', direction: 'desc' }, { field: 'id', direction: 'asc' }]
 * 
 * // Encode (for testing)
 * const wire = adapter.encode(normalized)
 * // => { sort: 'created_at:desc,id:asc' }
 */
export function createSortsQueryAdapter() {
  return z.codec(
    SortsQueryWire,
    SortsNormalizedSchema,
    {
      decode: (query): SortsNormalized => {
        // Extract sort value (handle ZStringOrStringArray)
        const raw = Array.isArray(query.sort) ? query.sort[0] : query.sort
        return raw ? parseColonSyntax(raw) : []
      },
      encode: (sorts): z.input<typeof SortsQueryWire> => {
        const normalized = SortsNormalizedSchema.parse(sorts);
        const encoded = encodeColonSyntax(normalized)
        return encoded ? { sort: encoded } : {}
      }
    }
  )
}

/**
 * JSON body adapter (codec for round-trip testing)
 * Expects: { sorts: [{ field: 'created_at', direction: 'desc' }] }
 * 
 * @example
 * const adapter = createSortsJsonAdapter()
 * const normalized = adapter.decode({ 
 *   sorts: [{ field: 'created_at', direction: 'desc' }] 
 * })
 */
export function createSortsJsonAdapter() {
  return z.codec(
    SortsJsonWire,
    SortsNormalizedSchema,
    {
      decode: (raw): SortsNormalized => {
        return raw.sorts as SortsNormalized
      },
      encode: (sorts): z.input<typeof SortsJsonWire> => {
        return { sorts: sorts }
      }
    }
  )
}

/**
 * FormData adapter (codec for round-trip testing)
 * Supports: sort=created_at:desc,id:asc
 * 
 * @example
 * const adapter = createSortsFormAdapter()
 * const formData = new FormData()
 * formData.append('sort', 'created_at:desc,id:asc')
 * const normalized = adapter.decode(formData)
 */
export function createSortsFormAdapter() {
  return z.codec(
    SortsFormWire,
    SortsNormalizedSchema,
    {
      decode: (raw): SortsNormalized => {
        const sortValue = raw.sort
        if (!sortValue) return []
        
        const sortStr = Array.isArray(sortValue) 
          ? String(sortValue[0])
          : String(sortValue)
        
        return parseColonSyntax(sortStr)
      },
      encode: (sorts): z.input<typeof SortsFormWire> => {
        const normalized = SortsNormalizedSchema.parse(sorts);
        const encoded = encodeColonSyntax(normalized)
        return encoded ? { sort: encoded } : {}
      }
    }
  )
}

// ============================================================================
// SCHEMA COMPOSITION WITH VALIDATION
// ============================================================================

/**
 * Create endpoint-specific sorts schema with validation
 * 
 * Note: This schema is unidirectional (decode only) because it adds
 * non-reversible transformations (defaults, tiebreakers). Use the
 * adapters directly for round-trip testing.
 * 
 * @param config Configuration for sorts validation
 * @param config.source Input source type ('query' | 'json' | 'form')
 * @param config.allowedFields Array of sortable field names (allowlist)
 * @param config.limits Optional limits configuration (maxSorts)
 * @param config.tiebreaker Field to use as tiebreaker (default: 'id')
 * @param config.defaults Default sort when none provided
 * 
 * @example
 * const schema = createSortsSchema({
 *   source: 'query',
 *   allowedFields: ['created_at', 'title', 'id'],
 *   limits: { maxSorts: 3 },
 *   tiebreaker: 'id',
 *   defaults: [{ field: 'created_at', direction: 'desc' }]
 * })
 * 
 * // Parse and validate
 * const sorts = schema.parse({ sort: 'created_at:desc' })
 * // => [{ field: 'created_at', direction: 'desc' }, { field: 'id', direction: 'asc', tiebreaker: true }]
 */
export function createSortsSchema(config: {
  source: 'query' | 'json' | 'form'
} & SortsConfig) {
  const adapter =
    config.source === 'query' ? createSortsQueryAdapter() :
    config.source === 'json' ? createSortsJsonAdapter() :
    createSortsFormAdapter()
  
  if (config.disabled) {
    return adapter.transform(() => null)
  }

  const allowSet = new Set(config.allowedFields)
  const maxSorts = config.limits?.maxSorts ?? 5
  const tiebreaker = config.tiebreaker ?? 'id'

  return adapter
    // Step 1: Apply defaults
    .transform((sorts) => {
      // Use default if no sorts provided
      if (sorts.length === 0 && config.defaults) {
        return config.defaults
      }

      // Merge defaults if enabled
      if (config.mergeDefaults && config.defaults) {
        const defaultSorts = config.defaults.filter(
          def => !sorts.some(s => s.field === def.field)
        )
        return [...defaultSorts, ...sorts]
      }

      return sorts
    })

    // Step 2: Validate
    .check((ctx) => {
      const sorts = ctx.value

      // Check sort count before adding tiebreaker (DoS protection)
      if (sorts.length > maxSorts) {
        ctx.issues.push({
          code: "too_big",
          maximum: maxSorts,
          origin: 'array',
          path: [],
          message: `Too many sorts: max ${maxSorts}, got ${sorts.length}`,
          input: sorts
        })
        return // Don't continue
      }

      // Validate allowed fields
      if (allowSet.size > 0) {
        sorts.forEach((sort, idx) => {
          if (!allowSet.has(sort.field)) {
            ctx.issues.push({
              code: "custom",
              path: [idx, 'field'],
              message: `Field '${sort.field}' is not sortable. Allowed fields: ${config.allowedFields!.join(', ')}`,
              input: sorts
            })
          }
        })
      }
    })
    
    // Step 3: Add tiebreaker
    .transform((sorts): SortsNormalized => {
      // Mark existing tiebreaker field
      const withTiebreaker = sorts.map(s => ({
        ...s,
        tiebreaker: s.field === tiebreaker
      }))

      // Add tiebreaker if not already present
      const hasTiebreaker = withTiebreaker.some(s => s.tiebreaker)
      if (!hasTiebreaker) {
        withTiebreaker.push({ 
          field: tiebreaker, 
          direction: 'asc' as SortDirection, 
          tiebreaker: true 
        })
      }

      return withTiebreaker
    })
}
