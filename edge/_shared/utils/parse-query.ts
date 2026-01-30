/**
 * Query parsing utilities for bundlejs.
 * 
 * Transforms raw URL query parameters into normalized bundle configuration.
 * Handles:
 * - Package parsing with import/export modes
 * - Treeshake export extraction
 * - Share URL decompression
 * - Config JSON5 parsing
 */

import type { BundleQuery, NormalizedBundleQuery } from '../../endpoints/_schemas.ts'
import { lzstring, parsePackageName, deepMerge } from '@bundle/utils'
import JSON5 from '../vendor/json5.ts'

const { decompressFromURL } = lzstring

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_PACKAGE = 'spring-easing'

export const DEFAULT_INPUT = [
  'export * from "spring-easing";',
  'export { default } from "spring-easing";',
].join('\n')

// =============================================================================
// Treeshake Parsing
// =============================================================================

/**
 * Parse treeshake exports string into array.
 * 
 * Format: `[{ x,y,z }],[*],[* as X],[{ type xyz }]`
 * Each bracket group maps to a package in the query.
 * 
 * @example
 * ```ts
 * parseTreeshakeExports('[{ animate }],[*]')
 * // ['{ animate }', '*']
 * ```
 */
export function parseTreeshakeExports(str: string): string[] {
  return (str ?? '')
    .split(/\],/)
    .map((s) => s.replace(/\[|\]/g, '').trim())
    .filter(Boolean)
}

/**
 * Check if treeshake exports indicate "export all".
 * True when empty or all entries are `*` or `{ default }`.
 */
export function isExportAll(treeshakeArr: string[]): boolean {
  if (treeshakeArr.length === 0) return true
  return treeshakeArr.every((x) => /^\*$|^{\s*default\s*}$/.test(x))
}

// =============================================================================
// Module Name Utilities
// =============================================================================

/**
 * Extract basename without extension from a path or URL.
 */
function fromBasename(path: string): string {
  const withoutProtocol = path.replace(/^https?:\/\//, '')
  const parts = withoutProtocol.split('/')
  const last = parts[parts.length - 1] || ''
  const dotIdx = last.lastIndexOf('.')
  return dotIdx > 0 ? last.slice(0, dotIdx) : last
}

/**
 * Generate a clean module variable name from a package specifier.
 * 
 * @example
 * ```ts
 * getModuleName('@okikio/animate') // 'okikioAnimate'
 * getModuleName('https://esm.sh/lodash/debounce') // 'debounce'
 * ```
 */
export function getModuleName(str: string): string {
  const { name, path } = parsePackageName(str, { ignoreError: true })
  
  let base = str
  if (/^https?:\/\//.test(str)) {
    base = fromBasename(str)
  } else if (name.length > 0) {
    base = name + (path ? fromBasename(path) : '')
  }
  
  return base
    .split(/[-_\/]/g)
    .map((x, i) => (i > 0 && x.length > 0 ? x[0].toUpperCase() + x.slice(1) : x))
    .join('')
    .replace(/[^\w]/gi, '')
}

// =============================================================================
// Input Code Generation
// =============================================================================

/**
 * Parse share URL query params into input code.
 * 
 * Combines:
 * - `q` / `query`: Package exports
 * - `treeshake`: Specific exports per package
 * - `share`: LZ-compressed additional code
 * - `text`: Plaintext additional code
 */
export function parseShareURLQuery(
  query: string | undefined,
  treeshake: string | undefined,
  share: string | undefined,
  text: string | undefined
): string {
  const counts = new Map<string, number>()
  let result = ''

  if (query) {
    const queryArr = query.trim().split(',')
    const treeshakeArr = parseTreeshakeExports((treeshake ?? '').trim())
    const queryArrLen = queryArr.length

    result +=
      '// Click Build for the Bundled, Minified & Compressed package size\n' +
      queryArr
        .map((q, i) => {
          const treeshakeExports =
            treeshakeArr[i] && treeshakeArr[i].trim() !== '*'
              ? treeshakeArr[i].trim().split(',').join(', ')
              : '*'

          // Extract declaration mode: (import)pkg or (export)pkg or just pkg
          const match = /^(\((.*)\))?(.*)/.exec(q)!
          const declaration = match[2] || 'export'
          const module = match[3]

          // Track duplicate module imports for unique naming
          if (!counts.has(module)) counts.set(module, 0)
          const count = counts.set(module, counts.get(module)! + 1).get(module)! - 1
          const countStr = count <= 0 ? '' : String(count)

          // Generate export/import statement
          const moduleStr = JSON5.stringify(module)
          const needsAlias = declaration === 'import' || queryArrLen > 1

          let line = `${declaration} ${treeshakeExports} from ${moduleStr};`

          // Add default export if no specific treeshake
          if ((treeshake ?? '').trim().length <= 0) {
            const defaultAlias = needsAlias ? `as ${getModuleName(module)}Default${countStr} ` : ''
            line += `\n${declaration} { default ${defaultAlias}} from ${moduleStr};`
          }

          return line
        })
        .join('\n')
  }

  // Decompress share param (LZ-string encoded)
  if (share) {
    try {
      result += '\n' + decompressFromURL(share.trim())
    } catch (e) {
      console.warn('[parse-query] Failed to decompress share param:', e)
    }
  }

  // Parse text param (JSON5 string or raw)
  if (text) {
    try {
      // Support both quoted and unquoted plaintext
      const isQuoted = /^["']/.test(text) && /["']$/.test(text)
      const parsed = isQuoted
        ? JSON5.parse(text)
        : JSON5.parse(JSON5.stringify(text).replace(/\\\\/g, '\\'))
      result += '\n' + parsed
    } catch (_) {
      // Fallback to raw text
      result += '\n' + text
    }
  }

  return result.trim()
}

// =============================================================================
// Config Parsing
// =============================================================================

/**
 * Parse config query param into build configuration object.
 */
export function parseConfig(configStr: string | undefined): Record<string, unknown> {
  if (!configStr) return {}
  
  try {
    return deepMerge({}, JSON5.parse(configStr))
  } catch (e) {
    console.warn('[parse-query] Failed to parse config:', e)
    return {}
  }
}

// =============================================================================
// Main Normalizer
// =============================================================================

/**
 * Normalize raw query parameters into structured bundle configuration.
 */
export function normalizeBundleQuery(raw: BundleQuery): NormalizedBundleQuery {
  const queryStr = raw.q ?? raw.query ?? DEFAULT_PACKAGE
  const treeshakeStr = raw.treeshake
  const shareStr = raw.share
  const textStr = raw.text

  // Parse packages and their import/export modes
  const packageEntries = queryStr.split(',').map((q) => {
    const match = /^(\((\w+)\))?(.*)/.exec(q.trim())!
    const mode = (match[2] || 'export') as 'import' | 'export'
    const pkg = match[3]
    return [pkg, mode] as [string, 'import' | 'export']
  })

  const packages = packageEntries.map(([pkg]) => pkg)
  const modules = packageEntries

  // Parse treeshake
  const treeshakeExports = parseTreeshakeExports(
    decodeURIComponent(treeshakeStr ?? '')
      .trim()
      .replace(/\s{2,}/g, ' ')
  )
  const uniqueTreeshake = Array.from(new Set(treeshakeExports))
  const exportAll = !treeshakeStr || isExportAll(uniqueTreeshake)

  // Generate input code
  const hasExplicitInput = Boolean(shareStr || textStr)
  const inputCode = parseShareURLQuery(
    hasExplicitInput ? undefined : queryStr,
    treeshakeStr,
    shareStr,
    textStr
  ) || DEFAULT_INPUT

  // Parse config
  const config = parseConfig(raw.config)

  // Resolve boolean flags
  const tsx = Boolean(raw.tsx || raw.jsx || (config as Record<string, unknown>).tsx)
  
  // Minify: explicit minify=true/false, or inverse of pretty
  let minify: boolean | null = null
  if (raw.minify !== undefined) {
    minify = raw.minify
  } else if (raw.pretty !== undefined) {
    minify = raw.pretty === false
  }

  // Sourcemap
  const sourcemap = raw.sourcemap ?? null

  // Format
  const format = raw.format ?? null

  // Feature flags
  const polyfill = Boolean(raw.polyfill)
  const metafile = Boolean(
    raw.metafile ||
    raw.analysis ||
    raw.analyze ||
    (config as Record<string, unknown>).analysis
  )

  return {
    packages,
    modules,
    treeshakeExports: uniqueTreeshake,
    exportAll,
    inputCode,
    config,
    tsx,
    minify,
    sourcemap,
    format,
    polyfill,
    metafile,
  }
}