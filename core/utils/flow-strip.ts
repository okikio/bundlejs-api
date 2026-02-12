/**
 * Flow Type Stripping
 *
 * Detects and removes Flow type annotations from JavaScript source files.
 *
 * React Native and the broader Metro/Expo ecosystem ship `.js` files
 * containing raw Flow type annotations (e.g. `import typeof`, `type` casts,
 * parameter type annotations). esbuild cannot parse these, so we need to
 * strip them before the bundler processes the file.
 *
 * ## Why not OXC?
 *
 * OXC's parser explicitly rejects Flow syntax — it detects `@flow` pragmas
 * and emits "Flow is not supported". OXC only handles TypeScript type
 * stripping. See: https://github.com/oxc-project/oxc
 *
 * ## Strategy
 *
 * We use `flow-remove-types` (npm package from the official Flow team).
 * It's built on `hermes-parser` (Meta's JS engine parser compiled to WASM),
 * understands all Flow syntax, and produces clean output.
 *
 * For cases where the full parser isn't available, a lightweight regex
 * fallback handles the most common patterns (`import typeof`, etc.).
 *
 * ## Integration Points
 *
 * - `HttpPlugin.onLoad`: Fetched URL content is checked before passing to esbuild.
 * - `VirtualFileSystemPlugin.onLoad`: Tarball-extracted files are checked too.
 *
 * @module
 */

import flowRemoveTypes from "flow-remove-types"

const textDecoder = new TextDecoder();

/** Decode bytes to string, handling ArrayBufferLike generics */
function decodeBytes(buf: Uint8Array | ArrayBufferLike): string {
  // deno-lint-ignore no-explicit-any
  return textDecoder.decode(buf as any);
}

// ============================================================================
// Flow Detection
// ============================================================================

/**
 * Byte sequences for `@flow` pragma detection.
 *
 * Flow files are expected to have a `@flow` pragma within the first
 * comment block. We scan the first ~4KB for pragmas to avoid full-file
 * scans on large non-Flow files.
 */
const FLOW_PRAGMA_PATTERN = /(?:\/\/\s*@flow\b|\/\*[\s\S]*?@flow\b[\s\S]*?\*\/)/;

/**
 * Heuristic patterns that indicate unambiguous Flow-specific syntax.
 *
 * These catch files that use Flow syntax but lack a pragma
 * (e.g., some React Native internals). Each pattern is chosen for
 * near-zero false positives in standard JS or TypeScript:
 *
 * - `import typeof` — invalid in both TS and standard JS
 * - `opaque type`   — Flow-only declaration keyword
 * - `$Exact`, `$Diff`, etc. — Flow utility type prefixes
 */
const FLOW_SYNTAX_PATTERNS: RegExp[] = [
  /\bimport\s+typeof\b/,       // `import typeof Foo from ...`
  /\bopaque\s+type\b/,         // `opaque type Foo = ...` or `declare opaque type`
  /\$(?:Exact|Diff|ObjMap|ObjMapi|TupleMap|Keys|Values|ElementType|Call|ReadOnly|Shape|Exports)\b/,  // Flow utility types used inline
];

/**
 * Known npm packages that ship Flow source (not compiled).
 *
 * Some packages don't include `@flow` pragmas in every file but still
 * use Flow syntax throughout. This list provides a fast path for
 * known-Flow packages.
 */
const KNOWN_FLOW_PACKAGES = new Set([
  "react-native",
  // Could expand as needed:
  // "fbjs", "react-native-web", etc.
]);

/**
 * Detect if content is likely a Flow-typed JavaScript file.
 *
 * Detection strategy (ordered by cost):
 * 1. Check for `@flow` pragma in the first ~4KB (fast)
 * 2. Scan for unambiguous Flow-only syntax patterns (moderate)
 *
 * @param content  Source code as string or binary
 * @param opts     Optional hints (package name, URL) for known-package fast path
 * @returns true if the file likely contains Flow type annotations
 */
export function containsFlow(
  content: string | Uint8Array,
  opts?: { packageName?: string; url?: string }
): boolean {
  // Fast path: known Flow packages
  if (opts?.packageName && KNOWN_FLOW_PACKAGES.has(opts.packageName)) {
    return true;
  }

  // URL-based heuristic for react-native
  if (opts?.url) {
    for (const pkg of KNOWN_FLOW_PACKAGES) {
      if (opts.url.includes(`/${pkg}/`) || opts.url.includes(`/${pkg}@`)) {
        return true;
      }
    }
  }

  const text = typeof content === "string" ? content : decodeBytes(content);

  // Check for @flow pragma (typically in first few KB)
  const header = text.length > 4096 ? text.slice(0, 4096) : text;
  if (FLOW_PRAGMA_PATTERN.test(header)) {
    return true;
  }

  // Check for unambiguous Flow syntax patterns.
  // Each pattern is chosen for near-zero false positives in standard JS / TypeScript.
  for (const pattern of FLOW_SYNTAX_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return false;
}


// ============================================================================
// Regex-based Fallback Stripper
// ============================================================================

/**
 * Lightweight regex-based Flow type stripper.
 *
 * This is a **best-effort fallback** for when `flow-remove-types` is
 * unavailable. It handles the most common patterns that cause esbuild
 * parse failures:
 *
 * - `import typeof X from '...'` → `import X from '...'`
 * - `import type { X } from '...'` → removed entirely
 * - `// @flow` / `/* @flow * /` pragmas → removed
 * - Type annotations on function parameters → whitespace-replaced
 *
 * **This will NOT handle all Flow syntax.** Complex patterns like
 * `opaque type`, inline type casts, and generic annotations will
 * still cause esbuild errors.
 */
function regexStripFlow(source: string): string {
  let result = source;

  // Remove @flow pragma comments
  result = result.replace(/\/\/\s*@flow\b[^\n]*/g, match => " ".repeat(match.length));
  result = result.replace(/\/\*[\s\S]*?@flow\b[\s\S]*?\*\//g, match =>
    match.replace(/[^\n]/g, " ")
  );

  // `import typeof X from '...'` → `import        X from '...'`
  // `import typeof { X } from '...'` → `import         { X } from '...'`
  result = result.replace(
    /\bimport\s+typeof\b/g,
    (match) => "import" + " ".repeat(match.length - 6)
  );

  // `import type { ... } from '...'` → whitespace
  // `import type Foo from '...'` → whitespace
  result = result.replace(
    /^([ \t]*)import\s+type\s+(?:\{[^}]*\}|\w+)\s+from\s+['"][^'"]+['"];?\s*$/gm,
    (match) => match.replace(/[^\n]/g, " ")
  );

  // `export type { ... }` → whitespace
  result = result.replace(
    /^([ \t]*)export\s+type\s*\{[^}]*\}\s*(?:from\s+['"][^'"]+['"])?\s*;?\s*$/gm,
    (match) => match.replace(/[^\n]/g, " ")
  );

  return result;
}

// ============================================================================
// Source Map Helpers
// ============================================================================

/**
 * Source Map v3 shape returned by `flow-remove-types`.
 *
 * `flow-remove-types` generates maps via `.generateMap()`. The mappings
 * are only populated when `pretty: true` — in non-pretty mode,
 * whitespace replacement preserves all line/column positions, making
 * the map trivial (identity mapping).
 *
 * We augment the raw map with `sources` (the original filename) and
 * `sourcesContent` (the original source text) so that downstream
 * consumers (esbuild, browser devtools) can display the original code.
 */
export interface FlowSourceMap {
  version: 3;
  sources: string[];
  sourcesContent?: string[];
  names: string[];
  mappings: string;
  file?: string;
}

/**
 * Encode a v3 source map as a `data:` URI for inline embedding.
 *
 * esbuild's `onLoad` has no dedicated `sourceMap` field — the
 * convention is to append `//# sourceMappingURL=data:...` to
 * the returned `contents` string. esbuild parses the comment
 * and folds it into the final bundle source map.
 *
 * @param map  A v3 source map object
 * @returns    A data URI string: `data:application/json;charset=utf-8;base64,<payload>`
 */
function sourceMapToDataUrl(map: FlowSourceMap): string {
  const json = JSON.stringify(map);
  const encoded = btoa(json);
  return `data:application/json;charset=utf-8;base64,${encoded}`;
}

/**
 * Append an inline `//# sourceMappingURL=` comment to source code.
 *
 * @param code  Transformed source code
 * @param map   v3 source map to embed
 * @returns     Source code with the inline source map comment appended
 */
function appendInlineSourceMap(code: string, map: FlowSourceMap): string {
  return `${code}\n//# sourceMappingURL=${sourceMapToDataUrl(map)}`;
}

// ============================================================================
// Public API
// ============================================================================

/** Options for {@link stripFlowTypes}. */
export interface StripFlowOptions {
  /** Remove whitespace left by type erasure (default: true). */
  pretty?: boolean;
  /** Strip all files, not just those with `@flow` pragma (default: true). */
  all?: boolean;
  /**
   * Generate a v3 source map alongside the stripped output.
   *
   * When `true`, the returned object includes a `sourceMap` field.
   * Source maps are only meaningful when `pretty` is also `true` —
   * non-pretty mode preserves all positions via whitespace, so the
   * map would be an identity mapping.
   */
  sourceMap?: boolean;
  /**
   * Filename to record in `sources[0]` of the generated map.
   * Defaults to `"source.js"`.
   */
  sourceFileName?: string;
}

/** Result of {@link stripFlowTypes}. */
export interface StripFlowResult {
  /** The transformed source code with Flow annotations removed. */
  code: string;
  /**
   * A v3 source map mapping the transformed code back to the original.
   * Only present when `opts.sourceMap` is `true` and `flow-remove-types`
   * was used (the regex fallback does not produce maps).
   */
  sourceMap?: FlowSourceMap;
}

/**
 * Strip Flow type annotations from JavaScript source code.
 *
 * Attempts to use `flow-remove-types` for complete stripping.
 * Falls back to regex-based stripping if the package isn't available.
 *
 * @param source  Source code (string or Uint8Array)
 * @param opts    Stripping and source-map options
 * @returns       The stripped code and an optional source map
 */
export function stripFlowTypes(
  source: string | Uint8Array,
  opts?: StripFlowOptions
): StripFlowResult {
  const text = typeof source === "string" ? source : decodeBytes(source);

  const { pretty = true, all = true, sourceMap = false, sourceFileName } = opts ?? {};

  // Try the full parser-based stripper first
  if (flowRemoveTypes) {
    try {
      const result = flowRemoveTypes(text, { pretty, all });
      const code = result.toString();

      // Generate source map when requested.
      // `flow-remove-types` only produces meaningful mappings when
      // `pretty: true` — in non-pretty mode every position is
      // already preserved via whitespace replacement.
      let map: FlowSourceMap | undefined;
      if (sourceMap) {
        try {
          map = result.generateMap() as FlowSourceMap;

          // Patch the raw map with caller-supplied filename and
          // original source content so devtools can show the
          // pre-transformation code.
          if (sourceFileName) {
            map.sources = [sourceFileName];
          }
          map.sourcesContent = [text];
        } catch {
          // If map generation fails, proceed without a map.
          // This is non-fatal — the stripped code is still valid.
        }
      }

      return { code, sourceMap: map };
    } catch {
      // If flow-remove-types fails (e.g., parse error), fall through to regex
    }
  }

  // Fallback: regex-based stripping.
  // The regex fallback does NOT produce source maps — it would require
  // tracking every replacement offset, which defeats the "lightweight
  // fallback" purpose. Callers should prefer the full parser path.
  return { code: regexStripFlow(text) };
}

/** Options for {@link maybeStripFlow}. */
export interface MaybeStripFlowOptions {
  /** Package name hint for known-package fast path. */
  packageName?: string;
  /** URL hint for URL-based detection heuristic. */
  url?: string;
  /** Remove whitespace left by type erasure (default: true). */
  pretty?: boolean;
  /**
   * Generate a source map and embed it as an inline
   * `//# sourceMappingURL=data:...` comment in the returned contents.
   *
   * This lets esbuild fold the Flow transformation map into the
   * final bundle source map, so devtools show the *original* Flow
   * source rather than the stripped intermediate.
   *
   * Only effective when `flow-remove-types` is used (not the regex
   * fallback) and `pretty` is `true`.
   */
  sourceMap?: boolean;
}

/** Result of {@link maybeStripFlow}. */
export interface MaybeStripFlowResult {
  /**
   * Processed file contents.
   * - Original `Uint8Array` when no Flow was detected (zero-copy).
   * - Stripped `string` (potentially with inline source map) when Flow was removed.
   */
  contents: string | Uint8Array;
  /** Whether Flow annotations were detected and stripped. */
  wasStripped: boolean;
}

/**
 * Conditionally strip Flow types from content.
 *
 * Only processes the content if Flow syntax is detected.
 * Returns the original content (as Uint8Array) if no Flow is found,
 * or the stripped string if Flow was detected and removed.
 *
 * When `sourceMap: true`, the stripped output includes an inline
 * `//# sourceMappingURL=data:...` comment that esbuild folds into
 * the final bundle source map. This makes it possible to debug the
 * original Flow source in browser devtools even after stripping.
 *
 * @param content   Raw file content
 * @param opts      Detection hints (packageName, url) and strip/sourceMap options
 * @returns         Processed contents and a `wasStripped` flag
 */
export function maybeStripFlow(
  content: Uint8Array,
  opts?: MaybeStripFlowOptions
): MaybeStripFlowResult {
  if (!containsFlow(content, opts)) {
    return { contents: content, wasStripped: false };
  }

  const { code, sourceMap } = stripFlowTypes(content, {
    pretty: opts?.pretty ?? true,
    all: true,
    sourceMap: opts?.sourceMap ?? false,
    sourceFileName: opts?.url,
  });

  // When a source map was produced, embed it inline so esbuild can
  // incorporate it into the final bundle map.
  const contents = sourceMap
    ? appendInlineSourceMap(code, sourceMap)
    : code;

  return { contents, wasStripped: true };
}
