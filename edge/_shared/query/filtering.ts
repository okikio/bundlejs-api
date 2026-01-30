// utils/query/filtering.ts

/**
 * Query Filtering — URL shapes, parsing, validation, and why `arrayOperators` exist.
 *
 * ## The two client-facing representations
 *
 * 1) **Bracket notation (URL-friendly; recommended for GET)**
 *    Structure: `filter[<field>][<operator>]=<value>`
 *
 *    - Operator is optional; missing operator implies `eq`.
 *      Example:
 *      `/api/posts?filter[status]=published`
 *      → `status eq 'published'` (operator defaults to `eq`). 
 *
 *    - Multiple filters AND together:
 *      `/api/products?filter[category]=electronics&filter[price][gte]=50&filter[price][lte]=200`
 *      → `category = 'electronics' AND price >= 50 AND price <= 200`.
 *
 *    - Null checks use keywords (not booleans):
 *      `/api/posts?filter[deleted_at]=null`     → `IS NULL`
 *      `/api/posts?filter[published_at]=not_null` → `IS NOT NULL`. 
 *
 *    - Set operators use comma-separated lists in the URL:
 *      `/api/issues?filter[status][in]=open,in_review,blocked`
 *      `/api/issues?filter[status][nin]=wontfix,duplicate`. 
 *
 *    Parsing flow:
 *    - `parseBracketNotation(...)` walks query keys with `/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/`,
 *      extracts `{ field, operator? }`, defaults operator to `eq`, and turns `null` / `not_null`
 *      into `is_null` / `is_not_null`. The rest pass through as `{ field, operator, value }`.
 *      This produces a `FiltersNormalized[]` array for downstream validation. 
 *
 * 2) **Structured JSON filters (body POST/PUT), or URL-encoded JSON as a single param**
 *    Shape:
 *    ```json
 *    { "filters": [
 *        { "field": "category", "operator": "eq", "value": "electronics" },
 *        { "field": "price",    "operator": "gte","value": "50" }
 *      ] }
 *    ```
 *    - Use `createFiltersJsonAdapter()` to parse the request body into `FiltersNormalized`.
 *      If you must keep GET-only, you *may* URL-encode the JSON into a single `filters` param
 *      and parse it prior to validation, then feed this same adapter. 
 *
 * ## Where `arrayOperators` matter
 *
 * - Instead of hardcoding that `'in'`/`'nin'` always expect arrays, each field's registry entry
 *   can *declare* which operators consume arrays via `arrayOperators`. This allows per-field policy
 *   (e.g., `status` allows `in`; `title` does not), and future operators like `between`, `overlaps`,
 *   or geo/json containment to be opt-in for the fields that support them. 
 *
 * - In bracket notation, clients still send comma-separated lists; validation reads the registry
 *   to decide whether to split/coerce into arrays. In JSON, clients send actual arrays for `value`.
 *   Either way, we normalize to the *same* `FiltersNormalized` shape. 
 *
 * ## Validation layer (what this module enforces)
 *
 * - **Allowlist fields & operators per resource**: We require a `FilterRegistry` describing
 *   what's filterable and with which operators, including the expected scalar type (string/number/
 *   boolean/date/enum/uuid) and allowed enum values. 
 *
 * - **Type-aware coercion**: The validator converts values based on the field type and operator:
 *   - numbers for `gt/gte/lt/lte/eq/ne` (rejects NaN),
 *   - booleans for `eq/ne`,
 *   - dates to ISO strings for `gt/gte/lt/lte/eq/ne` (rejects invalid dates),
 *   - enum membership checks,
 *   - UUID format checks, etc. 
 *
 * - **Null operators** never require a `value` (`is_null`, `is_not_null`). 
 *
 * - **Array operators** (as declared per field) require arrays; URL commas split into arrays.
 *   (We also recommend adding per-endpoint caps on list lengths via `LimitsConfig` to avoid abuse.) 
 *
 * - **DoS protection**: We cap the **number of filters** per request (default 20; configurable)
 *   and fail fast if exceeded. 
 *
 * ## Security & performance notes
 *
 * - **Security**: Always allowlist fields/operators and type-check values before building queries.
 *   Don't ever string-concatenate SQL; use parameterized calls. 
 *
 * - **Performance**: Index columns you filter/sort on; prefer compound indexes that align to
 *   common filter+sort patterns. This is especially important for high-cardinality fields and
 *   for cursor-based pagination where tiebreakers (e.g., `created_at,id`) must be indexed. 
 *
 * ## Worked examples (URL)
 *
 * - Equality (implicit operator):
 *   `/api/posts?filter[status]=published` → `{ field:'status', operator:'eq', value:'published' }` 
 *
 * - Ranged price:
 *   `/api/products?filter[price][gte]=50&filter[price][lte]=200` → two normalized filters; numbers coerced. 
 *
 * - Null checks:
 *   `/api/posts?filter[deleted_at]=null&filter[published_at]=not_null` → `is_null` / `is_not_null` (no values).
 *
 * - Set membership (array operator via registry):
 *   `/api/issues?filter[status][in]=open,in_review,blocked`
 *   → value coerced to `['open','in_review','blocked']` when `status` declares `in` under `arrayOperators`. 
 *
 * ## Worked examples (JSON)
 *
 * ```json
 * { 
 *   "filters": [
 *     { "field": "category", "operator": "eq", "value": "electronics" },
 *     { "field": "price", "operator": "gte", "value": "50" },
 *     { "field": "status", "operator": "in", "value": ["open","in_review","blocked"] }
 *   ]
 * }
 * ```
 * - Parsed via `createFiltersJsonAdapter()` into the same `FiltersNormalized[]`; array handling
 *   and type coercion follow the registry+validation rules above. 
 *
 * ---
 * 
 * Implementation notes:
 * - The adapters (`createFiltersQueryAdapter`, `createFiltersJsonAdapter`, `createFiltersFormAdapter`)
 *   only handle source parsing: they normalize different input formats (query strings, JSON bodies, form data)
 *   into a consistent internal shape.
 *
 * - The actual business rules live in `createFiltersSchema(...).check(...)`:
 *   • Enforce allowlists (only certain fields/operators allowed)
 *   • Match operators to correct value types
 *   • Split arrays consistently (e.g. "a,b,c" → ["a","b","c"])
 *   • Apply caps/limits (e.g. max filters)
 *
 * - This separation keeps parsing concerns **independent from** validation rules,
 *   making the system easier to extend and reason about. 
 */

import { z } from 'zod'

import { BaseQuerySchema, BaseJsonSchema, BaseFormSchema } from '#shared/server/schemas.ts'
import {
  FiltersNormalizedSchema,
  type FilterNormalized,
  type FiltersNormalized,
  type FilterOperator,
  type FilterRegistry,
  type FiltersConfig,
} from './schemas.ts'

// ============================================================================
// WIRE SCHEMAS (raw incoming data)
// ============================================================================

/**
 * Query parameter wire schema (raw incoming)
 * Supports: ?filter[category][eq]=electronics&filter[price][gte]=50
 */
export const FiltersQueryWire = BaseQuerySchema

/**
 * JSON body wire schema (raw incoming)
 * Expects: { filters: [{ field: 'category', operator: 'eq', value: 'electronics' }] }
 */
export const FiltersJsonWire = BaseJsonSchema.pipe(
  z.object({
    filters: FiltersNormalizedSchema.default([])
  })
)

/**
 * FormData wire schema (raw incoming)
 */
export const FiltersFormWire = BaseFormSchema

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse bracket notation from query parameters or form data
 * Syntax: filter[field][operator]=value
 * 
 * @param data Raw query or form data
 * @returns Array of normalized filters
 * 
 * @example
 * parseBracketNotation({ 
 *   'filter[status]': 'published',
 *   'filter[price][gte]': '50' 
 * })
 * // => [
 * //   { field: 'status', operator: 'eq', value: 'published' },
 * //   { field: 'price', operator: 'gte', value: '50' }
 * // ]
 */
function parseBracketNotation(data: Record<string, unknown>): FiltersNormalized {
  const filters: FilterNormalized[] = []

  for (const [key, rawValue] of Object.entries(data)) {
    const match = key.match(/^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/)
    if (!match) continue

    const field = match[1]
    const operator = (match[2] || 'eq') as FilterOperator
    
    // Extract value (handle arrays from ZStringOrStringArray)
    let value: string
    if (Array.isArray(rawValue)) {
      value = String(rawValue[0] ?? '')
    } else {
      value = String(rawValue ?? '')
    }

    // Handle null keywords
    if (value === 'null') {
      filters.push({ field, operator: 'is_null' })
    } else if (value === 'not_null') {
      filters.push({ field, operator: 'is_not_null' })
    } else {
      filters.push({ field, operator, value })
    }
  }

  return filters
}

/**
 * Encode filters back to bracket notation
 * Used for round-trip testing
 * 
 * @param filters Normalized filters array
 * @returns Wire format object
 * 
 * @example
 * encodeBracketNotation([
 *   { field: 'status', operator: 'eq', value: 'published' },
 *   { field: 'price', operator: 'gte', value: 50 }
 * ])
 * // => {
 * //   'filter[status]': 'published',
 * //   'filter[price][gte]': '50'
 * // }
 */
function encodeBracketNotation(filters: FiltersNormalized): Record<string, string> {
  const result: Record<string, string> = {}

  for (const filter of filters) {
    // Handle null operators (no value)
    if (filter.operator === 'is_null') {
      result[`filter[${filter.field}]`] = 'null'
      continue
    }

    if (filter.operator === 'is_not_null') {
      result[`filter[${filter.field}]`] = 'not_null'
      continue
    }

    // Handle value-based operators
    const value = filter.value
    const stringValue = Array.isArray(value) 
      ? value.join(',') 
      : String(value ?? '')

    // Use bracket notation for non-eq operators
    const key = filter.operator === 'eq'
      ? `filter[${filter.field}]`
      : `filter[${filter.field}][${filter.operator}]`

    result[key] = stringValue
  }

  return result
}

// ============================================================================
// SOURCE ADAPTERS (bidirectional codecs for testing)
// ============================================================================

/**
 * Query parameter adapter (codec for round-trip testing)
 * Supports: ?filter[category][eq]=electronics&filter[price][gte]=50
 * 
 * @example
 * const adapter = createFiltersQueryAdapter()
 * const normalized = adapter.decode({ 
 *   'filter[status]': 'published',
 *   'filter[price][gte]': '50'
 * })
 * // => [
 * //   { field: 'status', operator: 'eq', value: 'published' },
 * //   { field: 'price', operator: 'gte', value: '50' }
 * // ]
 * 
 * // Encode (for testing)
 * const wire = adapter.encode(normalized)
 */
export function createFiltersQueryAdapter() {
  return z.codec(
    FiltersQueryWire,
    FiltersNormalizedSchema,
    {
      decode: (raw): FiltersNormalized => {
        return parseBracketNotation(raw)
      },
      encode: (normalized): z.input<typeof FiltersQueryWire> => {
        return encodeBracketNotation(normalized)
      }
    }
  )
}

/**
 * JSON body adapter (codec for round-trip testing)
 * Expects: { filters: [{ field: 'category', operator: 'eq', value: 'electronics' }] }
 * 
 * @example
 * const adapter = createFiltersJsonAdapter()
 * const normalized = adapter.decode({ 
 *   filters: [{ field: 'category', operator: 'eq', value: 'electronics' }] 
 * })
 */
export function createFiltersJsonAdapter() {
  return z.codec(
    FiltersJsonWire,
    FiltersNormalizedSchema,
    {
      decode: (raw): FiltersNormalized => {
        return raw.filters as FiltersNormalized
      },
      encode: (normalized): z.input<typeof FiltersJsonWire> => {
        return { filters: normalized }
      }
    }
  )
}

/**
 * FormData adapter (codec for round-trip testing)
 * Supports same bracket notation as query adapter
 * 
 * @example
 * const adapter = createFiltersFormAdapter()
 * const formData = new FormData()
 * formData.append('filter[status]', 'published')
 * const normalized = adapter.decode(formData)
 */
export function createFiltersFormAdapter() {
  return z.codec(
    FiltersFormWire,
    FiltersNormalizedSchema,
    {
      decode: (raw): FiltersNormalized => {
        return parseBracketNotation(raw)
      },
      encode: (normalized): z.input<typeof FiltersFormWire> => {
        return encodeBracketNotation(normalized)
      }
    }
  )
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Result type for coercion operations
 */
type CoercionResult = 
  | { ok: true; value: unknown }
  | { ok: false }

/**
 * Validate and coerce operator value based on field type
 * Pure function - returns coerced value or adds issues to context
 * 
 * @param filter Filter to validate and coerce
 * @param fieldDef Field definition from registry
 * @param ctx Zod refinement context for error reporting
 * @param path Path for error reporting
 * @returns Coercion result with ok status and optional coerced value
 */
function validateAndCoerceOperatorValue(
  filter: FilterNormalized,
  fieldDef: FilterRegistry[string],
  ctx: z.RefinementCtx<FiltersNormalized>,
  path: (string | number)[]
): CoercionResult {
  const { operator, value, field } = filter

  // Null operators don't need values
  if (operator === 'is_null' || operator === 'is_not_null') {
    return { ok: true, value: undefined }
  }

  // Between operator needs exactly 2 values
  if (operator === 'between') {
    let arrayValue: unknown[]
    if (Array.isArray(value)) {
      arrayValue = value
    } else if (typeof value === 'string') {
      arrayValue = value.split(',').map(v => v.trim()).filter(Boolean)
    } else {
      arrayValue = [value]
    }

    if (arrayValue.length !== 2) {
      ctx.issues.push({
        code: 'custom',
        input: filter,
        path: [...path, 'value'],
        message: `Operator 'between' on field '${field}' requires exactly 2 values (min,max). Got ${arrayValue.length}.`
      })

      return { ok: false }
    }

    // Coerce based on field type
    if (fieldDef.type === 'number') {
      const [min, max] = arrayValue.map(Number)
      if (Number.isNaN(min) || Number.isNaN(max)) {
        ctx.issues.push({
          code: 'custom',
          input: filter,
          path: [...path, 'value'],
          message: `Field '${field}' requires numeric values for 'between' operator`
        })

        return { ok: false }
      }

      if (min > max) {
        ctx.issues.push({
          code: 'custom',
          input: filter,
          path: [...path, 'value'],
          message: `Field '${field}' 'between' operator requires min <= max. Got min=${min}, max=${max}.`
        })

        return { ok: false }
      }
      
      return { ok: true, value: [min, max] }
    } else if (fieldDef.type === 'date') {
      const [minDate, maxDate] = arrayValue.map(v => new Date(String(v)))
      if (Number.isNaN(minDate.getTime()) || Number.isNaN(maxDate.getTime())) {
        ctx.issues.push({
          code: 'custom',
          input: filter,
          path: [...path, 'value'],
          message: `Field '${field}' requires valid dates for 'between' operator`
        })

        return { ok: false }
      }

      if (minDate > maxDate) {
        ctx.issues.push({
          code: 'custom',
          input: filter,
          path: [...path, 'value'],
          message: `Field '${field}' 'between' operator requires start date <= end date.`
        })

        return { ok: false }
      }

      return { ok: true, value: [minDate.toISOString(), maxDate.toISOString()] }
    } else {
      ctx.issues.push({
        code: 'custom',
        input: filter,
        path: [...path, 'operator'],
        message: `Operator 'between' not supported for field type '${fieldDef.type}' on field '${field}'`
      })
    }

    return { ok: false }
  }

  // Array operators need special handling
  const isArrayOperator = fieldDef.arrayOperators?.includes(operator) ?? false  
  if (isArrayOperator) {
    // Ensure value is an array
    let arrayValue: unknown[]
    if (Array.isArray(value)) {
      arrayValue = value
    } else if (typeof value === 'string') {
      arrayValue = value.split(',').map(v => v.trim()).filter(Boolean)
    } else {
      arrayValue = [value]
    }

    if (arrayValue.length === 0) {
      ctx.issues.push({
        code: 'too_small',
        minimum: 1,
        origin: 'array',
        path: [...path, 'value'],
        message: `Operator '${operator}' on field '${field}' requires an array or comma-separated value with at least 1 value.`,
        input: filter
      });

      return { ok: false }
    }

    // Type-specific coercion for array values
    switch (fieldDef.type) {
      case 'enum': {
        // Validate each value against allowed enum values
        if (fieldDef.values) {
          const invalidValues = arrayValue.filter(v => !fieldDef.values!.includes(String(v)))
          if (invalidValues.length > 0) {
            ctx.issues.push({
              code: 'custom',
              input: filter,
              path: [...path, 'value'],
              message: `Invalid values for enum field '${field}': ${invalidValues.map(v => `'${v}'`).join(', ')}. Allowed values: ${fieldDef.values.join(', ')}`
            })
            return { ok: false }
          }
        }
        return { ok: true, value: arrayValue.map(String) }
      }

      case 'number': {
        // Coerce array values to numbers
        const coercedNumbers = arrayValue.map(v => Number(v))
        const hasNaN = coercedNumbers.some(n => Number.isNaN(n))
        if (hasNaN) {
          ctx.issues.push({
            code: 'custom',
            input: filter,
            path: [...path, 'value'],
            message: `Field '${field}' requires numeric values for operator '${operator}'`
          })
          return { ok: false }
        }
        return { ok: true, value: coercedNumbers }
      }

      case 'uuid': {
        // Validate each value as UUID
        const invalidUuids: unknown[] = []
        for (const v of arrayValue) {
          const uuidCheck = z.uuid().safeParse(String(v))
          if (!uuidCheck.success) {
            invalidUuids.push(v)
          }
        }
        if (invalidUuids.length > 0) {
          ctx.issues.push({
            code: 'custom',
            input: filter,
            path: [...path, 'value'],
            message: `Field '${field}' requires valid UUIDs for operator '${operator}'. Invalid: ${invalidUuids.map(v => `'${v}'`).join(', ')}`
          })
          return { ok: false }
        }
        return { ok: true, value: arrayValue.map(String) }
      }

      default:
        // String and other types: pass through as string array
        return { ok: true, value: arrayValue.map(String) }
    }
  }

  // Non-array operators - coerce based on field type
  switch (fieldDef.type) {
    case 'number':
      if (['gt', 'gte', 'lt', 'lte', 'eq', 'ne'].includes(operator)) {
        const numValue = Number(value)
        if (Number.isNaN(numValue)) {
          ctx.issues.push({
            code: "custom",
            input: filter,
            path: [...path, 'value'],
            message: `Field '${field}' requires numeric value for operator '${operator}'`
          })

          return { ok: false }
        }

        return { ok: true, value: numValue }
      }
      break

    case 'boolean':
      if (operator === 'eq' || operator === 'ne') {
        const boolValue = value === true || value === 'true' || value === '1' || value === 1
        return { ok: true, value: boolValue }
      }
      break

    case 'date':
      if (['gt', 'gte', 'lt', 'lte', 'eq', 'ne'].includes(operator)) {
        const dateValue = new Date(String(value))

        if (Number.isNaN(dateValue.getTime())) {
          ctx.issues.push({
            code: "custom",
            input: filter,
            path: [...path, 'value'],
            message: `Field '${field}' requires valid date for operator '${operator}'`
          })

          return { ok: false }
        }

        return { ok: true, value: dateValue.toISOString() }
      }
      break

    case 'enum':
      if (operator === 'eq' || operator === 'ne') {
        const strValue = String(value)
        if (fieldDef.values && !fieldDef.values.includes(strValue)) {
          ctx.issues.push({
            code: "custom",
            input: filter,
            path: [...path, 'value'],
            message: `Invalid value '${strValue}' for enum field '${field}'. Allowed values: ${fieldDef.values.join(', ')}`
          })

          return { ok: false }
        }

        return { ok: true, value: strValue }
      }
      break

    case 'uuid':
      if (operator === 'eq' || operator === 'ne') {
        const uuidCheck = z.uuid().safeParse(String(value))
        if (!uuidCheck.success) {
          const uuidIssues = uuidCheck.error.issues;
          for (const uuidIssue of uuidIssues) {
            ctx.issues.push({
              ...uuidIssue,
              code: "invalid_type",
              expected: "Valid UUID format",
              path: [...path, 'value'],
              message: `Field '${field}' requires valid UUID for operator '${operator}'. ${uuidIssue.message}`,
              input: filter
            })
          }

          return { ok: false }
        }

        return { ok: true, value: String(value) };
      }
      break

    case 'string':
      // String operators accept any value, coerce to string
      return { ok: true, value: String(value) }
  }

  // If we fall through, operator/type combo isn't supported.
  ctx.issues.push({
    code: "custom",
    input: value,
    path: [...path, "operator"],
    message:
      `Operator '${operator}' not supported for field '${field}' (type '${fieldDef.type}').`,
  });
  return { ok: false };
}

// ============================================================================
// SCHEMA COMPOSITION WITH VALIDATION
// ============================================================================

/**
 * Create endpoint-specific filters schema with validation
 * 
 * Note: This schema is unidirectional (decode only) because it adds
 * non-reversible transformations (defaults, type coercion). Use the
 * adapters directly for round-trip testing.
 * 
 * @param config Configuration for filter validation
 * @param config.source Input source type ('query' | 'json' | 'form')
 * @param config.registry Filter registry with field definitions
 * @param config.limits Optional limits configuration (maxFilters)
 * 
 * @example
 * const schema = createFiltersSchema({
 *   source: 'query',
 *   registry: {
 *     price: {
 *       operators: ['gte', 'lte'],
 *       type: 'number'
 *     },
 *     status: {
 *       operators: ['eq', 'in'],
 *       type: 'enum',
 *       values: ['draft', 'published'],
 *       arrayOperators: ['in']
 *     }
 *   },
 *   limits: { maxFilters: 10 }
 * })
 * 
 * // Parse and validate
 * const filters = schema.parse({ 
 *   'filter[price][gte]': '50',
 *   'filter[status][in]': 'draft,published'
 * })
 */
export function createFiltersSchema(config: {
  source: 'query' | 'json' | 'form'
} & FiltersConfig) {
  // Select appropriate adapter based on source
  const adapter =
    config.source === 'query' ? createFiltersQueryAdapter() :
    config.source === 'json' ? createFiltersJsonAdapter() :
    createFiltersFormAdapter()
  
  if (config.disabled) {
    return adapter.transform(() => null)
  }

  const maxFilters = config.limits?.maxFilters ?? 20
  const mergeDefaults = config.mergeDefaults ?? true

  const registry = config.registry ?? {}
  const allowedFields = Object.keys(registry)

  return adapter
    // Step 1: Apply defaults (pure transform)
    .transform((filters): FiltersNormalized => {
      // Apply default filters
      if (config.defaults?.length && filters.length === 0) {
        // No user filters - use defaults
        return [...config.defaults]
      }
      
      if (mergeDefaults && config.defaults?.length) {
        // Merge defaults with user filters
        // Defaults come first (applied before user filters)
        return [...config.defaults, ...filters]
      }
      
      return filters
    })

    // Step 2: Validate structure (no mutations)
    .check((ctx) => {
      const filters = ctx.value

      // Check filter count (DoS protection)
      if (filters.length > maxFilters) {
        ctx.issues.push({
          code: "too_big",
          maximum: maxFilters,
          origin: 'array',
          path: [],
          message: `Too many filters: maximum ${maxFilters} allowed, got ${filters.length}`,
          input: filters
        })
        return // Don't continue validating individual filters
      }

      // No registry = skip field/operator validation
      if (!config.registry) return

      // Validate each filter
      filters.forEach((filter, idx) => {
        const { field, operator = 'eq' } = filter
        const fieldDef = registry[field]

        // Check if field is filterable
        if (!fieldDef && allowedFields.length > 0) {
          ctx.issues.push({
            code: "custom",
            input: filter,
            path: [idx, 'field'],
            message: `Field '${field}' is not filterable. Allowed fields: ${allowedFields.join(', ')}`,
          })
          return // Skip further validation for this filter
        }

        // If field is in registry, validate operator
        if (fieldDef && !fieldDef.operators.includes(operator)) {
          ctx.issues.push({
            code: "custom",
            input: filter,
            path: [idx, 'operator'],
            message: `Operator '${operator}' not allowed for field '${field}'. Allowed operators: ${fieldDef.operators.join(', ')}`
          })
          return
        }

      })
    })

    // Step 3: Coerce values (pure transform, only runs on valid data)
    .transform((filters, ctx): FiltersNormalized => {
      if (!config.registry) return filters

      // If earlier .check() already recorded issues, skip coercion
      if (ctx.issues.length > 0) return z.NEVER

      const issuesBefore = ctx.issues.length
      const coerced = filters.map((filter, idx) => {
        const fieldDef = config.registry![filter.field]
        if (!fieldDef) return filter

        const result = validateAndCoerceOperatorValue(filter, fieldDef, ctx, [idx])

        // Placeholder return; we will abort below if any issues were added.
        if (!result.ok) return filter

        return { ...filter, value: result.value }
      })

      // If coercion added any issues, abort and let Zod surface them.
      if (ctx.issues.length !== issuesBefore) return z.NEVER

      return coerced
    })
}
