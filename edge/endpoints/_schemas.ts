/**
 * Shared Zod schemas for bundlejs edge endpoints.
 * 
 * Centralizes query parameter validation across all bundle-related endpoints.
 * Uses Zod v4 for runtime validation with TypeScript inference.
 */

import { z } from 'zod'

// =============================================================================
// Primitive Transformers
// =============================================================================

/**
 * Coerce string query param to boolean.
 * - "true" / "" (present but empty) → true
 * - "false" → false
 * - absent → undefined (use .default() for fallback)
 */
export const booleanQueryParam = z
  .string()
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined
    if (val === '' || val === 'true') return true
    if (val === 'false') return false
    return undefined
  })

/**
 * Coerce string query param to boolean, defaulting to false.
 */
export const booleanQueryParamFalse = booleanQueryParam.transform((val) => val ?? false)

/**
 * Coerce string query param to boolean, defaulting to true.
 */
export const booleanQueryParamTrue = booleanQueryParam.transform((val) => val ?? true)

// =============================================================================
// Bundle Query Schema
// =============================================================================

/**
 * Main bundle query parameters.
 * 
 * These control what gets bundled and how:
 * - `q` / `query`: Package(s) to bundle (comma-separated)
 * - `treeshake`: Exports to treeshake per package
 * - `share`: LZ-string compressed code
 * - `text`: Plaintext code input
 * - `config`: JSON5 build configuration
 */
export const BundleQuerySchema = z.object({
  // Package query (main input)
  q: z.string().optional(),
  query: z.string().optional(),
  
  // Code inputs
  share: z.string().optional(),
  text: z.string().optional(),
  
  // Treeshaking
  treeshake: z.string().optional(),
  
  // Build configuration (JSON5 string)
  config: z.string().optional(),
  
  // Language mode
  tsx: booleanQueryParam,
  jsx: booleanQueryParam,
  
  // Output options
  minify: booleanQueryParam,
  pretty: booleanQueryParam,
  sourcemap: z.string().optional(), // Can be 'inline', 'external', 'both', true/false
  format: z.enum(['esm', 'cjs', 'iife']).optional(),
  
  // Features
  polyfill: booleanQueryParam,
  analysis: z.union([booleanQueryParam, z.literal('verbose')]).optional(),
  analyze: z.union([booleanQueryParam, z.literal('verbose')]).optional(),
  metafile: booleanQueryParam,
  
  // Badge options
  badge: z.string().optional(), // Can be 'detailed', 'minified', or just present
  'badge-style': z.string().optional(),
  'badge-raster': booleanQueryParam,
  png: booleanQueryParam,
  
  // Output modes
  file: booleanQueryParam,
  warnings: booleanQueryParam,
  warning: booleanQueryParam,
  raw: booleanQueryParam,
})

export type BundleQuery = z.infer<typeof BundleQuerySchema>

/**
 * Normalized bundle query after processing.
 */
export interface NormalizedBundleQuery {
  /** Packages to bundle */
  packages: string[]
  /** Module import modes: [packageSpec, 'import' | 'export'][] */
  modules: Array<[string, 'import' | 'export']>
  /** Treeshake exports per package */
  treeshakeExports: string[]
  /** Whether to export all (no specific treeshake) */
  exportAll: boolean
  /** Input code (from share, text, or generated) */
  inputCode: string
  /** Build config object */
  config: Record<string, unknown>
  /** Enable TSX/JSX mode */
  tsx: boolean
  /** Minify output */
  minify: boolean | null
  /** Generate sourcemap */
  sourcemap: string | boolean | null
  /** Output format */
  format: 'esm' | 'cjs' | 'iife' | null
  /** Polyfill node builtins */
  polyfill: boolean
  /** Generate metafile for analysis */
  metafile: boolean
}

// =============================================================================
// Badge Query Schema
// =============================================================================

export const BadgeQuerySchema = BundleQuerySchema.extend({
  badge: z.string().optional().default(''),
  'badge-style': z.enum([
    'flat',
    'flat-square', 
    'plastic',
    'for-the-badge',
    'social',
  ]).optional(),
  'badge-raster': booleanQueryParamFalse,
  png: booleanQueryParamFalse,
})

export type BadgeQuery = z.infer<typeof BadgeQuerySchema>

// =============================================================================
// Cache Admin Schema
// =============================================================================

export const CacheDeleteQuerySchema = z.object({
  gist: booleanQueryParam,
  gists: booleanQueryParam,
})

export type CacheDeleteQuery = z.infer<typeof CacheDeleteQuerySchema>

// =============================================================================
// Output Schemas
// =============================================================================

/**
 * Compression size information.
 */
export const CompressionSizeSchema = z.object({
  type: z.enum(['gzip', 'brotli', 'zstd', 'lz4']),
  compressedSize: z.string(),
  uncompressedSize: z.string(),
  rawCompressedSize: z.number(),
  rawUncompressedSize: z.number(),
})

export type CompressionSize = z.infer<typeof CompressionSizeSchema>

/**
 * Bundle result schema.
 */
export const BundleResultSchema = z.object({
  query: z.string(),
  rawQuery: z.string(),
  config: z.record(z.string(), z.unknown()),
  input: z.string(),
  version: z.string().optional(),
  versions: z.array(z.string()).optional(),
  modules: z.array(z.tuple([z.string(), z.string()])).optional(),
  size: CompressionSizeSchema,
  installSize: z.object({
    total: z.number().optional(),
    packages: z.array(z.unknown()).optional(),
  }).optional(),
  time: z.string(),
  rawTime: z.number(),
  fileId: z.string().optional(),
  fileUrl: z.string().optional(),
  fileHTMLUrl: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  metafile: z.record(z.string(), z.unknown()).optional(),
})

export type BundleResult = z.infer<typeof BundleResultSchema>

// =============================================================================
// API Documentation Schema
// =============================================================================

export const DocsSchema = z.object({
  docs: z.string(),
  examples: z.array(z.string()),
  basics: z.array(z.string()),
})

export type Docs = z.infer<typeof DocsSchema>