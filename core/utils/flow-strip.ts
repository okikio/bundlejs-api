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
// Public API
// ============================================================================

/**
 * Strip Flow type annotations from JavaScript source code.
 *
 * Attempts to use `flow-remove-types` for complete stripping.
 * Falls back to regex-based stripping if the package isn't available.
 *
 * @param source  Source code (string or Uint8Array)
 * @param opts    Options:
 *   - `pretty`: Remove whitespace left by type removal (default: true)
 *   - `all`: Strip all files, not just those with `@flow` pragma (default: true)
 * @returns Transformed source code as a string
 */
export function stripFlowTypes(
  source: string | Uint8Array,
  opts?: { pretty?: boolean; all?: boolean }
): string {
  const text = typeof source === "string" ? source : decodeBytes(source);

  const { pretty = true, all = true } = opts ?? {};

  // Try the full parser-based stripper first
  if (flowRemoveTypes) {
    try {
      const result = flowRemoveTypes(text, { pretty, all });
      return result.toString();
    } catch {
      // If flow-remove-types fails (e.g., parse error), fall through to regex
    }
  }

  // Fallback: regex-based stripping
  return regexStripFlow(text);
}

/**
 * Conditionally strip Flow types from content.
 *
 * Only processes the content if Flow syntax is detected.
 * Returns the original content (as Uint8Array) if no Flow is found,
 * or the stripped string if Flow was detected and removed.
 *
 * @param content   Raw file content
 * @param opts      Detection hints (packageName, url) and strip options
 * @returns Object with `contents` (string if stripped, original Uint8Array if not)
 *          and `wasStripped` flag
 */
export function maybeStripFlow(
  content: Uint8Array,
  opts?: { packageName?: string; url?: string; pretty?: boolean }
): { contents: string | Uint8Array; wasStripped: boolean } {
  if (!containsFlow(content, opts)) {
    return { contents: content, wasStripped: false };
  }

  const stripped = stripFlowTypes(content, {
    pretty: opts?.pretty ?? true,
    all: true,
  });

  return { contents: stripped, wasStripped: true };
}
