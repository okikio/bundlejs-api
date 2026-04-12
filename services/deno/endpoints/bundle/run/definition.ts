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

import type { EndpointDefinition } from '@utils/endpoint/types'
import { z } from 'zod'
import { BaseJsonSchema } from '@utils/endpoint/schemas'
import { makeSuccessResponseSchema } from '@utils/response/schemas'
import { BundleResultSchema } from '#shared/bundle/schema.ts'
import { BundleQuerySchema } from '#shared/bundle/schema.ts'

// ============================================================================
// INPUT SCHEMAS
// ============================================================================

/**
 * Query parameters (GET requests)
 */
export const QuerySchema = BundleQuerySchema

/**
 * Body schema (POST requests with large payloads)
 */
export const JsonSchema = BaseJsonSchema.pipe(
  z.object({
    query: z.string().optional(),
    q: z.string().optional(),
    text: z.string().optional(),
    share: z.string().optional(),
    treeshake: z.string().optional(),
    config: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
    minify: z.boolean().optional(),
    pretty: z.boolean().optional(),
    sourcemap: z.union([z.boolean(), z.literal('inline'), z.literal('external'), z.literal('both')]).optional(),
    tsx: z.boolean().optional(),
    jsx: z.boolean().optional(),
    polyfill: z.boolean().optional(),
    format: z.enum(['esm', 'cjs', 'iife']).optional(),
    analysis: z.union([z.boolean(), z.string()]).optional(),
    analyze: z.union([z.boolean(), z.string()]).optional(),
    metafile: z.boolean().optional(),
    badge: z.string().optional(),
    'badge-style': z.string().optional(),
    'badge-raster': z.boolean().optional(),
    png: z.boolean().optional(),
    file: z.boolean().optional(),
    raw: z.boolean().optional(),
    warnings: z.boolean().optional(),
    warning: z.boolean().optional(),
    cache: z.enum(['use', 'bypass', 'refresh']).optional(),
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