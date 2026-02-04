// endpoints/bundle/run/definition.ts
/**
 * Bundle Run Endpoint Definition
 * 
 * GET/POST /v1/bundle
 * 
 * Main bundling endpoint that:
 * - Accepts package queries
 * - Returns bundle result JSON
 * - Supports caching
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BaseQuerySchema, BaseJsonSchema } from '#shared/server/schemas.ts'
import { makeSuccessResponseSchema } from '#shared/response/schemas.ts'
import { BundleResultSchema } from '#shared/schemas/bundle-result.ts'

// ============================================================================
// INPUT SCHEMAS
// ============================================================================

/**
 * Query parameters (GET requests)
 */
export const QuerySchema = BaseQuerySchema.extend({
  // Module selection
  q: z.string().optional(),
  query: z.string().optional(),          // Alias for q
  
  // Code input
  text: z.string().optional(),            // Inline code
  share: z.string().optional(),           // LZ-compressed code
  
  // Treeshaking
  treeshake: z.string().optional(),       // Export selections
  
  // Build options
  config: z.string().optional(),          // JSON5 config
  minify: z.coerce.boolean().default(true),
  tsx: z.coerce.boolean().default(false),
  target: z.string().default('esnext'),
  format: z.enum(['esm', 'cjs', 'iife']).default('esm'),
  
  // Compression
  compression: z.enum(['gzip', 'brotli', 'zstd', 'lz4', 'none']).default('gzip'),
  
  // Cache control
  cache: z.enum(['use', 'bypass', 'refresh']).default('use'),
  
  // Output modifiers
  analysis: z.coerce.boolean().default(false),
  metafile: z.coerce.boolean().default(false),
})

/**
 * Body schema (POST requests with large payloads)
 */
export const JsonSchema = BaseJsonSchema.pipe(
  z.object({
    query: z.string().optional(),
    text: z.string().optional(),
    share: z.string().optional(),
    treeshake: z.string().optional(),
    config: z.record(z.unknown()).optional(),
    minify: z.boolean().default(true),
    tsx: z.boolean().default(false),
    target: z.string().default('esnext'),
    format: z.enum(['esm', 'cjs', 'iife']).default('esm'),
    compression: z.enum(['gzip', 'brotli', 'zstd', 'lz4', 'none']).default('gzip'),
    cache: z.enum(['use', 'bypass', 'refresh']).default('use'),
  }).partial()
)

// ============================================================================
// OUTPUT SCHEMA
// ============================================================================

export const OutputSchema = makeSuccessResponseSchema(BundleResultSchema)

// ============================================================================
// ENDPOINT DEFINITION
// ============================================================================

export default {
  Name: 'bundle-run',
  Route: '/v1/bundle',
  Methods: ['GET', 'POST'] as const,
  Input: QuerySchema.or(JsonSchema),
  Output: OutputSchema,
  Schemas: {
    Query: QuerySchema,
    Json: JsonSchema,
  },
} as const satisfies EndpointDefinition

export type BundleRunInput = z.infer<typeof QuerySchema> | z.infer<typeof JsonSchema>
export type BundleRunOutput = z.infer<typeof OutputSchema>