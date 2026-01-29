/**
 * External Plugin for esbuild
 *
 * Marks Node.js built-in modules and other packages as external,
 * optionally polyfilling them for browser environments.
 *
 * **Key Changes (v2)**:
 * - Polyfill mappings now imported from `@bundle/utils/runtime-builtins`
 * - Centralized module database with runtime support metadata
 * - Support for different polyfill profiles (conservative/aggressive/maximal)
 *
 * @module
 *
 * @example Basic usage (mark builtins as external)
 * ```ts
 * esbuild.build({
 *   plugins: [ExternalPlugin(ctx)],
 *   // fs, path, etc. will be marked external
 * });
 * ```
 *
 * @example With polyfills enabled
 * ```ts
 * // In config:
 * { polyfill: true }
 *
 * // fs → memfs, path → path-browserify, etc.
 * ```
 */
import type { LocalState, ESBUILD } from "../types.ts";
import type { CdnResolutionState } from "./cdn.ts";

import { Context, fromContext, withContext } from "../context/context.ts";
import { CdnResolution } from "./cdn.ts";

import { parsePackageName } from "@bundle/utils/parse-package-name";
import { encode } from "@bundle/utils/encode-decode";

import { getCDNUrl } from "../utils/cdn-format.ts";
import { isAlias } from "./alias.ts";

// Import polyfill utilities from centralized module
import {
  createExternalPatterns,
  DEPRECATED_API_PATHS,
  createPolyfillMapWithProfile
} from "@bundle/utils/runtime-builtins";

// =============================================================================
// Constants
// =============================================================================

/** External Plugin Namespace */
export const EXTERNALS_NAMESPACE = "external-globals";

/** An empty export as a Uint8Array */
export const EMPTY_EXPORT = encode("export default {}");

/**
 * List of polyfillable native node modules.
 *
 * Maps Node.js built-in modules to their browser polyfill packages.
 * For more control, use `createPolyfillMapWithProfile()` from runtime-builtins.
 *
 * @example
 * ```ts
 * PolyfillMap["path"]  // "path-browserify"
 * PolyfillMap["fs"]    // "memfs"
 * PolyfillMap["http"]  // "http-browserify"
 * ```
 *
 * @see createPolyfillMap from "@bundle/utils/runtime-builtins"
 */
export const PolyfillMap = createPolyfillMapWithProfile("maximal");

/** Array of native node packages (that are polyfillable) */
export const PolyfillKeys = Object.keys(PolyfillMap);

/**
 * APIs & Packages that were later removed from Node.js
 *
 * @deprecated Use DEPRECATED_API_PATHS from "@bundle/utils/runtime-builtins"
 */
export const DeprecatedAPIs = [...DEPRECATED_API_PATHS];

/**
 * Packages bundlejs should ignore, including deprecated APIs and polyfillable APIs.
 *
 * @see createExternalPatterns from "@bundle/utils/runtime-builtins"
 */
export const ExternalPackages = createExternalPatterns();

// =============================================================================
// Utilities
// =============================================================================

/**
 * Check if a module ID should be treated as external.
 *
 * Based on https://github.com/egoist/play-esbuild/blob/7e34470f9e6ddcd9376704cd8b988577ddcd46c9/src/lib/esbuild.ts#L51
 *
 * @param id Module identifier
 * @param external Additional external patterns
 * @returns The matching pattern, or undefined if not external
 *
 * @example
 * ```ts
 * isExternal("fs")           // "fs"
 * isExternal("path")         // "path"
 * isExternal("fs/promises")  // "fs"
 * isExternal("react")        // undefined
 * ```
 */
export function isExternal(id: string, external: string[] = []): string | undefined {
  const externals = ExternalPackages.concat(external);

  // Strip node: prefix for matching
  const normalizedId = id.startsWith("node:") ? id.slice(5) : id;

  return externals.find((pattern) => {
    if (pattern === normalizedId) return true;
    if (normalizedId.startsWith(`${pattern}/`)) return true;
    return false;
  });
}

// =============================================================================
// Plugin
// =============================================================================

/**
 * Esbuild EXTERNAL plugin
 *
 * Marks Node.js built-in modules as external, optionally redirecting
 * them to browser polyfills when the `polyfill` option is enabled.
 *
 * @param StateContext Plugin context with configuration
 *
 * @example Without polyfills (default)
 * ```ts
 * // Config: { polyfill: false }
 * // import "fs" → marked external, returns empty export
 * // import "path" → marked external, returns empty export
 * ```
 *
 * @example With polyfills
 * ```ts
 * // Config: { polyfill: true }
 * // import "fs" → resolved to "memfs"
 * // import "path" → resolved to "path-browserify"
 * ```
 *
 * @example Custom externals
 * ```ts
 * // Config: { esbuild: { external: ["my-native-pkg"] } }
 * // import "my-native-pkg" → marked external
 * ```
 */
export function ExternalPlugin<T>(StateContext: Context<LocalState<T>>): ESBUILD.Plugin {
  // Convert CDN values to URL origins
  const host = fromContext("host", StateContext)!;
  const LocalConfig = fromContext("config", StateContext)!;

  const { polyfill = false, esbuild = {} } = LocalConfig;
  const { external = [] } = esbuild;

  return {
    name: EXTERNALS_NAMESPACE,
    setup(build) {
      // Intercept import paths and check if they should be external.
      // If polyfill is enabled and the module has a polyfill, redirect
      // to the CDN resolution. Otherwise, mark as external.
      build.onResolve({ filter: /.*/ }, (args) => {
        // Strip node: prefix for lookup
        const path = args.path.replace(/^node:/, "");
        const { path: argPath } = getCDNUrl(path, host);

        const externalMatch = isExternal(argPath, external);

        if (externalMatch) {
          // Check if we should polyfill this module
          if (polyfill && isAlias(argPath, PolyfillMap) && !external.includes(argPath)) {
            const pkgDetails = parsePackageName(argPath);
            const aliasPath = PolyfillMap[pkgDetails.name as keyof typeof PolyfillMap];

            // Resolve the polyfill through CDN
            const ctx = withContext(
              { origin: host, build: Context.opaque(build) },
              StateContext
            ) as Context<CdnResolutionState<T>>;

            return CdnResolution(ctx)(Object.assign({}, args, { path: aliasPath }));
          }

          // Mark as external
          return {
            path: argPath,
            namespace: EXTERNALS_NAMESPACE,
            external: true,
          };
        }
      });

      // When an external module is loaded, return an empty export.
      // This prevents bundler errors while clearly indicating the
      // module was intentionally excluded.
      build.onLoad({ filter: /.*/, namespace: EXTERNALS_NAMESPACE }, (args) => {
        const isPolyfillable = isAlias(args.path, PolyfillMap);

        return {
          pluginName: EXTERNALS_NAMESPACE,
          contents: EMPTY_EXPORT,
          warnings: [
            {
              text: `${args.path} is marked as an external module and will be ignored.`,
              details: isPolyfillable
                ? `"${args.path}" is an unsupported built-in node module thus can't be bundled by https://bundlejs.com. Consider enabling polyfills or reach out at https://github.com/okikio/bundlejs if you encounter issues.`
                : null,
            },
          ],
        };
      });
    },
  };
}