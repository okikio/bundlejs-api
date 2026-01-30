// utils/query/fields.ts
/**
 * Field selection (sparse fieldsets) with multi-source support
 * 
 * Features:
 * - JSON:API syntax: fields[type]=a,b,c
 * - Simple syntax: fields=a,b,c
 * - Field allowlists via registry
 * - De-duplication
 * - Wildcard handling
 * - Query/JSON/FormData source adapters
 */

import { z } from 'zod'

import { BaseQuerySchema, BaseJsonSchema, BaseFormSchema } from '#shared/server/schemas.ts'
import {
  FieldSelectionNormalizedSchema,
  type FieldsConfig,
  type FieldSelectionNormalized
} from './schemas.ts'

// ============================================================================
// WIRE SCHEMAS (raw incoming data)
// ============================================================================

/**
 * Query parameter wire schema (raw incoming)
 * Supports both:
 * - Simple: ?fields=a,b,c
 * - JSON:API: ?fields[products]=a,b,c&fields[categories]=x,y
 */
export const FieldsQueryWire = BaseQuerySchema

/**
 * JSON body wire schema (raw incoming)
 * Expects: { fields: { type: 'simple', fields: ['a', 'b'] } }
 */
export const FieldsJsonWire = BaseJsonSchema.pipe(
  z.object({
    fields: FieldSelectionNormalizedSchema.nullable().default(null)
  })
)

/**
 * FormData wire schema (raw incoming)
 */
export const FieldsFormWire = BaseFormSchema

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract string value from ZStringOrStringArray
 */
const getString = (val: unknown): string | undefined => {
  if (Array.isArray(val)) return val[0]
  if (typeof val === 'string') return val
  return undefined
}

/**
 * Detect JSON:API vs simple syntax from query/form data
 * 
 * Detection priority:
 * 1. Check for JSON:API syntax: fields[type]=...
 * 2. Fall back to simple syntax: fields=...
 * 3. Return null if neither found
 * 
 * @param data Raw query or form data
 * @returns Normalized field selection or null
 * 
 * @example
 * // JSON:API syntax
 * detectFieldSyntax({ 'fields[products]': 'id,name', 'fields[categories]': 'name' })
 * // => { type: 'jsonapi', fields: { products: ['id', 'name'], categories: ['name'] } }
 * 
 * // Simple syntax
 * detectFieldSyntax({ fields: 'id,name,price' })
 * // => { type: 'simple', fields: ['id', 'name', 'price'] }
 * 
 * // No field selection
 * detectFieldSyntax({ page: '1' })
 * // => null
 */
function detectFieldSyntax(data: Record<string, unknown>): FieldSelectionNormalized | null {
  // Check for JSON:API syntax: fields[type]=...
  const jsonApiFields: Record<string, string[]> = {}

  for (const [key, value] of Object.entries(data)) {
    const match = key.match(/^fields\[([^\]]+)\]$/)
    if (match) {
      const type = match[1]
      
      // Extract value (handle arrays from ZStringOrStringArray)
      const stringValue = String(getString(value) ?? '')
      const fields = stringValue
        .split(',')
        .map(f => f.trim())
        .filter(f => f)

      if (fields.length > 0) {
        jsonApiFields[type] = fields
      }
    }
  }

  if (Object.keys(jsonApiFields).length > 0) {
    return { type: 'jsonapi', fields: jsonApiFields }
  }

  // Fall back to simple syntax: fields=...
  const fieldsValue = data.fields
  if (fieldsValue) {
    // Extract value (handle arrays from ZStringOrStringArray)
    const stringValue = String(getString(fieldsValue) ?? '')
    const fields = stringValue
      .split(',')
      .map(f => f.trim())
      .filter(f => f)

    if (fields.length > 0) {
      return { type: 'simple', fields }
    }
  }

  return null
}

/**
 * Encode field selection back to wire format
 * Used for round-trip testing
 */
function encodeFieldSyntax(selection: FieldSelectionNormalized | null): Record<string, string> {
  if (!selection) return {}

  if (selection.type === 'simple') {
    return { fields: selection.fields.join(',') }
  }

  // JSON:API syntax
  const result: Record<string, string> = {}
  for (const [type, fields] of Object.entries(selection.fields)) {
    result[`fields[${type}]`] = fields.join(',')
  }
  return result
}

// ============================================================================
// SOURCE ADAPTERS (unidirectional - decode only)
// ============================================================================

/**
 * Query parameter adapter (codec for round-trip testing)
 * Supports: ?fields=a,b,c or ?fields[products]=a,b,c
 * 
 * @example
 * const adapter = createFieldsQueryAdapter()
 * 
 * // Simple syntax
 * const simple = adapter.decode({ fields: 'id,name,price' })
 * // => { type: 'simple', fields: ['id', 'name', 'price'] }
 * 
 * // JSON:API syntax
 * const jsonapi = adapter.decode({ 
 *   'fields[products]': 'id,name', 
 *   'fields[categories]': 'name' 
 * })
 * // => { type: 'jsonapi', fields: { products: ['id', 'name'], categories: ['name'] } }
 * 
 * // Encode (for testing)
 * const wire = adapter.encode(simple)
 * // => { fields: 'id,name,price' }
 */
export function createFieldsQueryAdapter() {
  return z.codec(
    FieldsQueryWire,
    FieldSelectionNormalizedSchema.nullable(),
    {
      decode: (raw): FieldSelectionNormalized | null => {
        return detectFieldSyntax(raw)
      },
      encode: (selection): z.input<typeof FieldsQueryWire> => {
        return encodeFieldSyntax(selection)
      }
    }
  )
}


/**
 * JSON body adapter (codec for round-trip testing)
 * Expects: { fields: { type: 'simple', fields: ['a', 'b'] } }
 * 
 * @example
 * const adapter = createFieldsJsonAdapter()
 * const normalized = adapter.decode({ 
 *   fields: { type: 'simple', fields: ['id', 'name'] } 
 * })
 * // => { type: 'simple', fields: ['id', 'name'] }
 */
export function createFieldsJsonAdapter() {
  return z.codec(
    FieldsJsonWire,
    FieldSelectionNormalizedSchema.nullable(),
    {
      decode: (raw): FieldSelectionNormalized | null => {
        return raw.fields as FieldSelectionNormalized | null
      },
      encode: (selection): z.input<typeof FieldsJsonWire> => {
        return { fields: selection }
      }
    }
  )
}

/**
 * FormData adapter (codec for round-trip testing)
 * Supports: fields=a,b,c or fields[products]=a,b,c
 * 
 * @example
 * const adapter = createFieldsFormAdapter()
 * const formData = new FormData()
 * formData.append('fields', 'id,name,price')
 * const normalized = adapter.decode(formData)
 * // => { type: 'simple', fields: ['id', 'name', 'price'] }
 */
export function createFieldsFormAdapter() {
  return z.codec(
    FieldsFormWire,
    FieldSelectionNormalizedSchema.nullable(),
    {
      decode: (raw): FieldSelectionNormalized | null => {
        // Convert FormValue to plain record for detectFieldSyntax
        const plainObj: Record<string, string> = {}
        
        for (const [key, value] of Object.entries(raw)) {
          plainObj[key] = String(getString(value) ?? '')
        }
        
        return detectFieldSyntax(plainObj)
      },
      encode: (selection): z.input<typeof FieldsFormWire> => {
        return encodeFieldSyntax(selection)
      }
    }
  )
}


// ============================================================================
// SCHEMA COMPOSITION WITH VALIDATION
// ============================================================================

/**
 * Create endpoint-specific fields schema with validation
 * 
 * @param config Configuration for field selection validation
 * @param config.source Input source type ('query' | 'json' | 'form')
 * @param config.allowedFields Array of selectable field names (allowlist)
 * @param config.resourceType Resource type for JSON:API validation
 * @param config.defaultFields Default fields when none provided
 * 
 * @example
 * const schema = createFieldsSchema({
 *   source: 'query',
 *   allowedFields: ['id', 'name', 'price', 'created_at'],
 *   defaults: ['id', 'name']
 * })
 * 
 * // Parse and validate
 * const fields = schema.parse({ fields: 'id,name,price' })
 * // => { type: 'simple', fields: ['id', 'name', 'price'] }
 * 
 * // With wildcard
 * const allFields = schema.parse({ fields: '*' })
 * // => { type: 'simple', fields: ['id', 'name', 'price', 'created_at'] }
 * 
 * // Invalid field rejected
 * schema.parse({ fields: 'id,invalid_field' })
 * // => Throws validation error
 */
export function createFieldsSchema(config: {
  source: 'query' | 'json' | 'form'
} & FieldsConfig) {
  const adapter =
    config.source === 'query' ? createFieldsQueryAdapter() :
    config.source === 'json' ? createFieldsJsonAdapter() :
    createFieldsFormAdapter()

  if (config.disabled) {
    return adapter.transform(() => null)
  }

  return adapter
    // Step 1: Apply defaults
    .transform((selection): FieldSelectionNormalized | null => {
      if (!selection && config.defaults && config.defaults.length > 0) {
        return {
          type: 'simple',
          fields: [...config.defaults]
        }
      }
      return selection
    })
    
    // Step 2: Validate
    .check((ctx) => {
      const selection = ctx.value
      if (!selection) return

      // Get fields to validate based on selection type
      const fieldsToValidate = 
        selection.type === 'simple'
          ? selection.fields
          : config.resourceType
            ? selection.fields[config.resourceType] ?? []
            : Object.values(selection.fields).flat()

      // De-duplicate fields
      const uniqueFields = Array.from(new Set(fieldsToValidate))

      // Handle wildcard - skip validation, will expand in transform
      if (uniqueFields.includes('*')) {
        if (!config.allowedFields) return
        return // Wildcard expansion happens in transform
      }

      // Validate against allowlist
      if (config.allowedFields && config.allowedFields.length > 0) {
        const invalidFields = uniqueFields.filter(f => !config.allowedFields!.includes(f))
        
        if (invalidFields.length > 0) {
          ctx.issues.push({
            code: "custom",
            path: selection.type === 'simple' ? ['fields'] : ['fields', config.resourceType ?? '*'],
            message: `Invalid fields: ${invalidFields.join(', ')}. Allowed fields: ${config.allowedFields.join(', ')}`,
            input: selection
          })
        }
      }
    })

    // Step 3: Transform (expand wildcards, deduplicate)
    .transform((selection): FieldSelectionNormalized | null => {
      if (!selection) return null

      if (selection.type === 'simple') {
        const uniqueFields = Array.from(new Set(selection.fields))
        
        // Expand wildcard
        if (uniqueFields.includes('*') && config.allowedFields) {
          return {
            type: 'simple',
            fields: [...config.allowedFields]
          }
        }
        
        return {
          type: 'simple',
          fields: uniqueFields
        }
      }

      // JSON:API - deduplicate each resource type, expand wildcards
      const deduped: Record<string, string[]> = {}
      for (const [type, fields] of Object.entries(selection.fields)) {
        const unique = Array.from(new Set(fields))
        
        if (unique.includes('*') && config.allowedFields) {
          deduped[type] = [...config.allowedFields]
        } else {
          deduped[type] = unique
        }
      }

      return {
        type: 'jsonapi',
        fields: deduped
      }
    })
}
