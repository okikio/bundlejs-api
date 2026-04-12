/**
 * Bundle Service Schemas
 *
 * Zod v4 schemas for request validation and response typing.
 *
 * @module
 */
import { z } from 'zod'

// =============================================================================
// Shared Helpers
// =============================================================================

/**
 * Query-string boolean: accepts `""`, `"true"`, `"false"`, or absent.
 *
 * Transforms to `true` when value is `""` or `"true"`, `false` when `"false"`,
 * `undefined` when absent. This matches how query params behave in practice:
 * `?tsx` (empty string) and `?tsx=true` are both truthy.
 */
const queryBool = () =>
  z
    .enum(['', 'true', 'false'])
    .optional()
    .transform((v): boolean => v === '' || v === 'true')

/**
 * Tri-state query boolean: same as queryBool but preserves `undefined`
 * when absent (rather than coercing to `false`). Used for params where
 * "not specified" differs from "explicitly false".
 */
const queryTriBool = () =>
  z
    .enum(['', 'true', 'false'])
    .optional()
    .transform((v): boolean | undefined =>
      v === '' || v === 'true' ? true : v === 'false' ? false : undefined
    )

// =============================================================================
// Query Parameter Schemas
// =============================================================================

/**
 * Schema for bundle query parameters (V4 DSL Spec v1).
 *
 * ## URL Structure
 *
 * ```
 * /?v=1&q=<modules>&base=<default-bracket>&treeshake=<overrides>
 * ```
 *
 * ### New in V4
 *
 * - `v` — Spec version (always `1`). Canonical share links include this.
 * - `base` — Default bracket payload for unoverridden modules.
 *   Missing = `auto|default` (namespace + default surface).
 *
 * ### Bracket Grammar
 *
 * ```
 * bracket    = emit_item ("|" emit_item)*
 * emit_item  = [phase] clause [attributes]
 * phase      = "defer" | "source" | "type"
 * clause     = "bare" | "auto" | "default" | "*" | "* as X" | "{ ... }" | "id:X" | X
 * attributes = "with" "{" key:value, ... "}"
 * ```
 *
 * @see GRAMMAR.md for full spec
 */
export const BundleQuerySchema = z.object({
  // -------------------------------------------------------------------------
  // V4 DSL params
  // -------------------------------------------------------------------------

  /**
   * Spec version. Always `1` for current grammar.
   * Share links SHOULD always include this to lock interpretation.
   */
  v: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined)),

  /**
   * Default bracket payload for modules without a treeshake override.
   *
   * Examples:
   * - `auto` — safe namespace only (one line per module)
   * - `auto|default` — namespace + default surface (two lines)
   * - `*|{default}` — old-school re-export all + default
   * - `type auto|type default` — type-only surfaces
   *
   * When missing, interpreted as `auto|default`.
   */
  base: z.string().optional(),

  // -------------------------------------------------------------------------
  // Module & code params
  // -------------------------------------------------------------------------

  /** Module specifier(s) — comma-separated */
  q: z.string().optional(),
  query: z.string().optional(),

  /**
   * Per-module bracket payload overrides.
   *
   * Positional: `[auto|default],,[{parse}with{type:json}]`
   * Sparse:     `0:[auto|default];2:[{parse}with{type:json}]`
   */
  treeshake: z.string().optional(),

  /** LZ-compressed code (for large input) */
  share: z.string().optional(),

  /** Plain text code (for short input) */
  text: z.string().optional(),

  /** JSON5 build configuration */
  config: z.string().optional(),

  // -------------------------------------------------------------------------
  // Build options
  // -------------------------------------------------------------------------

  /** Enable JSX/TSX support */
  tsx: queryBool(),
  jsx: queryBool(),

  /** Enable polyfills */
  polyfill: queryBool(),

  /** Minify output */
  minify: queryTriBool(),

  /** Pretty (non-minified) output */
  pretty: queryTriBool(),

  /** Source map generation */
  sourcemap: z
    .enum(['', 'true', 'false', 'inline', 'external', 'both'])
    .optional(),

  /** Output format */
  format: z.enum(['esm', 'cjs', 'iife']).optional(),

  // -------------------------------------------------------------------------
  // Output mode params
  // -------------------------------------------------------------------------

  /** Enable metafile output */
  metafile: queryBool(),

  /** Enable analysis output */
  analysis: z.string().optional(),
  analyze: z.string().optional(),

  /** Badge generation */
  badge: z.string().optional(),
  'badge-style': z.string().optional(),
  'badge-raster': queryBool(),
  png: queryBool(),

  /** File output */
  file: queryBool(),

  /** Raw JSON output */
  raw: queryBool(),

  /** Cache control mode */
  cache: z.enum(['use', 'bypass', 'refresh']).optional(),

  /** Warnings output */
  warnings: queryBool(),
  warning: queryBool(),
})

export type BundleQuery = z.infer<typeof BundleQuerySchema>

// =============================================================================
// Response Schemas
// =============================================================================

/** Compression size information */
export const CompressionSizeSchema = z.object({
  type: z.string(),
  uncompressedSize: z.string(),
  compressedSize: z.string(),
  rawUncompressedSize: z.number(),
  rawCompressedSize: z.number(),
})

/** Install size information */
export const InstallSizeSchema = z.object({
  total: z.number().optional(),
  packages: z
    .array(
      z.object({
        name: z.string(),
        size: z.number(),
      })
    )
    .optional(),
})

/** Module specification tuple: [specifier, mode] */
export const ModuleSpecSchema = z.tuple([
  z.string(),
  z.string(),
])

/** Bundle result response */
export const BundleResultSchema = z.object({
  query: z.string(),
  rawQuery: z.string(),
  config: z.record(z.string(), z.unknown()),
  input: z.string(),
  version: z.string().optional(),
  versions: z.array(z.string()).optional(),
  modules: z.array(ModuleSpecSchema).optional(),
  size: CompressionSizeSchema,
  installSize: InstallSizeSchema.optional(),
  time: z.string(),
  rawTime: z.number(),
  fileId: z.string().optional(),
  fileUrl: z.string().optional(),
  fileHTMLUrl: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  metafile: z.record(z.string(), z.unknown()).optional(),
  cached: z.boolean().optional(),
})

export type BundleResultResponse = z.infer<typeof BundleResultSchema>

/** Error response */
export const ErrorResponseSchema = z.object({
  error: z.string(),
})

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

// =============================================================================
// Documentation Schema
// =============================================================================

export const DocsSchema = z.object({
  docs: z.string(),
  examples: z.array(z.string()),
  basics: z.array(z.string()),
})

export type Docs = z.infer<typeof DocsSchema>

/**
 * API documentation content.
 */
export const API_DOCS: Docs = {
  docs: '/?docs - Takes you to some docs for the API',
  examples: [
    '/?v=1',
    '/?base=auto',
    '/?base=auto|default',
    '/?treeshake=[auto|default],,[{parse}with{type:json}]',
    '/?treeshake=0:[auto];2:[defer*asX]',
    '~~~',
    '/?tsx or /?jsx',
    '/?badge or /?badge=detailed or /?badge=minified',
    '/?badge-style=for-the-badge',
    '/?badge-raster',
    '/?file',
    '/?polyfill',
    '/?analysis or /?analyze=verbose',
    '/?metafile',
    '/?minify=false',
    '/?sourcemap=inline',
    '/?format=iife',
    '/?warnings',
    '/?raw',
    '~~~',
    '/?q=spring-easing,(import)@okikio/emitter,(import)@okikio/animate',
    '/?treeshake=[auto|default],[T],[{ animate }]',
    '/?text="export * as PR18 from \\"@okikio/animate\\";\\nexport { animate as animate2 } from \\"@okikio/animate\\";"',
    '/?share=MYewdgziA2CmB00QHMAUAiAwiG6CUQA',
    '/?config={"cdn":"skypack","compression":"brotli","esbuild":{"format":"cjs","minify":false,"treeShaking":false}}',
  ],
  basics: [
    // V4 DSL params
    '/?v — Spec version (currently v=1). Canonical share links always include this.',
    '/?base — Default bracket payload for modules without a treeshake override. Missing = auto|default. Set base=auto for safe/minimal output (one line per module).',
    '~~~',
    // Treeshake grammar
    '/?treeshake — Per-module bracket overrides. Supports positional ([auto],,[{parse}]) and sparse (0:[auto];2:[{parse}]) formats.',
    '  Clauses: bare, auto, default, *, * as X, { named }, id:X, or an identifier',
    '  Phases: defer (namespace only), source (identifier only), type (all except bare)',
    '  Multi-emit: [auto|default] produces two statements (namespace + default surface)',
    '  Attributes: [{parse}with{type:json}] adds import attributes',
    '  Separators: spaces, +, _ between keywords all work. [*_as_X] = [* as X] = [*asX]',
    '~~~',
    // Existing params
    '/?q or /?query — Module specifier(s), comma-separated. Prefix (import) for import mode, bare = export.',
    '/?tsx or /?jsx — Support JSX and TSX',
    '/?badge — Generates a badge (badge=detailed for module names, badge=minified for minified size)',
    '/?badge-style — Badge styles from shields.io',
    '/?badge-raster — Badge as PNG image',
    '/?file — Resulting bundled code output',
    '/?polyfill — Polyfill Node built-ins',
    '/?analysis or /?analyze — Visual analysis via esbuild',
    '/?metafile — Esbuild bundle metafile for https://esbuild.github.io/analyze/',
    '/?minify — Esbuild minify (default true)',
    '/?sourcemap — Esbuild sourcemap (inline, external, both)',
    '/?format — Output format (esm, cjs, iife)',
    '/?warnings — Lists warnings for a bundle',
    '/?raw — Raw JSON result',
    '/?text — Input code as a string (short strings; use share for longer)',
    '/?share — LZ-compressed string version of input code',
    '/?config — JSON5 build configuration',
    '/?cache — Cache control: use (default), bypass, refresh',
  ],
}