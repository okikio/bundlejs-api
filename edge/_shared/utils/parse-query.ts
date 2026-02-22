/**
 * Query parsing utilities for bundlejs (V4 Spec v1).
 *
 * Transforms URL query parameters into normalized bundle configuration.
 *
 * ## URL Structure
 *
 * ```
 * /?v=1&q=<modules>&base=<default-bracket>&treeshake=<overrides>&share=<lz>&text=<raw>&config=<json5>
 * ```
 *
 * ## Bracket Grammar
 *
 * Each bracket contains one or more emit-items separated by `|`:
 *
 * ```
 * bracket    = emit_item ("|" emit_item)*
 * emit_item  = [phase] clause [attributes]
 *
 * phase      = "defer"               (import: namespace/auto/star only)
 *            | "source"              (import: identifier/auto only)
 *            | "type"                (import+export: all clauses except bare)
 *
 * clause     = "bare"                → side-effect import / degrades on export
 *            | "auto"                → safe auto-named namespace
 *            | "default" ["as" <n>]  → default surface (auto or explicit name)
 *            | "*"                   → namespace auto-named (import) / re-export all (export)
 *            | "* as" <n>            → explicit namespace
 *            | "{ <names> }"         → named (supports "type", "as")
 *            | "id:" <n>             → identifier (keyword escape hatch)
 *            | <n>                   → default binding / aliased default export
 *
 * attributes = "with" ["{"] kv ("," kv)* ["}"]
 *              where kv = key ":" value
 * ```
 *
 * ## Slot Resolution
 *
 * For each module q[i]:
 * 1. If treeshake provides an override at index i → use it
 * 2. Else → use `base` param
 * 3. If `base` missing → use `auto|default`
 *
 * ## Phase Constraints
 *
 * - `defer`: import only, namespace/auto/star. Invalid combos drop phase.
 * - `source`: import only, identifier/auto. Invalid combos drop phase.
 * - `type`: import AND export, all clauses except bare. Invalid drops phase.
 * - All phases silently dropped on export EXCEPT `type`.
 */

import type { BundleQuery } from '../bundle/schema.ts'
import { lzstring, parsePackageName, deepMerge } from '@bundle/utils'
import { basename, extname } from '@bundle/utils/path'
import JSON5 from '@bundle/utils/json5'

const { decompressFromURL } = lzstring

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_PACKAGE = 'spring-easing'
export const DEFAULT_BASE = 'auto|default'
export const SPEC_VERSION = 1

// =============================================================================
// Types
// =============================================================================

export type ModuleEntry = {
  pkg: string
  mode: 'import' | 'export'
}

export type ParsedEmitItem = {
  phase: 'defer' | 'source' | 'type' | null
  specifier: ClauseSpecifier
  attributes: Record<string, string> | null
}

export type ParsedBracket = {
  items: ParsedEmitItem[]
}

export type ClauseSpecifier =
  | { kind: 'bare' }
  | { kind: 'auto' }
  | { kind: 'star' }
  | { kind: 'namespace'; name: string }
  | { kind: 'named'; names: string }
  | { kind: 'default-surface'; name: string | null }
  | { kind: 'identifier'; name: string }

export type NormalizedBundleQuery = {
  version: number
  packages: string[]
  modules: ModuleEntry[]
  treeshakeExports: string[]
  exportAll: boolean
  inputCode: string
  config: Record<string, unknown>
  tsx: boolean
  minify?: boolean
  sourcemap?: '' | 'true' | 'false' | 'inline' | 'external' | 'both'
  format?: 'esm' | 'cjs' | 'iife'
  polyfill: boolean
  metafile: boolean
}

// =============================================================================
// Treeshake Splitting (positional + sparse)
// =============================================================================

/**
 * Split treeshake string into per-index raw bracket strings.
 *
 * Auto-detects format:
 * - Sparse: contains `N:[` → parse as 0-based index:content pairs
 * - Positional: split on bracket boundaries, empty slots supported via `,, `
 *
 * Returns sparse array. `undefined` = "no override, use base".
 * Empty string = "explicit empty bracket, resolves to [auto]".
 */
export function splitTreeshake(str: string): Array<string | undefined> {
  const trimmed = (str ?? '').trim()
  if (!trimmed) return []

  if (/^\d+\s*:\s*\[/.test(trimmed)) {
    return parseSparseTreeshake(trimmed)
  }

  return parsePositionalTreeshake(trimmed)
}

function parseSparseTreeshake(str: string): Array<string | undefined> {
  const result: Array<string | undefined> = []
  const entries = splitOnChar(str, ';')

  for (const entry of entries) {
    const match = /^(\d+)\s*:\s*\[(.*)]\s*$/.exec(entry.trim())
    if (!match) continue
    const index = parseInt(match[1], 10)
    const content = match[2].trim()
    while (result.length <= index) result.push(undefined)
    result[index] = content
  }

  return result
}

function parsePositionalTreeshake(str: string): Array<string | undefined> {
  const result: Array<string | undefined> = []
  let depth = 0
  let current = ''

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]

    if (ch === '[') {
      depth++
      if (depth === 1) continue // skip opening bracket
    } else if (ch === ']') {
      depth--
      if (depth === 0) {
        result.push(current.trim())
        current = ''
        if (str[i + 1] === ',') i++ // skip trailing comma
        continue
      }
    } else if (ch === ',' && depth === 0) {
      // Empty slot
      if (current.trim() === '') {
        result.push('')
      } else {
        result.push(current.trim())
      }
      current = ''
      continue
    }

    current += ch
  }

  if (current.trim()) result.push(current.trim())
  return result
}

/** Split string on a char while respecting `{` `}` nesting. */
function splitOnChar(str: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''

  for (const ch of str) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === sep && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }

  if (current.trim()) parts.push(current)
  return parts
}

// Backward compat aliases
export { splitTreeshake as parseTreeshakeExports }

export function splitTreeshakeBrackets(str: string): string[] {
  return splitTreeshake(str).map((s) => s ?? '').filter(Boolean)
}

// =============================================================================
// Separator Normalization
// =============================================================================

/**
 * Normalize separators inside bracket content.
 *
 * URLSearchParams decodes `+` to space. We additionally treat `_` as a space
 * between known keyword boundaries, but preserve it inside identifiers.
 *
 * Conservative approach: `_` only between keywords, not inside names like `my_lib`.
 */
function normalizeSeparators(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    // Phase keywords followed by _
    .replace(/^(defer|source|type)_/i, '$1 ')
    // * _as_ or *as (compact) → * as
    .replace(/\*[\s_]*as[\s_]+/g, '* as ')
    .replace(/\*as(?=[A-Z_$])/g, '* as ')
    // default_as → default as
    .replace(/\bdefault[\s_]+as[\s_]+/g, 'default as ')
    // } followed by _ or touching with → } with
    .replace(/}[\s_]*with(?=[\s_{]|$)/g, '} with')
    // keyword followed by _with → keyword with
    .replace(/\b(bare|auto|\*)[\s_]+with(?=[\s_{]|$)/g, '$1 with')
}

// =============================================================================
// Bracket & Emit-Item Parsing
// =============================================================================

/**
 * Parse a bracket entry (may contain multiple emit-items via `|`).
 * Empty/missing bracket resolves to `[auto]`.
 */
export function parseBracket(raw: string): ParsedBracket {
  if (!raw || !raw.trim()) {
    return { items: [{ phase: null, specifier: { kind: 'auto' }, attributes: null }] }
  }

  const parts = splitOnChar(raw, '|')
  const items = parts.map(parseEmitItem)

  return {
    items: items.length > 0
      ? items
      : [{ phase: null, specifier: { kind: 'auto' }, attributes: null }],
  }
}

/**
 * Parse a single emit-item: `[phase] clause [attributes]`
 */
export function parseEmitItem(raw: string): ParsedEmitItem {
  let remaining = normalizeSeparators(raw)

  // --- Phase extraction ---
  let phase: ParsedEmitItem['phase'] = null

  // type phase: `type *`, `type { ... }`, `type X`, `type auto`, `type default`
  const typeMatch = /^type[\s_]+/i.exec(remaining)
  if (typeMatch && !remaining.startsWith('type:') && remaining !== 'type') {
    const afterPhase = remaining.slice(typeMatch[0].length)
    if (afterPhase.length > 0) {
      phase = 'type'
      remaining = afterPhase
    }
  }

  // defer phase: `defer *`, `defer auto`, `defer*asX`
  if (!phase) {
    const deferMatch = /^defer[\s_]*/i.exec(remaining)
    if (deferMatch && !remaining.startsWith('defer:') && remaining !== 'defer') {
      const afterPhase = remaining.slice(deferMatch[0].length)
      if (afterPhase.length > 0) {
        phase = 'defer'
        remaining = afterPhase
      }
    }
  }

  // source phase: `source X`, `source:X`, `source auto`
  if (!phase) {
    const sourceColonMatch = /^source:/i.exec(remaining)
    const sourceSpaceMatch = /^source[\s_]+/i.exec(remaining)
    if (sourceColonMatch) {
      phase = 'source'
      remaining = remaining.slice(sourceColonMatch[0].length)
    } else if (sourceSpaceMatch && remaining !== 'source') {
      const afterPhase = remaining.slice(sourceSpaceMatch[0].length)
      if (afterPhase.length > 0) {
        phase = 'source'
        remaining = afterPhase
      }
    }
  }

  // --- Attributes extraction ---
  let attributes: Record<string, string> | null = null
  const withIdx = findWithKeyword(remaining)
  if (withIdx !== -1) {
    const attrStr = remaining.slice(withIdx + 4).trim()
    attributes = parseAttributeString(attrStr)
    remaining = remaining.slice(0, withIdx).trim()
  }

  // --- Specifier parsing ---
  const specifier = parseSpecifier(remaining)

  return { phase, specifier, attributes }
}

/**
 * Find `with` keyword at top-level (not inside braces).
 * Matches `with{`, `with `, `with_` at brace depth 0 with word boundary.
 */
function findWithKeyword(str: string): number {
  let depth = 0
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{') depth++
    else if (str[i] === '}') depth--
    else if (depth === 0 && i + 4 <= str.length) {
      const slice = str.slice(i, i + 4)
      if (slice.toLowerCase() === 'with') {
        const after = str[i + 4]
        const before = str[i - 1]
        const validBefore = i === 0 || /[\s_}]/.test(before)
        const validAfter = after === '{' || after === ' ' || after === '_' || after === undefined
        if (validBefore && validAfter) return i
      }
    }
  }
  return -1
}

/**
 * Parse `{key:value, key:value}` or `key:value, key:value` attribute string.
 */
function parseAttributeString(str: string): Record<string, string> | null {
  let inner = str.trim()
  if (inner.startsWith('{') && inner.endsWith('}')) {
    inner = inner.slice(1, -1).trim()
  }

  const result: Record<string, string> = {}
  for (const pair of inner.split(',')) {
    const colonIdx = pair.indexOf(':')
    if (colonIdx === -1) continue
    const key = pair.slice(0, colonIdx).trim()
    const value = pair.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key) result[key] = value
  }

  return Object.keys(result).length > 0 ? result : null
}

function parseSpecifier(str: string): ClauseSpecifier {
  const trimmed = str.trim()
  if (!trimmed) return { kind: 'auto' }

  if (trimmed === 'bare') return { kind: 'bare' }
  if (trimmed === 'auto') return { kind: 'auto' }
  if (trimmed === '*') return { kind: 'star' }

  if (trimmed === 'default') return { kind: 'default-surface', name: null }
  const defaultAsMatch = /^default\s+as\s+(.+)$/i.exec(trimmed)
  if (defaultAsMatch) return { kind: 'default-surface', name: defaultAsMatch[1].trim() }

  const nsMatch = /^\*\s*as\s+(.+)$/.exec(trimmed)
  if (nsMatch) return { kind: 'namespace', name: nsMatch[1].trim() }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return { kind: 'named', names: trimmed.slice(1, -1).trim() }
  }

  if (trimmed.startsWith('id:')) {
    return { kind: 'identifier', name: trimmed.slice(3).trim() }
  }

  return { kind: 'identifier', name: trimmed }
}

// =============================================================================
// Phase Validation
// =============================================================================

/**
 * Validate phase against specifier + mode constraints.
 *
 * - `defer`: import only, namespace/auto/star. Otherwise silently dropped.
 * - `source`: import only, identifier/auto. Otherwise silently dropped.
 * - `type`: import AND export, all clauses except bare. Otherwise dropped.
 *
 * Returns validated phase or null.
 */
function validatePhase(
  phase: ParsedEmitItem['phase'],
  specifier: ClauseSpecifier,
  mode: 'import' | 'export',
): ParsedEmitItem['phase'] {
  if (!phase) return null

  if (phase === 'type') {
    // type is valid on both import and export
    // but not with bare (import type "pkg" is not valid TS)
    if (specifier.kind === 'bare') return null
    return 'type'
  }

  // defer and source are import-only
  if (mode === 'export') return null

  if (phase === 'defer') {
    if (specifier.kind === 'namespace' || specifier.kind === 'auto' || specifier.kind === 'star') {
      return 'defer'
    }
    return null
  }

  if (phase === 'source') {
    if (specifier.kind === 'identifier' || specifier.kind === 'auto') {
      return 'source'
    }
    return null
  }

  return null
}

// =============================================================================
// Module Name Utilities
// =============================================================================

export function fromBasename(path: string): string {
  const clean = path.replace(/^https?:\/\//, '')
  return basename(clean, extname(clean))
}

/**
 * Generate a clean JS variable name from a package specifier.
 *
 * @example
 * ```ts
 * getModuleName('@okikio/animate')                // 'okikioAnimate'
 * getModuleName('https://esm.sh/lodash/debounce') // 'debounce'
 * getModuleName('@pkg/lib@2.1.0')                 // 'pkgLib_2_1_0'
 * getModuleName('3d-force-graph')                  // '_3dForceGraph'
 * ```
 */
export function getModuleName(str: string): string {
  let base = str
  let version: string | null = null

  try {
    const parsed = parsePackageName(str)
    base = parsed.name + (parsed.path ? fromBasename(parsed.path) : '')
    version = parsed.version
  } catch {
    // URL or unparseable
  }

  if (/^https?:\/\//.test(str)) {
    base = fromBasename(str)
  }

  let result = base
    .split(/[-_\/]/g)
    .map((seg, i) =>
      i > 0 && seg.length > 0 ? seg[0].toUpperCase() + seg.slice(1) : seg
    )
    .join('')
    .replace(/[^\w]/gi, '')

  if (version) {
    result += '_' + version.replace(/[^a-zA-Z0-9_]/g, '_')
  }

  if (/^\d/.test(result)) {
    result = '_' + result
  }

  return result
}

// =============================================================================
// Statement Generation
// =============================================================================

function formatAttrs(attrs: Record<string, string> | null): string {
  if (!attrs) return ''
  const pairs = Object.entries(attrs)
    .map(([k, v]) => `${k}: "${v}"`)
    .join(', ')
  return ` with { ${pairs} }`
}

function generateImportStatement(
  moduleName: string,
  item: ParsedEmitItem,
): string[] {
  const attrs = formatAttrs(item.attributes)
  const phase = validatePhase(item.phase, item.specifier, 'import')
  const phaseStr = phase ? `${phase} ` : ''
  const alias = getModuleName(moduleName)

  switch (item.specifier.kind) {
    case 'bare':
      return [`import ${phaseStr}"${moduleName}"${attrs};`]

    case 'auto':
    case 'star':
      return [`import ${phaseStr}* as ${alias} from "${moduleName}"${attrs};`]

    case 'namespace':
      return [`import ${phaseStr}* as ${item.specifier.name} from "${moduleName}"${attrs};`]

    case 'named':
      return [`import ${phaseStr}{ ${item.specifier.names} } from "${moduleName}"${attrs};`]

    case 'default-surface': {
      const name = item.specifier.name ?? `${alias}Default`
      return [`import ${phaseStr}${name} from "${moduleName}"${attrs};`]
    }

    case 'identifier':
      return [`import ${phaseStr}${item.specifier.name} from "${moduleName}"${attrs};`]
  }
}

function generateExportStatement(
  moduleName: string,
  item: ParsedEmitItem,
): string[] {
  const attrs = formatAttrs(item.attributes)
  // Only type phase survives on exports
  const phase = validatePhase(item.phase, item.specifier, 'export')
  const phaseStr = phase ? `${phase} ` : ''
  const alias = getModuleName(moduleName)

  switch (item.specifier.kind) {
    case 'bare':
      // bare on export degrades to auto
      return [`export ${phaseStr}* as ${alias} from "${moduleName}"${attrs};`]

    case 'auto':
      return [`export ${phaseStr}* as ${alias} from "${moduleName}"${attrs};`]

    case 'star':
      return [`export ${phaseStr}* from "${moduleName}"${attrs};`]

    case 'namespace':
      return [`export ${phaseStr}* as ${item.specifier.name} from "${moduleName}"${attrs};`]

    case 'named': {
      const names = item.specifier.names.trim()
      return [`export ${phaseStr}{ ${names} } from "${moduleName}"${attrs};`]
    }

    case 'default-surface': {
      const name = item.specifier.name ?? `${alias}Default`
      return [`export ${phaseStr}{ default as ${name} } from "${moduleName}"${attrs};`]
    }

    case 'identifier':
      return [`export ${phaseStr}{ default as ${item.specifier.name} } from "${moduleName}"${attrs};`]
  }
}

// =============================================================================
// Input Code Generation
// =============================================================================

/**
 * Build the full input code string from parsed query components.
 *
 * Slot resolution for each module q[i]:
 * 1. treeshake override at index i → use it
 * 2. else → base param
 * 3. else → DEFAULT_BASE ("auto|default")
 */
export function buildInputCode(
  query: string | undefined,
  treeshake: string | undefined,
  base: string | undefined,
  share: string | undefined,
  text: string | undefined,
): string {
  let result = ''

  if (query) {
    const queryArr = query.trim().split(',')
    const hasTreeshake = treeshake != null && treeshake.trim().length > 0

    // Parse treeshake overrides (sparse array)
    const overrides = hasTreeshake ? splitTreeshake(treeshake!) : []

    // Parse the base bracket (fallback for unoverridden slots)
    const baseBracket = parseBracket(base ?? DEFAULT_BASE)

    // Deduplicate when no treeshake AND no explicit base.
    // With overrides or custom base, dupes may be intentional.
    let entries: Array<{ raw: string; index: number }>
    if (!hasTreeshake && !base) {
      const seen = new Set<string>()
      entries = queryArr
        .map((raw, index) => ({ raw, index }))
        .filter(({ raw }) => {
          const pkg = raw.startsWith('(import)')
            ? raw.slice('(import)'.length)
            : raw
          if (seen.has(pkg)) return false
          seen.add(pkg)
          return true
        })
    } else {
      entries = queryArr.map((raw, index) => ({ raw, index }))
    }

    const lines = entries
      .map(({ raw, index }) => {
        const trimmed = raw.trim()
        const isImport = trimmed.startsWith('(import)')
        const moduleName = (isImport ? trimmed.slice('(import)'.length) : trimmed).trim()

        if (!moduleName) return ''

        // Slot resolution: override → base
        const overrideRaw = overrides[index]
        const bracket = overrideRaw !== undefined
          ? parseBracket(overrideRaw)
          : baseBracket

        const stmts = bracket.items.flatMap((item) =>
          isImport
            ? generateImportStatement(moduleName, item)
            : generateExportStatement(moduleName, item)
        )

        return stmts.join('\n')
      })
      .filter(Boolean)

    if (lines.length > 0) {
      result += '// Click Build for the Bundled, Minified & Compressed package size\n'
      result += lines.join('\n')
    }
  }

  if (share) {
    try {
      const decompressed = decompressFromURL(share.trim())
      if (decompressed) result += '\n' + decompressed
    } catch (e) {
      console.warn('[parse-query] Failed to decompress share param:', e)
    }
  }

  if (text) {
    try {
      const isQuoted = /^["']/.test(text) && /["']$/.test(text)
      const parsed = isQuoted
        ? JSON5.parse(text)
        : JSON5.parse(JSON5.stringify(text).replace(/\\\\/g, '\\'))
      result += '\n' + parsed
    } catch {
      result += '\n' + text
    }
  }

  return result.trim()
}

// =============================================================================
// Config & Helpers
// =============================================================================

export function parseConfig(configStr: string | undefined): Record<string, unknown> {
  if (!configStr) return {}
  try {
    return deepMerge({}, JSON5.parse(configStr))
  } catch (e) {
    console.warn('[parse-query] Failed to parse config:', e)
    return {}
  }
}

export function isExportAll(treeshakeArr: string[]): boolean {
  if (treeshakeArr.length === 0) return true
  return treeshakeArr.every((x) => /^\*$|^{\s*default\s*}$|^auto$|^$/.test(x))
}

// =============================================================================
// Main Normalizer
// =============================================================================

export function normalizeBundleQuery(raw: BundleQuery): NormalizedBundleQuery {
  // v is already transformed to number | undefined by schema
  const version = raw.v ?? SPEC_VERSION
  const queryStr = raw.q ?? raw.query ?? DEFAULT_PACKAGE
  const treeshakeStr = raw.treeshake
  const baseStr = raw.base
  const shareStr = raw.share
  const textStr = raw.text

  const modules: ModuleEntry[] = queryStr.split(',').map((q) => {
    const match = /^(?:\((\w+)\))?(.+)/.exec(q.trim())
    return {
      mode: (match?.[1] || 'export') as 'import' | 'export',
      pkg: match?.[2] ?? q.trim(),
    }
  })

  const packages = modules.map((m) => m.pkg)

  const treeshakeExports = splitTreeshakeBrackets(
    decodeURIComponent(treeshakeStr ?? '').trim().replace(/\s{2,}/g, ' ')
  )
  const uniqueTreeshake = [...new Set(treeshakeExports)]
  const exportAll = !treeshakeStr || isExportAll(uniqueTreeshake)

  const hasExplicitInput = Boolean(shareStr || textStr)
  const inputCode =
    buildInputCode(
      hasExplicitInput ? undefined : queryStr,
      treeshakeStr,
      baseStr,
      shareStr,
      textStr,
    ) || buildInputCode(DEFAULT_PACKAGE, undefined, DEFAULT_BASE, undefined, undefined)

  const config = parseConfig(raw.config)

  // tsx/jsx/polyfill/metafile are already booleans from schema transforms
  const tsx = raw.tsx || raw.jsx || Boolean((config as Record<string, unknown>).tsx)

  // minify/pretty are boolean | undefined from schema tri-bool transform
  let minify: boolean | undefined
  if (raw.minify !== undefined) {
    minify = raw.minify
  } else if (raw.pretty !== undefined) {
    minify = raw.pretty === false
  }

  const metafile =
    raw.metafile ||
    Boolean(raw.analysis) ||
    Boolean(raw.analyze) ||
    Boolean((config as Record<string, unknown>).analysis)

  return {
    version,
    packages,
    modules,
    treeshakeExports: uniqueTreeshake,
    exportAll,
    inputCode,
    config,
    tsx,
    minify,
    sourcemap: raw.sourcemap ?? undefined,
    format: raw.format ?? undefined,
    polyfill: raw.polyfill,
    metafile,
  }
}