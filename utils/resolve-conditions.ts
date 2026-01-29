/**
 * Package exports/imports condition resolver.
 *
 * Computes the appropriate export conditions for resolving Node.js conditional exports
 * based on the target platform, runtime, and build configuration.
 *
 * Supports multiple runtimes:
 * - Node.js (default when platform="node")
 * - Browsers (default when platform="browser")
 * - Deno
 * - Bun
 * - Electron (main and renderer)
 * - React Native
 * - Edge runtimes (Cloudflare Workers, Vercel Edge, etc.)
 *
 * @module
 *
 * @example Basic usage
 * ```ts
 * import { getResolverConditions, detectRuntime } from "./resolve-conditions.ts";
 *
 * // Browser build
 * const browserConditions = getResolverConditions(
 *   { kind: "import-statement" },
 *   { platform: "browser" }
 * );
 * // conditions: ["import", "browser", "module", "default"]
 *
 * // Deno build
 * const denoConditions = getResolverConditions(
 *   { kind: "import-statement" },
 *   { platform: "neutral", runtime: "deno" }
 * );
 * // conditions: ["import", "deno", "node", "module", "default"]
 * ```
 *
 * @see https://nodejs.org/api/packages.html#conditional-exports
 */

// =============================================================================
// Types
// =============================================================================

/**
 * esbuild platform option.
 */
export type Platform = "browser" | "node" | "neutral";

/**
 * esbuild output format.
 */
export type Format = "iife" | "cjs" | "esm";

/**
 * esbuild import kinds.
 */
export type ImportKind =
  | "entry-point"
  | "import-statement"
  | "require-call"
  | "dynamic-import"
  | "require-resolve"
  | "import-rule"
  | "composes-from"
  | "url-token";

/**
 * Target runtime for resolution.
 *
 * These are distinct from esbuild's `platform` because many runtimes
 * don't map cleanly to browser/node/neutral.
 */
export type ResolveRuntime =
  | "react-native"
  | "electron-main"
  | "electron-renderer"
  | "electron-preload"
  | "deno"
  | "bun"
  | "workerd"
  | "edge-light"
  | "netlify"
  | "vercel";

/**
 * Input options for computing resolver conditions.
 */
export interface ResolverConditionInputs {
  platform?: Platform;
  conditions?: string[];
  format?: Format;
  mainFields?: string[];
  runtime?: ResolveRuntime;
  runtimeConditions?: readonly string[];
}

/**
 * Computed conditions result.
 */
export interface ResolverConditions {
  /** Whether to respect package.json browser field */
  browser: boolean;
  /** Whether we're in CommonJS require context */
  require: boolean;
  /** Ordered list of conditions for exports resolution */
  conditions: string[];
}

/**
 * Runtime policy defaults.
 */
export interface RuntimeDefaults {
  conditions: string[];
  browserField: boolean | null;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Well-known export conditions organized by category.
 */
export const KNOWN_CONDITIONS = {
  // Module system
  import: "import",
  require: "require",
  module: "module",
  default: "default",

  // Platform
  browser: "browser",
  node: "node",
  deno: "deno",
  bun: "bun",

  // Environment
  development: "development",
  production: "production",

  // Runtimes
  "react-native": "react-native",
  electron: "electron",
  workerd: "workerd",
  worker: "worker",
  "edge-light": "edge-light",

  // Bundlers
  bundler: "bundler",
  types: "types",
} as const;

/**
 * Default legacy main fields by platform.
 */
export const DEFAULT_MAIN_FIELDS = {
  browser: ["browser", "module", "main"],
  node: ["module", "main"],
  neutral: ["module", "main"],
} as const;

// =============================================================================
// Runtime Detection
// =============================================================================

/**
 * Detect the current runtime environment.
 *
 * Useful for auto-configuring build settings.
 *
 * @returns Detected runtime or null if unknown
 *
 * @example
 * ```ts
 * const runtime = detectRuntime();
 * if (runtime === "deno") {
 *   // Configure for Deno
 * }
 * ```
 */
export function detectRuntime(): ResolveRuntime | null {
  // Check for Deno global
  if (typeof globalThis !== "undefined" && "Deno" in globalThis) {
    return "deno";
  }

  // Check for Bun global
  if (typeof globalThis !== "undefined" && "Bun" in globalThis) {
    return "bun";
  }

  // Check for Cloudflare Workers (workerd)
  if (
    typeof globalThis !== "undefined" &&
    "caches" in globalThis &&
    typeof (globalThis as any).caches?.default !== "undefined"
  ) {
    return "workerd";
  }

  // Check for Node.js with Electron
  if (typeof globalThis?.process !== "undefined" && globalThis?.process?.versions) {
    if (globalThis?.process?.versions?.electron) {
      // Check if we're in main or renderer
      if (typeof window !== "undefined") {
        return "electron-renderer";
      }
      return "electron-main";
    }
  }

  // Note: React Native detection requires different approach (not reliable from globals)

  return null;
}

/**
 * Get the recommended platform for a runtime.
 *
 * @param runtime Target runtime
 * @returns Recommended esbuild platform
 */
export function getPlatformForRuntime(runtime: ResolveRuntime): Platform {
  switch (runtime) {
    case "react-native":
    case "deno":
    case "bun":
    case "electron-main":
    case "electron-preload":
      return "node"; // Node-compatible APIs

    case "electron-renderer":
    case "workerd":
    case "edge-light":
    case "netlify":
    case "vercel":
      return "browser"; // Web-like APIs

    default:
      return "neutral";
  }
}

// =============================================================================
// Runtime Defaults
// =============================================================================

/**
 * Get runtime-specific default conditions and browser field behavior.
 *
 * @param runtime Target runtime
 * @returns Default conditions and browser field setting
 */
export function getRuntimeDefaults(
  runtime: ResolveRuntime | undefined
): RuntimeDefaults {
  if (!runtime) {
    return { conditions: [], browserField: null };
  }

  switch (runtime) {
    case "react-native":
      // Metro bundler uses "react-native" condition
      // Not browser, so disable browser field mapping
      return { conditions: ["react-native"], browserField: false };

    case "electron-main":
      // Main process is Node-like
      return { conditions: ["electron", "node"], browserField: false };

    case "electron-renderer":
      // Renderer is web-like (Chromium)
      return { conditions: ["electron", "browser"], browserField: true };

    case "electron-preload":
      // Preload scripts are special (Node + limited DOM)
      return { conditions: ["electron", "node"], browserField: false };

    case "deno":
      // Deno has Node compatibility layer
      return { conditions: ["deno", "node"], browserField: false };

    case "bun":
      // Bun is Node-compatible with its own condition
      return { conditions: ["bun", "node"], browserField: false };

    case "workerd":
      // Cloudflare Workers / workerd
      return { conditions: ["workerd", "worker", "browser"], browserField: false };

    case "edge-light":
      // Vercel Edge, other edge runtimes
      return { conditions: ["edge-light", "worker", "browser"], browserField: true };

    case "netlify":
      // Netlify Edge Functions
      return { conditions: ["netlify", "edge-light", "worker"], browserField: false };

    case "vercel":
      // Vercel Edge Functions
      return { conditions: ["vercel", "edge-light", "worker"], browserField: false };

    default:
      return { conditions: [], browserField: null };
  }
}

// =============================================================================
// Condition Computation
// =============================================================================

/**
 * Check if an import kind represents require() usage.
 */
export function isRequireKind(kind: ImportKind): boolean {
  return kind === "require-call" || kind === "require-resolve";
}

/**
 * Check if the resolution context is CommonJS.
 */
export function isRequireContext(
  args: { kind: ImportKind },
  esbuildOpts: { format?: Format }
): boolean {
  if (isRequireKind(args.kind)) return true;
  if (args.kind === "entry-point") return esbuildOpts.format === "cjs";
  return false;
}

/**
 * Compute the set of conditions for package exports resolution.
 *
 * Combines:
 * 1. Import/require context
 * 2. Platform conditions (browser, node)
 * 3. esbuild's implicit "module" condition
 * 4. Runtime overlay
 * 5. User-specified conditions
 * 6. Always includes "default"
 *
 * @param args Resolution args (needs kind)
 * @param esbuildOpts Build options
 * @returns Computed conditions
 *
 * @example Default browser build
 * ```ts
 * const c = getResolverConditions(
 *   { kind: "import-statement" },
 *   { platform: "browser", format: "esm" }
 * );
 * // c.conditions: ["import", "browser", "module", "default"]
 * // c.browser: true
 * ```
 *
 * @example React Native build
 * ```ts
 * const c = getResolverConditions(
 *   { kind: "import-statement" },
 *   { platform: "neutral", runtime: "react-native" }
 * );
 * // c.conditions: ["import", "module", "react-native", "default"]
 * // c.browser: false
 * ```
 */
export function getResolverConditions(
  args: { kind: ImportKind },
  esbuildOpts: ResolverConditionInputs
): ResolverConditions {
  const platform = esbuildOpts.platform ?? "browser";

  // Determine require vs import context
  const require = isRequireContext(args, esbuildOpts);

  // Browser field is enabled by default for browser platform
  let browserField = platform === "browser";

  // Check if user provided explicit conditions
  const userProvidedConditions = esbuildOpts.conditions !== undefined;

  // Only auto-add "module" for browser/node when no explicit conditions
  const mayAutoAddModule =
    !userProvidedConditions && (platform === "browser" || platform === "node");

  const computed: string[] = [];

  // 1. Import/require dimension
  computed.push(require ? "require" : "import");

  // 2. Platform dimension
  if (platform === "browser") computed.push("browser");
  if (platform === "node") computed.push("node");

  // 3. Auto-add "module" for bundlers (esbuild convention)
  if (mayAutoAddModule) computed.push("module");

  // 4. Runtime overlay (additive, doesn't affect mayAutoAddModule)
  const runtimeDefaults = getRuntimeDefaults(esbuildOpts.runtime);
  if (runtimeDefaults.browserField !== null) {
    browserField = runtimeDefaults.browserField;
  }
  for (const c of runtimeDefaults.conditions) {
    if (!computed.includes(c)) computed.push(c);
  }

  // 5. Extra runtime conditions
  if (esbuildOpts.runtimeConditions?.length) {
    for (const c of esbuildOpts.runtimeConditions) {
      if (!computed.includes(c)) computed.push(c);
    }
  }

  // 6. User-specified conditions
  if (esbuildOpts.conditions?.length) {
    for (const c of esbuildOpts.conditions) {
      if (!computed.includes(c)) computed.push(c);
    }
  }

  // 7. "default" is always active
  if (!computed.includes("default")) computed.push("default");

  return {
    browser: browserField,
    require,
    conditions: computed,
  };
}

// =============================================================================
// Legacy Main Fields
// =============================================================================

/**
 * Get the legacy main field resolution order.
 *
 * Used when package.json doesn't have "exports" field.
 *
 * @param manifest Package.json contents
 * @param args Resolution args
 * @param esbuildOpts Build options
 * @returns Ordered list of fields to check
 */
export function getLegacyMainFields(
  manifest: { type?: string },
  args: { kind: ImportKind },
  esbuildOpts: ResolverConditionInputs
): string[] {
  // User-specified mainFields take precedence
  if (esbuildOpts.mainFields?.length) {
    return esbuildOpts.mainFields;
  }

  const platform = esbuildOpts.platform ?? "browser";
  const require = isRequireContext(args, esbuildOpts);
  const isModulePackage = manifest.type === "module";

  // Base fields by platform
  const baseFields = DEFAULT_MAIN_FIELDS[platform] ?? DEFAULT_MAIN_FIELDS.neutral;
  const fields = [...baseFields];

  // For require context in non-module packages, prefer main
  if (require && !isModulePackage) {
    // Move "main" to front
    const mainIdx = fields.indexOf("main");
    if (mainIdx > 0) {
      fields.splice(mainIdx, 1);
      fields.unshift("main");
    }
  }

  return fields;
}

// =============================================================================
// Condition Utilities
// =============================================================================

/**
 * Check if a condition is satisfied.
 *
 * @param condition Condition to check
 * @param activeConditions List of active conditions
 * @returns True if condition is active
 */
export function conditionMatches(
  condition: string,
  activeConditions: string[]
): boolean {
  return activeConditions.includes(condition);
}

/**
 * Merge condition sets, preserving order and removing duplicates.
 *
 * @param base Base conditions
 * @param additions Conditions to add
 * @returns Merged conditions
 */
export function mergeConditions(
  base: string[],
  additions: string[]
): string[] {
  const result = [...base];
  for (const c of additions) {
    if (!result.includes(c)) {
      result.push(c);
    }
  }
  return result;
}

/**
 * Get a description of what a condition is for.
 *
 * @param condition Condition name
 * @returns Human-readable description
 */
export function describeCondition(condition: string): string {
  const descriptions: Record<string, string> = {
    import: "ESM import statements",
    require: "CommonJS require() calls",
    module: "Bundler-aware ESM entry",
    default: "Fallback entry",
    browser: "Browser environments",
    node: "Node.js environments",
    deno: "Deno runtime",
    bun: "Bun runtime",
    "react-native": "React Native apps",
    electron: "Electron apps",
    workerd: "Cloudflare Workers",
    worker: "Web Workers",
    "edge-light": "Edge runtimes",
    development: "Development builds",
    production: "Production builds",
    types: "TypeScript type definitions",
  };

  return descriptions[condition] ?? `Custom condition: ${condition}`;
}