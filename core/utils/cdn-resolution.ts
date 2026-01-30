/**
 * CDN Resolution Utilities
 *
 * Shared resolution logic for resolving package entry points across:
 * - CdnPlugin (npm CDN resolution)
 * - TarballPlugin (tarball package entry point resolution)
 * - JSR resolution
 *
 * ## Critical Browser Field Fix
 *
 * The browser field has TWO distinct forms:
 *
 * **String form** (direct entry point):
 * ```json
 * { "browser": "./dist/browser.js" }
 * ```
 * → Use this as the entry point directly
 *
 * **Object form** (remapping layer):
 * ```json
 * { "browser": { "./lib/node.js": "./lib/browser.js", "fs": false } }
 * ```
 * → NOT entry points! Get entry from main/module, then apply remappings.
 *
 * The previous implementation incorrectly treated object keys as entry points.
 *
 * @module
 */
import type { PackageJson, FullPackageVersion } from "@bundle/utils/types";
import type { SideEffectsMatchers } from "./side-effects.ts";
import type { ResolverConditions as BaseResolverConditions } from "@bundle/utils/resolve-conditions";

import { resolve, legacy } from "@bundle/utils/resolve-exports-imports";
import { computeEsbuildSideEffects } from "./side-effects.ts";
import { dispatchEvent, LOGGER_WARN } from "../configs/events.ts";

// =============================================================================
// Types
// =============================================================================

/** Resolution conditions from resolve-conditions.ts */
export interface ResolverConditions extends BaseResolverConditions {}

/** Browser field remapping table */
export interface BrowserRemappings {
  [source: string]: string | false;
}

/** Result from modern exports/imports resolution */
export interface ModernResolutionResult {
  path: string | null;
  success: boolean;
  error?: Error;
}

/** Result from legacy field resolution */
export interface LegacyResolutionResult {
  /** Resolved entry point (from main/module, NOT browser object keys) */
  entryPoint: string | null;
  /** Browser remappings to apply (if browser field was object) */
  browserRemappings: BrowserRemappings | null;
  /** Whether module is excluded (browser: false) */
  excluded: boolean;
  error?: Error;
}

/** Combined resolution result */
export interface PackageResolutionResult {
  /** Resolved path (normalized) */
  path: string | null;
  /** Whether modern exports was used */
  usedModern: boolean;
  /** Whether browser remapping was applied */
  appliedBrowserRemapping: boolean;
  /** Browser remappings (for child resolution) */
  browserRemappings: BrowserRemappings | null;
  /** Whether module is excluded */
  excluded: boolean;
  error?: Error;
}

/** Config for peer dependency computation */
export interface PeerDepsConfig {
  initialManifest: Partial<PackageJson | FullPackageVersion>;
  resolvedManifest: Partial<PackageJson | FullPackageVersion>;
  initialDeps: Record<string, string>;
  packageName: string;
  packageVersion: string;
  isNpmCdn: boolean;
}

/** Config for side effects computation */
export interface SideEffectsConfig {
  manifest: Partial<PackageJson | FullPackageVersion> | null;
  resolvedSubpath: string;
  matcherCache?: Map<string, SideEffectsMatchers>;
  packageId: string;
}

// =============================================================================
// Modern Resolution (exports/imports field)
// =============================================================================

/**
 * Resolve using modern exports/imports field.
 *
 * @param manifest Package manifest
 * @param subpath Subpath to resolve (e.g., ".", "./utils")
 * @param conditions Resolution conditions
 *
 * @example
 * ```ts
 * const result = resolveModern(manifest, ".", conditions);
 * if (result.success) {
 *   // result.path = "./dist/esm/index.mjs"
 * }
 * ```
 */
export function resolveModern(
  manifest: Partial<PackageJson | FullPackageVersion>,
  subpath: string,
  conditions: ResolverConditions
): ModernResolutionResult {
  // Normalize subpath for exports resolution
  const exportSubpath =
    subpath.startsWith("./") ? subpath :
    subpath === "" || subpath === "." ? "." :
    `./${subpath.replace(/^\//, "")}`;

  try {
    // Primary resolution with specified conditions
    let resolved = resolve(manifest, exportSubpath, {
      browser: conditions.browser,
      conditions: conditions.conditions,
      require: conditions.require,
      unsafe: true, // Allow resolution even without explicit exports conditions
    });

    // Compatibility fallback: try require if ESM failed
    if (!resolved && !conditions.require) {
      resolved = resolve(manifest, exportSubpath, {
        browser: conditions.browser,
        conditions: ["require", ...conditions.conditions],
        require: true,
      });
    }

    if (resolved) {
      const path = Array.isArray(resolved) ? resolved[0] : resolved;
      if (typeof path === "string") {
        return { path, success: true };
      }
    }

    return { path: null, success: false };
  } catch (e) {
    return { path: null, success: false, error: e as Error };
  }
}

// =============================================================================
// Legacy Resolution (main/module/browser fields)
// =============================================================================

/**
 * Resolve using legacy fields with CORRECT browser field handling.
 *
 * **Critical**: When browser field is an object, it's a remapping layer,
 * NOT a list of entry points. Get entry from main/module, then apply remappings.
 *
 * @param manifest Package manifest
 * @param conditions Resolution conditions
 * @param legacyFields Fields to check in priority order
 *
 * @example String browser field
 * ```ts
 * // { "browser": "./dist/browser.js", "main": "./index.js" }
 * const result = resolveLegacy(manifest, { browser: true }, fields);
 * // result.entryPoint = "./dist/browser.js" (from browser string)
 * // result.browserRemappings = null
 * ```
 *
 * @example Object browser field (THE FIX)
 * ```ts
 * // { "browser": { "./lib/node.js": "./lib/browser.js" }, "main": "./lib/index.js" }
 * const result = resolveLegacy(manifest, { browser: true }, fields);
 * // result.entryPoint = "./lib/index.js" (from main, NOT browser keys!)
 * // result.browserRemappings = { "./lib/node.js": "./lib/browser.js" }
 * ```
 */
export function resolveLegacy(
  manifest: Partial<PackageJson | FullPackageVersion>,
  conditions: { browser: boolean },
  legacyFields: string[]
): LegacyResolutionResult {
  const result: LegacyResolutionResult = {
    entryPoint: null,
    browserRemappings: null,
    excluded: false,
  };

  try {
    // Step 1: Check browser field if browser conditions requested
    if (conditions.browser) {
      const withBrowser = legacy(manifest, {
        browser: true,
        fields: legacyFields,
      });

      // Case: browser field is `false` - module excluded
      if (!withBrowser) {
        result.excluded = true;
        return result;
      }

      // Case: browser field is a string - direct entry point
      if (typeof withBrowser === "string") {
        result.entryPoint = withBrowser;
        return result;
      }

      // Case: browser field is an array
      if (Array.isArray(withBrowser)) {
        result.entryPoint = withBrowser[0] ?? null;
        return result;
      }

      // Case: browser field is an OBJECT (remapping layer)
      // THIS IS THE CRITICAL FIX
      // The object is NOT entry points - it's a remapping table
      if (typeof withBrowser === "object" && withBrowser !== null) {
        const values = Object.values(withBrowser);
        const allFalse = values.length > 0 && values.every(v => v === false);

        if (allFalse) {
          // Package has no browser support
          result.excluded = true;
          return result;
        }

        // Store remappings for later application
        result.browserRemappings = withBrowser as BrowserRemappings;
        // Fall through to get actual entry point from non-browser fields
      }
    }

    // Step 2: Get entry point from non-browser fields
    const fieldsWithoutBrowser = legacyFields.filter(f => f !== "browser");
    const fields = fieldsWithoutBrowser.length > 0 ? fieldsWithoutBrowser : ["module", "main"];

    const entryPoint = legacy(manifest, {
      browser: false, // Explicitly disable browser field
      fields,
    });

    if (!entryPoint) {
      result.excluded = true;
      return result;
    }

    if (typeof entryPoint === "string") {
      result.entryPoint = entryPoint;
    } else if (Array.isArray(entryPoint)) {
      result.entryPoint = entryPoint[0] ?? null;
    } else if (typeof entryPoint === "object" && entryPoint !== null) {
      // Shouldn't happen with browser: false, but handle defensively
      const validEntry = Object.entries(entryPoint).find(([, v]) => v && typeof v === "string");
      result.entryPoint = validEntry ? (validEntry[1] as string) : null;
    }

    // Step 3: Fallback to unpkg/bin
    if (!result.entryPoint) {
      const fallback = legacy(manifest, {
        browser: false,
        fields: ["unpkg", "bin"],
      });

      if (typeof fallback === "string") {
        result.entryPoint = fallback;
      } else if (Array.isArray(fallback) && fallback[0]) {
        result.entryPoint = fallback[0];
      }
    }

    return result;
  } catch (e) {
    result.error = e as Error;
    dispatchEvent(LOGGER_WARN, `Legacy resolution failed: ${e}`);
    return result;
  }
}

/**
 * Apply browser remappings to a resolved path.
 *
 * Browser remappings can:
 * - Remap paths: "./lib/node.js" → "./lib/browser.js"
 * - Exclude modules: "fs" → false
 *
 * @param resolvedPath The resolved entry point
 * @param remappings Browser remapping object (or null)
 * @returns Remapped path, false (excluded), or original
 *
 * @example
 * ```ts
 * applyBrowserRemapping("./lib/node.js", { "./lib/node.js": "./lib/browser.js" })
 * // => "./lib/browser.js"
 *
 * applyBrowserRemapping("fs", { "fs": false })
 * // => false
 * ```
 */
export function applyBrowserRemapping(
  resolvedPath: string,
  remappings: BrowserRemappings | null
): string | false {
  if (!remappings || !resolvedPath) return resolvedPath;

  // Try multiple path variants for matching
  const variants = new Set([
    resolvedPath,
    resolvedPath.replace(/^\.\//, ""),
    resolvedPath.startsWith("./") ? resolvedPath : `./${resolvedPath.replace(/^\//, "")}`,
    resolvedPath.replace(/^\//, ""),
  ]);

  for (const variant of variants) {
    if (variant in remappings) {
      return remappings[variant];
    }
  }

  return resolvedPath;
}

// =============================================================================
// Combined Resolution
// =============================================================================

export interface PackageResolutionOptions {
  manifest: Partial<PackageJson | FullPackageVersion>;
  subpath: string;
  conditions: ResolverConditions;
  legacyFields: string[];
  /** Allow literal subpath when no resolution found */
  allowLiteralSubpath?: boolean;
}

/**
 * Combined resolution: modern exports first, then legacy fallback.
 *
 * @param options Resolution options
 * @returns Resolution result with normalized path
 */
export function resolvePackageEntry(options: PackageResolutionOptions): PackageResolutionResult {
  const { manifest, subpath, conditions, legacyFields, allowLiteralSubpath = false } = options;

  const result: PackageResolutionResult = {
    path: null,
    usedModern: false,
    appliedBrowserRemapping: false,
    browserRemappings: null,
    excluded: false,
  };

  // Normalize subpath
  const normalizedSubpath = subpath
    ? subpath.replace(/^\//, "./").replace(/^(?!\.)/, "./")
    : ".";

  // 1. Try modern exports field first
  const modernResult = resolveModern(manifest, normalizedSubpath, conditions);
  if (modernResult.success && modernResult.path) {
    result.path = modernResult.path;
    result.usedModern = true;
    return result;
  }

  // 2. Try legacy resolution (only for root/directory imports)
  const isRootOrEmpty = !subpath || subpath === "/" || subpath === "." || subpath === "";

  if (isRootOrEmpty) {
    const legacyResult = resolveLegacy(manifest, { browser: conditions.browser }, legacyFields);

    // Check if excluded for browser
    if (legacyResult.excluded) {
      result.excluded = true;
      result.error = new Error("Module excluded by browser field");
      return result;
    }

    if (legacyResult.entryPoint) {
      // Apply browser remapping if present
      const remapped = applyBrowserRemapping(legacyResult.entryPoint, legacyResult.browserRemappings);

      if (remapped === false) {
        result.excluded = true;
        result.error = new Error("Entry point excluded by browser remapping");
        return result;
      }

      result.path = remapped;
      result.browserRemappings = legacyResult.browserRemappings;
      result.appliedBrowserRemapping =
        legacyResult.browserRemappings !== null && remapped !== legacyResult.entryPoint;
      return result;
    }

    if (legacyResult.error) {
      result.error = legacyResult.error;
    }
  }

  // 3. Use literal subpath if allowed
  if (allowLiteralSubpath && subpath && subpath !== "/" && subpath !== ".") {
    result.path = normalizedSubpath;
    return result;
  }

  // 4. Last resort: common defaults
  if (isRootOrEmpty) {
    result.path = "./index.js";
  }

  return result;
}

// =============================================================================
// Peer Dependencies
// =============================================================================

/**
 * Compute merged peer dependencies for version stabilization.
 *
 * Handles:
 * - Cyclic dependencies (adds current package to peers)
 * - Version inheritance from initial deps
 *
 * @param config Peer deps config
 * @returns Merged peer dependencies
 */
export function computePeerDependencies(config: PeerDepsConfig): Record<string, string> {
  const {
    initialManifest,
    resolvedManifest,
    initialDeps,
    packageName,
    packageVersion,
    isNpmCdn,
  } = config;

  const peerDeps = Object.assign({},
    initialManifest?.peerDependencies ?? {},
    resolvedManifest?.peerDependencies ?? {},
    {
      // Some packages rely on cyclic dependencies, e.g. https://x.com/jsbundle/status/1792325771354149261
      // so we create a new field in peerDependencies and place the current package and it's version,
      // the algorithm should then be able to use the correct version if a dependency is cyclic
      [packageName]: isNpmCdn ? packageVersion : (initialDeps[packageName] ?? "latest"),
    }
  );

  // Inherit versions from initial deps, makes it easier to keep versions stable
  const inherited = structuredClone(peerDeps);
  for (const [name, version] of Object.entries(peerDeps)) {
    inherited[name] = initialDeps[name] ?? version;
  }

  return inherited;
}

// =============================================================================
// Side Effects
// =============================================================================

/**
 * Compute esbuild sideEffects value for tree-shaking.
 *
 * @param config Side effects config
 * @returns sideEffects value (false | undefined)
 */
export function computeSideEffects(config: SideEffectsConfig): boolean | undefined {
  return computeEsbuildSideEffects(
    config.manifest,
    config.resolvedSubpath,
    {
      matcherCache: config.matcherCache,
      packageId: config.packageId,
    }
  );
}

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Normalize resolved path for URL construction.
 *
 * @param path Resolved path
 * @returns Path starting with /
 *
 * @example
 * ```ts
 * normalizeResolvedPath("./dist/index.js") // "/dist/index.js"
 * normalizeResolvedPath("dist/index.js")   // "/dist/index.js"
 * ```
 */
export function normalizeResolvedPath(path: string): string {
  return path.replace(/^(\.\/)/, "/").replace(/^(?!\/)/, "/");
}

/**
 * Join subpath components.
 *
 * @param base Base subpath
 * @param extra Extra subpath
 * @returns Combined subpath
 */
export function joinSubpaths(base: string, extra: string): string {
  if (!base && !extra) return "";
  if (!base) return extra;
  if (!extra) return base;

  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedExtra = extra.replace(/^\/+/, "");

  return `${normalizedBase}/${normalizedExtra}`;
}