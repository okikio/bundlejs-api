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

/** Path remapping table (used by browser, react-native, and similar fields) */
export interface PathRemappings {
  [source: string]: string | false;
}

/**
 * Top-level package.json fields that act as path remapping layers.
 *
 * Each entry maps a **condition name** (as it appears in the `conditions`
 * array computed by `getResolverConditions()`) to the **package.json
 * field** that holds its remapping object.
 *
 * Convention:
 * - `"browser"` — the original remapping field, defined by the
 *   [browser-field spec](https://github.com/nicolo-ribaudo/tc39-proposal-import-conditions#previous-work).
 *   Activated when the `"browser"` condition is present.
 * - `"react-native"` — Metro bundler convention. Activated when
 *   `"react-native"` is in conditions.
 * - `"electron"` — occasionally used; activated when `"electron"` is
 *   in conditions.
 *
 * The list is ordered from *most specific* to *least specific*. When
 * multiple remapping fields match the active conditions, the first
 * match wins — mirroring how `exports` condition ordering works.
 */
export const REMAPPING_FIELDS: ReadonlyArray<{ condition: string; field: string }> = [
  { condition: "react-native", field: "react-native" },
  { condition: "electron", field: "electron" },
  { condition: "browser", field: "browser" },
];

/** Result of applying manifest field remappings */
export interface RemappingResult {
  /** The path after remapping (or the original if nothing matched) */
  path: string;
  /** Set to `true` when the remapping maps the path to `false` (excluded) */
  excluded: boolean;
  /** Which field triggered the remapping (null if no remapping applied) */
  matchedField: string | null;
}

/** Result from modern exports/imports resolution */
export interface ModernResolutionResult {
  path: string | null;
  success: boolean;
  error?: Error;
}

/**
 * Reasons a module was excluded during resolution.
 *
 * Path remapping fields (browser, react-native, electron) can all
 * remap a module to `false`, meaning "this module doesn't exist for
 * this platform". The reason describes which field or mechanism caused it:
 *
 * - `"field-remapping"` — a remapping field (browser/react-native/electron)
 *   excluded the module (either string `false` or object `{ ... : false }`)
 * - `"no-entry-point"` — no entry point was found in the manifest at all
 *
 * @deprecated The old values "browser" and "browser-remapping" are still
 *             accepted for backwards compatibility but new code should use
 *             "field-remapping".
 */
export type ExclusionReason = "field-remapping" | "no-entry-point" | "browser" | "browser-remapping";

/** Result from legacy field resolution */
export interface LegacyResolutionResult {
  /** Resolved entry point (from main/module, NOT remapping object keys) */
  entryPoint: string | null;
  /** Path remappings to apply from remapping fields (browser, react-native, etc.) */
  pathRemappings: PathRemappings | null;
  /** Whether module is excluded by a path remapping field (browser, react-native, electron) */
  excluded: boolean;
  /** Which mechanism caused the exclusion — helps generate accurate error messages */
  exclusionReason?: ExclusionReason;
  error?: Error;
}

/**
 * Combined package-entry resolution result.
 *
 * There are two distinct kinds of successful results in this structure:
 *
 * 1. **Explicit result**
 *    `path` names the actual entry selected by `exports`, `main`, `module`,
 *    browser string entry, or literal subpath handling.
 *    Examples: `./dist/index.js`, `./index.json`, `./feature`, `./index.cjs`
 *
 * 2. **Implicit root fallback result**
 *    `path === "./index.js"` and `usedDefaultRootFallback === true` means
 *    legacy resolution found no declared entry point and the resolver is
 *    signaling "treat the package root like a CommonJS package directory".
 *
 *    That signal is intentionally stronger than the literal string `./index.js`:
 *    consumers must not treat it as an explicit request for the concrete file
 *    `index.js`. Instead, downstream loaders may apply Node-style implicit
 *    package-entry probing from the package root, currently `.js` and `.json`
 *    in bundlejs.
 *
 * Why this exists:
 * - The string fallback keeps the high-level resolver API compatible with the
 *   long-standing `./index.js` default.
 * - The boolean distinguishes "explicit `index.js`" from "implicit package
 *   root fallback" so downstream code can preserve the correct probing rules.
 */
export interface PackageResolutionResult {
  /** Resolved path (normalized) */
  path: string | null;
  /** Whether modern exports was used */
  usedModern: boolean;
  /**
   * Whether resolution fell back to the implicit package-root entry contract.
   *
   * When true, `path` is the legacy placeholder `./index.js`, but downstream
   * consumers should interpret that as "probe from the package root using the
   * implicit fallback rules" rather than "fetch exactly ./index.js".
   */
  usedDefaultRootFallback: boolean;
  /** Whether a path remapping field (browser, react-native, electron) was applied */
  appliedPathRemapping: boolean;
  /** Path remappings collected from manifest fields (for child resolution) */
  pathRemappings: PathRemappings | null;
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
 * This supports:
 * - `exports` resolution (subpaths like "." or "./feature")
 * - `imports` resolution (subpath imports like "#minpath")
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
 * 
 * @example exports
 * ```ts
 * resolveModern(pkg, ".", conditions)
 * ```
 *
 * @example imports (Node subpath imports)
 * ```ts
 * resolveModern(pkg, "#minpath", conditions)
 * ```
 */
export function resolveModern(
  manifest: Partial<PackageJson | FullPackageVersion>,
  subpath: string,
  conditions: ResolverConditions
): ModernResolutionResult {
  const isSubpathImport = subpath.startsWith("#");

  // Normalize subpath for exports resolution
  const exportSubpath = isSubpathImport ? subpath : (
    subpath.startsWith("./") ? subpath :
      subpath === "" || subpath === "." ? "." :
        `./${subpath.replace(/^\//, "")}`
  );

  // Primary resolution with specified conditions.
  // Wrapped in its own try/catch so a throw (e.g. "No known conditions")
  // doesn't short-circuit the CJS fallback below.
  let resolved: string[] | void;
  try {
    resolved = resolve(manifest, exportSubpath, {
      browser: conditions.browser,
      conditions: conditions.conditions,
      require: conditions.require,
      unsafe: true, // Allow resolution even without explicit exports conditions
    });
  } catch {
    // Primary resolution failed — fall through to CJS fallback
    resolved = undefined;
  }

  // Compatibility fallback: try require if ESM failed
  if (!resolved && !conditions.require) {
    try {
      resolved = resolve(manifest, exportSubpath, {
        browser: conditions.browser,
        conditions: ["require", ...conditions.conditions],
        require: true,
        unsafe: true, // Suppress throws for missing conditions
      });
    } catch {
      // CJS fallback also failed
      resolved = undefined;
    }
  }

  if (resolved) {
    const path = Array.isArray(resolved) ? resolved[0] : resolved;
    if (typeof path === "string") {
      return { path, success: true };
    }
  }

  return { path: null, success: false };
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
 * // result.pathRemappings = null
 * ```
 *
 * @example Object browser field (THE FIX)
 * ```ts
 * // { "browser": { "./lib/node.js": "./lib/browser.js" }, "main": "./lib/index.js" }
 * const result = resolveLegacy(manifest, { browser: true }, fields);
 * // result.entryPoint = "./lib/index.js" (from main, NOT browser keys!)
 * // result.pathRemappings = { "./lib/node.js": "./lib/browser.js" }
 * ```
 */
export function resolveLegacy(
  manifest: Partial<PackageJson | FullPackageVersion>,
  conditions: { browser: boolean },
  legacyFields: string[]
): LegacyResolutionResult {
  const result: LegacyResolutionResult = {
    entryPoint: null,
    pathRemappings: null,
    excluded: false,
  };

  try {
    // Step 0: Direct boolean false check on browser field
    // resolve.exports' legacy() falls through to main when browser is false,
    // so we must detect this exclusion before calling legacy()
    if (conditions.browser && manifest.browser === false) {
      result.excluded = true;
      result.exclusionReason = "field-remapping";
      return result;
    }

    // Step 1: Check browser field if browser conditions requested
    if (conditions.browser) {
      const withBrowser = legacy(manifest, {
        browser: true,
        fields: legacyFields,
      });

      // Case: browser field is `false` - module excluded
      // IMPORTANT: Only treat this as browser exclusion if the manifest
      // actually has a "browser" field. When no fields match at all
      // (e.g. empty manifest), legacy() also returns falsy — that's NOT
      // a browser exclusion, it just means "nothing found yet".
      if (!withBrowser) {
        const hasBrowserField = "browser" in manifest && manifest.browser !== undefined;
        if (hasBrowserField) {
          result.excluded = true;
          result.exclusionReason = "field-remapping";
          return result;
        }
        // No browser field in manifest → fall through to Step 2
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
          result.exclusionReason = "field-remapping";
          return result;
        }

        // Store remappings for later application
        result.pathRemappings = withBrowser as PathRemappings;
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

    if (entryPoint) {
      if (typeof entryPoint === "string") {
        result.entryPoint = entryPoint;
      } else if (Array.isArray(entryPoint)) {
        result.entryPoint = entryPoint[0] ?? null;
      } else if (typeof entryPoint === "object" && entryPoint !== null) {
        // Shouldn't happen with browser: false, but handle defensively
        const validEntry = Object.entries(entryPoint).find(([, v]) => v && typeof v === "string");
        result.entryPoint = validEntry ? (validEntry[1] as string) : null;
      }
    }

    // Step 3: Fallback to unpkg/bin (runs when Step 2 found nothing)
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

    // After all steps exhausted, mark as no-entry-point
    if (!result.entryPoint && !result.pathRemappings) {
      result.excluded = true;
      result.exclusionReason = "no-entry-point";
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
 * applyPathRemapping("./lib/node.js", { "./lib/node.js": "./lib/browser.js" })
 * // => "./lib/browser.js"
 *
 * applyPathRemapping("fs", { "fs": false })
 * // => false
 * ```
 */
export function applyPathRemapping(
  resolvedPath: string,
  remappings: PathRemappings | null
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

/**
 * Apply all active manifest remapping fields to a resolved path.
 *
 * Iterates over `REMAPPING_FIELDS` in priority order. For each field
 * whose condition appears in the active conditions list, it checks
 * whether the manifest has a matching top-level object and whether
 * that object contains a remapping for the given path.
 *
 * The first field that produces a remapping wins — subsequent fields
 * are not consulted. This mirrors the "first match" semantics of
 * `exports` conditions.
 *
 * @param resolvedPath  Package-relative path (e.g. `"./fallback/platform.js"`)
 * @param manifest      The package's manifest (package.json)
 * @param conditions    Active resolver conditions
 * @returns Remapping result with the (possibly rewritten) path
 *
 * @example browser remapping
 * ```ts
 * // manifest.browser = { "./fallback/platform.js": "./fallback/platform.browser.js" }
 * applyManifestRemappings("./fallback/platform.js", manifest, conditions)
 * // => { path: "./fallback/platform.browser.js", excluded: false, matchedField: "browser" }
 * ```
 *
 * @example react-native remapping
 * ```ts
 * // manifest["react-native"] = { "./utf16.js": "./utf16.native.js" }
 * // conditions.conditions includes "react-native"
 * applyManifestRemappings("./utf16.js", manifest, conditions)
 * // => { path: "./utf16.native.js", excluded: false, matchedField: "react-native" }
 * ```
 *
 * @example exclusion (mapped to false)
 * ```ts
 * // manifest.browser = { "fs": false }
 * applyManifestRemappings("fs", manifest, conditions)
 * // => { path: "fs", excluded: true, matchedField: "browser" }
 * ```
 */
export function applyManifestRemappings(
  resolvedPath: string,
  manifest: Partial<PackageJson | FullPackageVersion> | null | undefined,
  conditions: ResolverConditions
): RemappingResult {
  const noChange: RemappingResult = { path: resolvedPath, excluded: false, matchedField: null };
  if (!manifest || !resolvedPath) return noChange;

  // Build a Set for O(1) condition lookups.
  // Include the "browser" pseudo-condition when `conditions.browser` is true,
  // since the browser flag lives outside the conditions array.
  const activeConditions = new Set(conditions.conditions);
  if (conditions.browser) activeConditions.add("browser");

  for (const { condition, field } of REMAPPING_FIELDS) {
    if (!activeConditions.has(condition)) continue;

    // Access the field dynamically — these are conventional top-level keys
    // ("browser", "react-native", "electron", etc.).
    const remappingTable = (manifest as Record<string, unknown>)[field];
    if (!remappingTable || typeof remappingTable !== "object") continue;

    const remapped = applyPathRemapping(resolvedPath, remappingTable as PathRemappings);

    if (remapped === false) {
      return { path: resolvedPath, excluded: true, matchedField: field };
    }

    if (remapped !== resolvedPath) {
      return { path: remapped, excluded: false, matchedField: field };
    }
  }

  return noChange;
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
 * Mechanism summary:
 * - Prefer `exports` when present.
 * - Otherwise use legacy entry fields (`browser` string, `module`, `main`,
 *   unpkg/bin fallbacks) for root package resolution.
 * - If no declared entry exists and this is still the package root, return the
 *   legacy placeholder `./index.js` plus `usedDefaultRootFallback = true`.
 *
 * Why the placeholder still exists:
 * - Historical callers already understand `./index.js` as the last-resort root
 *   entry marker.
 * - The separate boolean lets callers preserve the old shape while handling the
 *   result with more precise Node-style fallback semantics downstream.
 *
 * @param options Resolution options
 * @returns Resolution result with normalized path
 */
export function resolvePackageEntry(options: PackageResolutionOptions): PackageResolutionResult {
  const { manifest, subpath, conditions, legacyFields, allowLiteralSubpath = false } = options;

  const result: PackageResolutionResult = {
    path: null,
    usedModern: false,
    usedDefaultRootFallback: false,
    appliedPathRemapping: false,
    pathRemappings: null,
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

    // Check if excluded by a path remapping field
    if (legacyResult.excluded) {
      const reason = legacyResult.exclusionReason;
      
      if ((reason === "field-remapping" || reason === "browser" || reason === "browser-remapping") && conditions.browser) {
      // Genuine platform exclusion (remapping field is false or all-false object)
        result.excluded = true;
        result.error = new Error("Module excluded by path remapping field");
        (result as { exclusionReason?: string }).exclusionReason = reason;
        return result;
      }

      // "no-entry-point" — legacy found nothing, but resolvePackageEntry
      // still has its own ./index.js fallback (step 4), so don't bail out.
      // Just fall through.
    }

    if (legacyResult.entryPoint) {
      // Apply browser remapping if present
      const remapped = applyPathRemapping(legacyResult.entryPoint, legacyResult.pathRemappings);

      if (remapped === false) {
        result.excluded = true;
        result.error = new Error("Entry point excluded by browser remapping");
        return result;
      }

      result.path = remapped;
      result.pathRemappings = legacyResult.pathRemappings;
      result.appliedPathRemapping =
        legacyResult.pathRemappings !== null && remapped !== legacyResult.entryPoint;
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

  // 4. Last resort: implicit package-root CommonJS fallback.
  //
  // We intentionally return the historical `./index.js` marker here, but also
  // set `usedDefaultRootFallback` so downstream loaders know this was not an
  // explicit manifest choice. They may probe from the package root using the
  // bounded implicit fallback rules instead of fetching `./index.js` literally.
  if (isRootOrEmpty) {
    result.path = "./index.js";
    result.usedDefaultRootFallback = true;
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