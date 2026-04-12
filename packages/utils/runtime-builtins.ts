/**
 * Runtime Built-in Module Utilities
 *
 * Cross-runtime built-in module handling for Node.js, Deno, and Bun.
 * Provides detection, normalization, polyfill mapping, and external
 * configuration generation for bundlers like esbuild.
 *
 * This module helps bundlejs and similar tools properly handle built-in
 * modules across different JavaScript runtimes.
 *
 * @module
 *
 * @example Detection
 * ```ts
 * import { isBuiltin, getBuiltinInfo } from "./runtime-builtins.ts";
 *
 * isBuiltin("fs")             // true (Node.js)
 * isBuiltin("node:fs")        // true (Node.js with prefix)
 * isBuiltin("Deno.readFile")  // false (Deno global, not a module)
 *
 * getBuiltinInfo("path")
 * // { name: "path", category: "core", polyfill: "path-browserify", ... }
 * ```
 *
 * @example Polyfills
 * ```ts
 * import { getPolyfill, createPolyfillMap } from "./runtime-builtins.ts";
 *
 * getPolyfill("path")   // "path-browserify"
 * getPolyfill("fs")     // null (no browser polyfill)
 *
 * createPolyfillMap()
 * // { "path": "path-browserify", "node:path": "path-browserify", ... }
 * ```
 *
 * @example External Configuration
 * ```ts
 * import { createExternalPatterns } from "./runtime-builtins.ts";
 *
 * // For esbuild
 * createExternalPatterns({ runtime: "node" })
 * // ["fs", "node:fs", "path", "node:path", ...]
 *
 * createExternalPatterns({ runtime: "browser", polyfillable: true })
 * // ["child_process", "node:child_process", "cluster", ...] // Only non-polyfillable
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Supported runtime environments.
 */
export type RuntimeTarget = "node" | "deno" | "bun" | "browser" | "workerd";

/**
 * Built-in module categories.
 */
export type BuiltinCategory =
  | "core"         // Always available (fs, path, etc.)
  | "worker"       // Available in Worker threads
  | "deprecated"   // Deprecated modules (sys, punycode)
  | "experimental" // Experimental APIs (wasi, sqlite)
  | "internal";    // Internal modules (_http_agent, etc.)

/**
 * Information about a built-in module.
 */
export interface BuiltinInfo {
  /** Module name (without node: prefix) */
  name: string;
  /** Module category */
  category: BuiltinCategory;
  /** Browser polyfill package name (null if not polyfillable) */
  polyfill: string | null;
  /** Whether this module has subpath exports (e.g., fs/promises) */
  hasSubpaths: boolean;
  /** Notable subpaths */
  subpaths?: string[];
  /** Runtime support */
  runtimes: {
    node: boolean | "partial";
    deno: boolean | "partial";
    bun: boolean | "partial";
  };
}

/**
 * Polyfill configuration for bundlers.
 */
export interface PolyfillConfig {
  /** Module to polyfill */
  builtin: string;
  /** Polyfill package to use */
  package: string;
  /** Optional exports/conditions handling */
  exports?: string;
}

// =============================================================================
// Node.js Built-in Database
// =============================================================================

/**
 * Complete database of Node.js built-in modules with metadata.
 *
 * @example Reading the database
 * ```ts
 * NODE_BUILTINS["path"]
 * // {
 * //   name: "path",
 * //   category: "core",
 * //   polyfill: "path-browserify",
 * //   hasSubpaths: true,
 * //   subpaths: ["posix", "win32"],
 * //   runtimes: { node: true, deno: true, bun: true }
 * // }
 *
 * NODE_BUILTINS["child_process"]
 * // {
 * //   name: "child_process",
 * //   category: "core",
 * //   polyfill: null,  // Cannot be polyfilled in browser
 * //   hasSubpaths: false,
 * //   runtimes: { node: true, deno: "partial", bun: true }
 * // }
 * ```
 */
export const NODE_BUILTINS: Record<string, BuiltinInfo> = {
  // Core modules - filesystem & I/O
  fs: {
    name: "fs",
    category: "core",
    polyfill: null, // memfs/browserify-fs exist but are complex
    hasSubpaths: true,
    subpaths: ["promises"],
    runtimes: { node: true, deno: true, bun: true },
  },
  path: {
    name: "path",
    category: "core",
    polyfill: "path-browserify",
    hasSubpaths: true,
    subpaths: ["posix", "win32"],
    runtimes: { node: true, deno: true, bun: true },
  },
  os: {
    name: "os",
    category: "core",
    polyfill: "os-browserify",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - process & buffer
  process: {
    name: "process",
    category: "core",
    polyfill: "process",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  buffer: {
    name: "buffer",
    category: "core",
    polyfill: "buffer",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - crypto & security
  crypto: {
    name: "crypto",
    category: "core",
    polyfill: "crypto-browserify",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  tls: {
    name: "tls",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: "partial", bun: true },
  },

  // Core modules - networking
  http: {
    name: "http",
    category: "core",
    polyfill: "stream-http",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  https: {
    name: "https",
    category: "core",
    polyfill: "https-browserify",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  http2: {
    name: "http2",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: "partial", bun: "partial" },
  },
  net: {
    name: "net",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  dgram: {
    name: "dgram",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: "partial", bun: "partial" },
  },
  dns: {
    name: "dns",
    category: "core",
    polyfill: null,
    hasSubpaths: true,
    subpaths: ["promises"],
    runtimes: { node: true, deno: "partial", bun: true },
  },

  // Core modules - streams
  stream: {
    name: "stream",
    category: "core",
    polyfill: "stream-browserify",
    hasSubpaths: true,
    subpaths: ["promises", "consumers", "web"],
    runtimes: { node: true, deno: true, bun: true },
  },
  string_decoder: {
    name: "string_decoder",
    category: "core",
    polyfill: "string_decoder",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - utilities
  util: {
    name: "util",
    category: "core",
    polyfill: "util",
    hasSubpaths: true,
    subpaths: ["types"],
    runtimes: { node: true, deno: true, bun: true },
  },
  events: {
    name: "events",
    category: "core",
    polyfill: "events",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  assert: {
    name: "assert",
    category: "core",
    polyfill: "assert",
    hasSubpaths: true,
    subpaths: ["strict"],
    runtimes: { node: true, deno: true, bun: true },
  },
  url: {
    name: "url",
    category: "core",
    polyfill: "url",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  querystring: {
    name: "querystring",
    category: "core",
    polyfill: "querystring-es3",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - timers
  timers: {
    name: "timers",
    category: "core",
    polyfill: "timers-browserify",
    hasSubpaths: true,
    subpaths: ["promises"],
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - compression
  zlib: {
    name: "zlib",
    category: "core",
    polyfill: "browserify-zlib",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - console & terminal
  console: {
    name: "console",
    category: "core",
    polyfill: "console-browserify",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  tty: {
    name: "tty",
    category: "core",
    polyfill: "tty-browserify",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  readline: {
    name: "readline",
    category: "core",
    polyfill: null,
    hasSubpaths: true,
    subpaths: ["promises"],
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - child processes & clusters
  child_process: {
    name: "child_process",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: "partial", bun: true },
  },
  cluster: {
    name: "cluster",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: "partial" },
  },
  worker_threads: {
    name: "worker_threads",
    category: "worker",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },

  // Core modules - module system
  module: {
    name: "module",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: "partial", bun: true },
  },

  // Core modules - VM & debugging
  vm: {
    name: "vm",
    category: "core",
    polyfill: "vm-browserify",
    hasSubpaths: false,
    runtimes: { node: true, deno: "partial", bun: "partial" },
  },
  v8: {
    name: "v8",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: false },
  },
  inspector: {
    name: "inspector",
    category: "core",
    polyfill: null,
    hasSubpaths: true,
    subpaths: ["promises"],
    runtimes: { node: true, deno: false, bun: false },
  },
  repl: {
    name: "repl",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: false },
  },

  // Core modules - diagnostics
  perf_hooks: {
    name: "perf_hooks",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  async_hooks: {
    name: "async_hooks",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: "partial", bun: "partial" },
  },
  diagnostics_channel: {
    name: "diagnostics_channel",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: "partial" },
  },
  trace_events: {
    name: "trace_events",
    category: "core",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: false },
  },

  // Core modules - misc
  constants: {
    name: "constants",
    category: "core",
    polyfill: "constants-browserify",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },

  // Node.js test runner
  test: {
    name: "test",
    category: "core",
    polyfill: null,
    hasSubpaths: true,
    subpaths: ["reporters"],
    runtimes: { node: true, deno: false, bun: false },
  },

  // Deprecated modules
  domain: {
    name: "domain",
    category: "deprecated",
    polyfill: "domain-browser",
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: "partial" },
  },
  punycode: {
    name: "punycode",
    category: "deprecated",
    polyfill: "punycode",
    hasSubpaths: false,
    runtimes: { node: true, deno: true, bun: true },
  },
  sys: {
    name: "sys",
    category: "deprecated",
    polyfill: "util",
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: false },
  },

  // Experimental modules
  wasi: {
    name: "wasi",
    category: "experimental",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: false },
  },
  sqlite: {
    name: "sqlite",
    category: "experimental",
    polyfill: null,
    hasSubpaths: false,
    runtimes: { node: true, deno: false, bun: true },
  },
};

/**
 * Set of built-in module names for fast lookup.
 */
export const BUILTIN_NAMES = new Set(Object.keys(NODE_BUILTINS));

/**
 * Deprecated Node.js API paths that should be externalized.
 *
 * These paths refer to APIs that have been removed or deprecated
 * from Node.js and should be marked as external.
 */
export const DEPRECATED_API_PATHS = [
  "v8/tools/codemap",
  "v8/tools/consarray",
  "v8/tools/csvparser",
  "v8/tools/logreader",
  "v8/tools/profile_view",
  "v8/tools/profile",
  "v8/tools/SourceMap",
  "v8/tools/splaytree",
  "v8/tools/tickprocessor-driver",
  "v8/tools/tickprocessor",
  "node-inspect/lib/_inspect",
  "node-inspect/lib/internal/inspect_client",
  "node-inspect/lib/internal/inspect_repl",
  "_linklist",
  "_stream_wrap",
  "_stream_duplex",
  "_stream_readable",
  "_stream_writable",
  "_stream_transform",
  "_stream_passthrough",
] as const;

// =============================================================================
// Detection
// =============================================================================

/**
 * Check if a specifier refers to a built-in module.
 *
 * Handles both prefixed (node:fs) and unprefixed (fs) specifiers,
 * including subpaths (node:fs/promises).
 *
 * @param specifier Module specifier
 * @returns True if it's a built-in module
 *
 * @example
 * ```ts
 * isBuiltin("fs")              // true
 * isBuiltin("node:fs")         // true
 * isBuiltin("node:fs/promises") // true
 * isBuiltin("react")           // false
 * isBuiltin("fsevents")        // false (native addon, not built-in)
 * isBuiltin("pnpapi")          // false (Yarn PnP API)
 * ```
 */
export function isBuiltin(specifier: string): boolean {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const baseName = normalized.split("/")[0];
  return BUILTIN_NAMES.has(baseName);
}

/**
 * Get the base built-in module name from a specifier.
 *
 * @param specifier Module specifier
 * @returns Base module name or null if not a built-in
 *
 * @example
 * ```ts
 * getBuiltinName("node:fs/promises") // "fs"
 * getBuiltinName("path")             // "path"
 * getBuiltinName("react")            // null
 * ```
 */
export function getBuiltinName(specifier: string): string | null {
  const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const baseName = normalized.split("/")[0];
  return BUILTIN_NAMES.has(baseName) ? baseName : null;
}

/**
 * Get information about a built-in module.
 *
 * @param specifier Module specifier
 * @returns Module info or null if not a built-in
 *
 * @example
 * ```ts
 * getBuiltinInfo("path")
 * // {
 * //   name: "path",
 * //   category: "core",
 * //   polyfill: "path-browserify",
 * //   hasSubpaths: true,
 * //   subpaths: ["posix", "win32"],
 * //   runtimes: { node: true, deno: true, bun: true }
 * // }
 *
 * getBuiltinInfo("child_process")
 * // {
 * //   name: "child_process",
 * //   category: "core",
 * //   polyfill: null,
 * //   hasSubpaths: false,
 * //   runtimes: { node: true, deno: "partial", bun: true }
 * // }
 * ```
 */
export function getBuiltinInfo(specifier: string): BuiltinInfo | null {
  const name = getBuiltinName(specifier);
  return name ? NODE_BUILTINS[name] : null;
}

// =============================================================================
// Normalization
// =============================================================================

/**
 * Normalize a built-in module specifier to use node: prefix.
 *
 * The node: prefix is recommended for clarity and to avoid
 * conflicts with npm packages.
 *
 * @param specifier Module specifier
 * @returns Normalized specifier with node: prefix
 *
 * @example
 * ```ts
 * normalizeBuiltin("fs")               // "node:fs"
 * normalizeBuiltin("node:fs")          // "node:fs"
 * normalizeBuiltin("fs/promises")      // "node:fs/promises"
 * normalizeBuiltin("node:fs/promises") // "node:fs/promises"
 * normalizeBuiltin("react")            // "react" (not a builtin)
 * ```
 */
export function normalizeBuiltin(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  if (isBuiltin(specifier)) return `node:${specifier}`;
  return specifier;
}

/**
 * Strip the node: prefix from a built-in specifier.
 *
 * @param specifier Module specifier
 * @returns Specifier without node: prefix
 *
 * @example
 * ```ts
 * stripNodePrefix("node:fs")          // "fs"
 * stripNodePrefix("fs")               // "fs"
 * stripNodePrefix("node:fs/promises") // "fs/promises"
 * ```
 */
export function stripNodePrefix(specifier: string): string {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

/**
 * Get the subpath from a built-in specifier.
 *
 * @param specifier Module specifier
 * @returns Subpath or null if none
 *
 * @example
 * ```ts
 * getBuiltinSubpath("node:fs/promises") // "promises"
 * getBuiltinSubpath("fs/promises")      // "promises"
 * getBuiltinSubpath("fs")               // null
 * getBuiltinSubpath("path/posix")       // "posix"
 * ```
 */
export function getBuiltinSubpath(specifier: string): string | null {
  const normalized = stripNodePrefix(specifier);
  const slashIdx = normalized.indexOf("/");
  return slashIdx > 0 ? normalized.slice(slashIdx + 1) : null;
}

// =============================================================================
// Polyfills
// =============================================================================

/**
 * Get the browser polyfill package for a built-in module.
 *
 * Returns null for modules that cannot be polyfilled in browsers
 * (e.g., child_process, fs, cluster).
 *
 * @param specifier Module specifier
 * @returns Polyfill package name or null
 *
 * @example
 * ```ts
 * getPolyfill("path")          // "path-browserify"
 * getPolyfill("events")        // "events"
 * getPolyfill("fs")            // null
 * getPolyfill("child_process") // null
 * getPolyfill("react")         // null (not a builtin)
 * ```
 */
export function getPolyfill(specifier: string): string | null {
  const info = getBuiltinInfo(specifier);
  return info?.polyfill ?? null;
}

/**
 * Check if a built-in module has a browser polyfill.
 *
 * @param specifier Module specifier
 * @returns True if polyfill is available
 *
 * @example
 * ```ts
 * hasPolyfill("path")          // true
 * hasPolyfill("fs")            // false
 * hasPolyfill("child_process") // false
 * ```
 */
export function hasPolyfill(specifier: string): boolean {
  return getPolyfill(specifier) !== null;
}

/**
 * Get all built-in modules that have polyfills.
 *
 * @returns Array of [builtin, polyfill] pairs
 *
 * @example
 * ```ts
 * getAllPolyfills()
 * // [
 * //   ["path", "path-browserify"],
 * //   ["events", "events"],
 * //   ["buffer", "buffer"],
 * //   ["process", "process"],
 * //   ...
 * // ]
 * ```
 */
export function getAllPolyfills(): [string, string][] {
  return Object.entries(NODE_BUILTINS)
    .filter(([_, info]) => info.polyfill !== null)
    .map(([name, info]) => [name, info.polyfill!]);
}

// =============================================================================
// External Configuration
// =============================================================================

/**
 * Options for generating external patterns.
 */
export interface ExternalPatternsOptions {
  /** Target runtime (affects which modules are external) */
  runtime?: RuntimeTarget;
  /** Include deprecated modules */
  includeDeprecated?: boolean;
  /** Include experimental modules */
  includeExperimental?: boolean;
  /** Include modules with polyfills (false = only non-polyfillable) */
  includePolyfillable?: boolean;
  /** Include subpath patterns (fs/*) */
  includeSubpaths?: boolean;
  /** Include deprecated API paths */
  includeDeprecatedPaths?: boolean;
}

/**
 * Create external patterns for bundler configuration.
 *
 * Generates patterns suitable for esbuild's `external` option.
 *
 * @param options External options
 * @returns Array of external patterns
 *
 * @example All built-ins (for Node.js target)
 * ```ts
 * createExternalPatterns({ runtime: "node" })
 * // [
 * //   "fs", "node:fs", "fs/*", "node:fs/*",
 * //   "path", "node:path", "path/*", "node:path/*",
 * //   ...
 * // ]
 * ```
 *
 * @example Only non-polyfillable (for browser with polyfills)
 * ```ts
 * createExternalPatterns({
 *   runtime: "browser",
 *   includePolyfillable: false
 * })
 * // [
 * //   "fs", "node:fs",
 * //   "child_process", "node:child_process",
 * //   "cluster", "node:cluster",
 * //   ...
 * // ]
 * ```
 *
 * @example Usage with esbuild
 * ```ts
 * esbuild.build({
 *   external: createExternalPatterns({ runtime: "node" }),
 *   // ...
 * });
 * ```
 */
export function createExternalPatterns(options: ExternalPatternsOptions = {}): string[] {
  const {
    runtime = "node",
    includeDeprecated = true,
    includeExperimental = false,
    includePolyfillable = true,
    includeSubpaths = true,
    includeDeprecatedPaths = true,
  } = options;

  const externals: string[] = [];

  for (const [name, info] of Object.entries(NODE_BUILTINS)) {
    // Filter by category
    if (!includeDeprecated && info.category === "deprecated") continue;
    if (!includeExperimental && info.category === "experimental") continue;

    // Filter by polyfill availability
    if (!includePolyfillable && info.polyfill !== null) continue;

    // Check runtime support (for browser, only include non-polyfillable)
    if (runtime === "browser" && info.polyfill !== null && includePolyfillable) {
      continue;
    }

    // Add both prefixed and unprefixed
    externals.push(name);
    externals.push(`node:${name}`);

    // Add subpath patterns
    if (includeSubpaths && info.hasSubpaths) {
      externals.push(`${name}/*`);
      externals.push(`node:${name}/*`);
    }
  }

  // Add deprecated API paths
  if (includeDeprecatedPaths) {
    externals.push(...DEPRECATED_API_PATHS);
  }

  // Add common non-module externals
  externals.push("pnpapi"); // Yarn PnP

  return externals;
}

/**
 * Get all Node.js built-in module names.
 *
 * @param options Filter options
 * @returns Array of built-in names
 *
 * @example
 * ```ts
 * getBuiltinList()
 * // ["assert", "buffer", "child_process", "cluster", ...]
 *
 * getBuiltinList({ includeNodePrefix: true })
 * // ["assert", "node:assert", "buffer", "node:buffer", ...]
 *
 * getBuiltinList({ includeDeprecated: false })
 * // ["assert", "buffer", ...] // without domain, punycode, sys
 * ```
 */
export function getBuiltinList(
  options: {
    includeNodePrefix?: boolean;
    includeDeprecated?: boolean;
    includeExperimental?: boolean;
  } = {}
): string[] {
  const {
    includeNodePrefix = false,
    includeDeprecated = true,
    includeExperimental = false,
  } = options;

  let names = Object.entries(NODE_BUILTINS)
    .filter(([_, info]) => {
      if (!includeDeprecated && info.category === "deprecated") return false;
      if (!includeExperimental && info.category === "experimental") return false;
      return true;
    })
    .map(([name]) => name);

  if (includeNodePrefix) {
    names = [...names, ...names.map((n) => `node:${n}`)];
  }

  return names;
}

// =============================================================================
// Runtime Support
// =============================================================================

/**
 * Check if a built-in is supported in a specific runtime.
 *
 * @param specifier Module specifier
 * @param runtime Target runtime
 * @returns Support status: true, false, or "partial"
 *
 * @example
 * ```ts
 * isBuiltinSupported("fs", "node")     // true
 * isBuiltinSupported("fs", "deno")     // true
 * isBuiltinSupported("fs", "browser")  // false
 *
 * isBuiltinSupported("cluster", "deno") // false
 * isBuiltinSupported("cluster", "bun")  // "partial"
 *
 * isBuiltinSupported("path", "browser") // true (has polyfill)
 * ```
 */
export function isBuiltinSupported(
  specifier: string,
  runtime: RuntimeTarget
): boolean | "partial" {
  const info = getBuiltinInfo(specifier);
  if (!info) return false;

  switch (runtime) {
    case "node":
      return info.runtimes.node;
    case "deno":
      return info.runtimes.deno;
    case "bun":
      return info.runtimes.bun;
    case "browser":
      // Browser supports if there's a polyfill
      return info.polyfill !== null;
    case "workerd":
      // Cloudflare Workers have limited Node.js compat
      // Most core modules work via nodejs_compat flag
      return info.runtimes.node === true && info.polyfill !== null;
    default:
      return false;
  }
}

/**
 * Get built-in modules supported by a runtime.
 *
 * @param runtime Target runtime
 * @param options Filter options
 * @returns Array of supported module names
 *
 * @example
 * ```ts
 * getBuiltinsForRuntime("browser")
 * // ["path", "events", "buffer", "process", ...] // Polyfillable modules
 *
 * getBuiltinsForRuntime("deno")
 * // ["fs", "path", "http", ...] // Most Node.js modules
 *
 * getBuiltinsForRuntime("bun")
 * // ["fs", "path", "http", "child_process", ...] // Nearly all
 * ```
 */
export function getBuiltinsForRuntime(
  runtime: RuntimeTarget,
  options: { includePartial?: boolean } = {}
): string[] {
  const { includePartial = false } = options;

  return Object.entries(NODE_BUILTINS)
    .filter(([_, info]) => {
      const support = (() => {
        switch (runtime) {
          case "node":
            return info.runtimes.node;
          case "deno":
            return info.runtimes.deno;
          case "bun":
            return info.runtimes.bun;
          case "browser":
            return info.polyfill !== null;
          case "workerd":
            return info.polyfill !== null;
          default:
            return false;
        }
      })();

      if (support === true) return true;
      if (support === "partial" && includePartial) return true;
      return false;
    })
    .map(([name]) => name);
}

// =============================================================================
// Extended Polyfills (for full browser compatibility)
// =============================================================================

/**
 * Extended polyfill mappings that go beyond the standard polyfills.
 *
 * These include:
 * - Alternative packages for modules that have multiple polyfill options
 * - "Aggressive" polyfills for modules normally marked as non-polyfillable
 * - Subpath-specific mappings
 *
 * **Use with caution**: Some of these polyfills provide limited functionality
 * and may not work for all use cases.
 *
 * @example
 * ```ts
 * EXTENDED_POLYFILLS["fs"]
 * // "memfs" - in-memory filesystem (limited but works in browsers)
 *
 * EXTENDED_POLYFILLS["http"]
 * // "http-browserify" - alternative to stream-http
 * ```
 */
export const EXTENDED_POLYFILLS: Record<string, string> = {
  // Alternative HTTP polyfills
  http: "http-browserify",  // Alternative to stream-http

  // Extended polyfills for normally non-polyfillable modules
  fs: "memfs",              // In-memory filesystem
  net: "net-browserify",    // Limited net polyfill
  dgram: "browser-node-dgram",
  readline: "readline-browser",
  tls: "browserify-tls",

  // Different path styles for common polyfills
  url: "browserify-url",
  util: "util/util.js",     // More specific path
  os: "os-browserify/browser",
  process: "process/browser",

  // Simpler querystring (vs querystring-es3)
  querystring: "querystring",

  // Additional utilities
  Dirent: "dirent",         // File system directory entry type
};

/**
 * Subpath mappings for packages with complex exports.
 *
 * Maps specific subpaths to their polyfill equivalents.
 */
export const SUBPATH_POLYFILLS: Record<string, string> = {
  "readable-stream/": "readable-stream/lib",
  "readable-stream/duplex": "readable-stream/lib/duplex.js",
  "readable-stream/readable": "readable-stream/lib/readable.js",
  "readable-stream/writable": "readable-stream/lib/writable.js",
  "readable-stream/transform": "readable-stream/lib/transform.js",
  "readable-stream/passthrough": "readable-stream/lib/passthrough.js",
};

/**
 * Polyfill profile options.
 */
export type PolyfillProfile = "conservative" | "aggressive" | "maximal";

/**
 * Create a polyfill map with different profiles.
 *
 * Profiles:
 * - `conservative`: Only well-tested, reliable polyfills (default)
 * - `aggressive`: Include extended polyfills for more modules
 * - `maximal`: All possible polyfills, even experimental ones
 *
 * @param profile Polyfill profile
 * @returns Polyfill map
 *
 * @example Conservative (default)
 * ```ts
 * createPolyfillMapWithProfile("conservative")
 * // { path: "path-browserify", events: "events", ... }
 * // Does NOT include fs, net, etc.
 * ```
 *
 * @example Aggressive
 * ```ts
 * createPolyfillMapWithProfile("aggressive")
 * // { path: "path-browserify", fs: "memfs", net: "net-browserify", ... }
 * // Includes extended polyfills
 * ```
 *
 * @example Maximal (with subpaths)
 * ```ts
 * createPolyfillMapWithProfile("maximal")
 * // Includes all above plus subpath mappings
 * ```
 */
export function createPolyfillMapWithProfile(
  profile: PolyfillProfile = "conservative"
): Record<string, string> {
  const map: Record<string, string> = {};

  // Add standard polyfills (with node: prefix variants)
  for (const [name, info] of Object.entries(NODE_BUILTINS)) {
    if (info.polyfill) {
      map[name] = info.polyfill;
      map[`node:${name}`] = info.polyfill;
    }
  }

  // Add extended polyfills for aggressive/maximal
  if (profile === "aggressive" || profile === "maximal") {
    for (const [name, polyfill] of Object.entries(EXTENDED_POLYFILLS)) {
      // Only add if not already in standard polyfills
      if (!(name in map)) {
        map[name] = polyfill;
        // Only add node: prefix for actual Node builtins
        if (BUILTIN_NAMES.has(name)) {
          map[`node:${name}`] = polyfill;
        }
      }
    }
  }

  // Add subpath mappings for maximal
  if (profile === "maximal") {
    Object.assign(map, SUBPATH_POLYFILLS);
  }

  return map;
}

// =============================================================================
// Legacy Compatibility (for external.ts)
// =============================================================================

/**
 * Create the legacy PolyfillMap format used by external.ts.
 *
 * This generates a map compatible with the existing external plugin,
 * using the "aggressive" polyfill profile which includes extended polyfills.
 *
 * @returns Legacy-compatible polyfill map
 *
 * @example
 * ```ts
 * const PolyfillMap = createLegacyPolyfillMap();
 * // {
 * //   "console": "console-browserify",
 * //   "constants": "constants-browserify",
 * //   "crypto": "crypto-browserify",
 * //   "fs": "memfs",
 * //   ...
 * // }
 * ```
 *
 * @deprecated Prefer using `createPolyfillMapWithProfile("aggressive")` directly
 */
export function createLegacyPolyfillMap(): Record<string, string> {
  const map = createPolyfillMapWithProfile("maximal");

  // Remove node: prefixed entries for legacy compatibility
  const legacyMap: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!key.startsWith("node:")) {
      legacyMap[key] = value;
    }
  }

  return legacyMap;
}

/**
 * Packages that should always be marked as external.
 *
 * This includes:
 * - Non-polyfillable Node.js modules
 * - Native addons (fsevents)
 * - Package manager APIs (pnpapi)
 * - Build-time utilities (chokidar, yargs)
 */
export const ALWAYS_EXTERNAL = [
  "pnpapi",       // Yarn PnP API
  "v8",           // V8 engine internals
  "node-inspect", // Node.js inspector
  "sys",          // Deprecated alias for util
  "repl",         // REPL (no browser equivalent)
  "dns",          // DNS resolution
  "child_process",// Process spawning
  "module",       // Module system internals
  "cluster",      // Process clustering
  "chokidar",     // File watcher (native)
  "yargs",        // CLI framework (usually build-time)
  "fsevents",     // macOS native file events
  "worker_threads",
  "async_hooks",
  "diagnostics_channel",
  "http2",
  "inspector",
  "perf_hooks",
  "trace_events",
  "wasi",
] as const;

/**
 * Get all packages that should be marked as external.
 *
 * Combines deprecated APIs, always-external packages, and polyfillable modules.
 *
 * @returns Array of external package patterns
 */
export function getExternalPackages(): string[] {
  const legacyMap = createPolyfillMapWithProfile("aggressive");
  return [
    ...ALWAYS_EXTERNAL,
    ...DEPRECATED_API_PATHS,
    ...Object.keys(legacyMap),
  ];
}
