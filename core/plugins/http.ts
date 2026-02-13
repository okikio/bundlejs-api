/** Inspired by https://github.com/hardfist/neo-tools/blob/main/packages/bundler/src/plugins/http.ts */
/**
 * HTTP Plugin for esbuild
 *
 * Handles HTTP/HTTPS URL resolution and content loading:
 * - Resolves relative imports within downloaded files
 * - Resolves bare imports via CdnResolution
 * - Fetches file content with extension probing
 * - Extracts assets (WASM, Workers) from fetched files
 *
 * @module
 *
 * @example Direct HTTP import
 * ```ts
 * import { something } from "https://esm.sh/lodash@4.17.21";
 * // -> HTTP_NAMESPACE, loads content from URL
 * ```
 *
 * @example Relative import from HTTP source
 * ```ts
 * // Inside https://esm.sh/lodash@4.17.21/index.js
 * import { debounce } from "./debounce.js";
 * // -> Resolved to https://esm.sh/lodash@4.17.21/debounce.js
 * ```
 */
import type { ESBUILD, LocalState } from "../types.ts";

import { Context, fromContext, toContext, withContext } from "../context/context.ts";
import { CdnResolution } from "./cdn.ts";

import { fetchContent, fetchHeaders } from "@bundle/utils/fetch-and-cache";
import { decode } from "@bundle/utils/encode-decode";

import { LOGGER_ERROR, LOGGER_INFO, LOGGER_WARN, dispatchEvent } from "../configs/events.ts";
import { maybeStripFlow } from "../utils/flow-strip.ts";

import { DEFAULT_CDN_HOST, getCDNStyle, getCDNUrl } from "../utils/cdn-format.ts";
import { applyManifestRemappings } from "../utils/cdn-resolution.ts";
import { getResolverConditions } from "@bundle/utils/resolve-conditions";
import { inferLoader } from "../utils/loader.ts";
import { setFile } from "../utils/filesystem.ts";

import { isBareImport, isAbsolute } from "@bundle/utils/path";
import { toURLPath, urlJoin } from "@bundle/utils/url";
import { looksLikeJSRSpec } from "@bundle/utils/jsr-spec";

import { EMPTY_EXPORT } from "./external.ts";

/** HTTP Plugin Namespace */
export const HTTP_NAMESPACE = "http-url";

/**
 * Namespace for modules excluded by per-module path remappings (e.g.,
 * `browser: { "./some-module.js": false }`). These get served an empty
 * module stub instead of triggering a build error.
 *
 * Per the Node.js spec, when a per-module remapping resolves to `false`,
 * the module should be replaced with an empty object — NOT treated as a
 * hard build failure. Package-level `browser: false` (the string form)
 * is still an error, handled by CdnPlugin.
 */
export const EXCLUDED_MODULE_NAMESPACE = "excluded-module";

export interface HttpResolutionState<T> extends LocalState<T> {
  build: ESBUILD.PluginBuild
}

// ============================================================================
// Fetch Wrappers
// ============================================================================

/**
 * Fetches package content from a URL.
 * 
 * Returns the **final URL** after any redirects, which is critical for
 * resolving relative imports within the fetched content.
 */
export async function fetchPkg(
  url: string, 
  opts: { fetchOpts?: RequestInit; retry?: number; cacheMode?: 'normal' | 'force' | 'reload' | 'no-store'; signal?: AbortSignal } = {}
): Promise<{ url: string; content: Uint8Array; contentType: string | null }> {
  const { fetchOpts, retry, cacheMode = 'normal', signal } = opts;
  
  try {
    const result = await fetchContent(url, {
      init: fetchOpts,
      retries: retry,
      cacheMode,
      signal,
    });

    // Build descriptive log message
    const flags = [
      result.fromCache && 'cached',
      result.redirected && 'redirected',
    ].filter(Boolean).join(', ');
    
    const flagStr = flags ? ` (${flags})` : '';
    const redirectStr = result.redirected ? ` → ${result.url}` : '';
    
    dispatchEvent(LOGGER_INFO, `Fetch${flagStr} ${url}${redirectStr}`);

    return {
      url: result.url,
      content: result.content,
      contentType: result.contentType,
    };
  } catch (e) {
    const err = e as Error;
    throw new Error(`[fetchPkg] Failed to fetch ${url}\n${err.message}`, { cause: err });
  }
}

/**
 * Fetches only headers from a URL (for extension probing).
 * Uses HEAD request with GET fallback for servers that don't support HEAD.
 * 
 * Returns the **final URL** after any redirects.
 */
export async function fetchPkgHeaders(
  url: string, 
  opts: { retry?: number; cacheMode?: 'normal' | 'force' | 'reload' | 'no-store'; signal?: AbortSignal } = {}
): Promise<{ url: string; contentType: string | null }> {
  try {
    const result = await fetchHeaders(url, { retries: opts.retry, cacheMode: opts.cacheMode, signal: opts.signal });
    return {
      url: result.url,
      contentType: result.contentType,
    };
  } catch (e) {
    const err = e as Error;
    throw new Error(`[fetchPkgHeaders] Failed to probe ${url}\n${err.message}`, { cause: err });
  }
}

// ============================================================================
// Asset Discovery
// ============================================================================

/**
 * Fetches assets referenced in JS files via `new URL("...", import.meta.url)`
 *
 * External assets like WASM files and Workers are discovered and fetched.
 * These are stored in the virtual file system for later bundling.
 *
 * @param path URL path for the original JS file (must be final URL after redirects)
 * @param content Content of the original JS file
 * @param StateContext Context with filesystem access
 * @returns Promise of settled results for each discovered asset
 */
export async function fetchAssets<T>(
  path: string, 
  content: Uint8Array<ArrayBuffer>, 
  StateContext: Context<LocalState<T>>
) {
  // Regex for `new URL("./path.js", import.meta.url)`,
  // Supports comments so you can add comments and the regex will ignore them
  const rgx = /new(?:\s|\n?)+URL\((?:\s*(?:\/\*(?:.*\n)*\*\/)?(?:\/\/.*\n)?)*(?:(?!\`.*\$\{)['"`](.*)['"`]),(?:\s*(?:\/\*(?:.*\n)*\*\/)?(?:\/\/.*\n)?)*import\.meta\.url(?:\s*(?:\/\*(?:.*\n)*\*\/)?(?:\/\/.*\n)?)*\)/g;
  const parentURL = new URL("./", path).toString();

  const FileSystem = fromContext("filesystem", StateContext);

  const code = decode(content);
  const matches = Array.from(code.matchAll(rgx)) as RegExpMatchArray[];

  const promises = matches.map(async ([, assetURL]) => {
    const abort = fromContext("abort", StateContext);
    const { content: asset, url } = await fetchPkg(urlJoin(parentURL, assetURL), { signal: abort.signal });

    // Store asset in virtual file system for bundle analyzer
    if (FileSystem) {
      const filePath = toURLPath(url);
      await setFile(FileSystem, filePath, asset);
    }

    const hashBuffer = await crypto.subtle.digest("SHA-256", asset as BufferSource);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    return {
      path: assetURL,
      contents: asset,
      get text() { return decode(asset as BufferSource); },
      hash: hashHex
    };
  });

  return await Promise.allSettled(promises);
}

// ============================================================================
// Extension Probing
// ============================================================================

/** Path variants to try when extension is missing */
export const FilePaths = ["", "/index"];

/** File extensions to probe */
export const FileEndings = ["", ".js", ".mjs", ".ts", ".tsx", ".cjs", ".jsx", ".mts", ".cts"];

/** All combinations of path + extension to try */
export const AllEndingVariants = Array.from(
  new Set(
    FilePaths.flatMap(path => FileEndings.map(ext => path + ext))
  )
);

export const EndingVariantsLength = AllEndingVariants.length;

/**
 * Probes for the correct file extension when not explicitly provided.
 *
 * TypeScript files often don't have file extensions in imports, but servers
 * require the full path. This function tries multiple extensions until one works.
 *
 * @param path Base path to probe
 * @param headersOnly If true, only fetch headers (faster for probing)
 * @param StateContext Optional context for caching failed probes
 * @returns Object with resolved url, contentType, and optionally content
 */
export async function determineExtension<T>(
  path: string,
  { headersOnly = true, StateContext = null }: {
    headersOnly?: boolean;
    StateContext?: Context<LocalState<T>> | null;
  } = {}
): Promise<{ url: string; contentType: string | null; content?: Uint8Array }> {
  const failedExtChecks = StateContext
    ? fromContext("failedExtensionChecks", StateContext)
    : null;
  const failedSet = failedExtChecks ?? new Set<string>();
  const abort = StateContext ? fromContext("abort", StateContext) : undefined;

  let firstError: Error | undefined;

  for (let i = 0; i < EndingVariantsLength; i++) {
    const suffix = AllEndingVariants[i];
    const testUrl = path + suffix;

    // Skip URLs we've already tried and failed
    if (failedSet.has(testUrl)) continue;

    try {
      // Use 'force' cacheMode to prevent background refresh during extension probing.
      // Background refresh with extensionless URLs can 404 if the CDN doesn't consistently
      // redirect/resolve extensionless paths.
      if (headersOnly) {
        const { url, contentType } = await fetchPkgHeaders(testUrl, { cacheMode: 'reload', signal: abort?.signal });
        return { url, contentType };
      } else {
        const { url, contentType, content } = await fetchPkg(testUrl, { cacheMode: 'normal', signal: abort?.signal });
        return { url, contentType, content };
      }
    } catch (e) {
      failedSet.add(testUrl);
      
      // Keep the first error as it's usually most accurate
      if (i === 0) firstError = e as Error;

      // If we've exhausted all variants, throw
      if (i >= EndingVariantsLength - 1) {
        const error = firstError ?? e;
        dispatchEvent(LOGGER_ERROR, error as Error);
        throw error;
      }
    }
  }

  // TypeScript: unreachable, but needed for type safety
  throw new Error(`[determineExtension] Failed to resolve ${path}`);
}

// ============================================================================
// esbuild Resolution
// ============================================================================

/**
 * Resolution algorithm for the esbuild HTTP plugin
 *
 * Handles three cases:
 * 1. HTTP/HTTPS URLs - direct load via HTTP_NAMESPACE
 * 2. Bare imports - delegate to CdnResolution
 * 3. Relative/absolute imports - resolve against parent URL
 *
 * **Important**: Uses `pluginData.url` (the final URL after redirects) as the
 * base for resolving relative imports. This ensures correct resolution when
 * CDN aliases like `@latest` redirect to specific versions.
 */
export function HttpResolution<T>(StateContext: Context<HttpResolutionState<T>>) {
  const host = fromContext("host", StateContext)!;
  const build = fromContext("build", StateContext)!;

  // Extract resolve config for computing conditions (needed for browser field remapping)
  const LocalConfig = fromContext("config", StateContext)!;
  const esbuildOpts = LocalConfig.esbuild ?? {};
  const resolveOpts = LocalConfig.resolve ?? {};
  const effectiveResolveOpts = Object.assign({}, resolveOpts, esbuildOpts);

  return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
    const argPath = args.path;

    // Non-relative imports
    if (!argPath.startsWith(".") && !isAbsolute(argPath)) {
      // Direct HTTP URL
      if (/^https?:\/\//.test(argPath)) {
        return {
          path: argPath,
          namespace: HTTP_NAMESPACE,
          sideEffects: typeof args.pluginData?.manifest?.sideEffects === "boolean"
            ? args.pluginData?.manifest.sideEffects
            : undefined,
          pluginData: args.pluginData,
        };
      }

      // Determine origin for resolution
      const pathOrigin = new URL(
        urlJoin(args.pluginData?.url ?? host, "../", argPath)
      ).origin;

      const NPM_CDN = getCDNStyle(pathOrigin) === "npm";

      // Registry mode takes priority: when the user configures cdn: "npm.registry"
      // or cdn: "npm", ALL bare imports should resolve through the registry as
      // tarballs, regardless of which CDN the parent file was loaded from.
      // Without this, a file loaded from e.g. esm.sh would resolve its deps
      // through esm.sh (CDN-follows-parent) instead of the configured registry.
      const REGISTRY_HOST = getCDNStyle(host) === "registry";
      const origin = REGISTRY_HOST ? host : (NPM_CDN ? pathOrigin : host);

      // Bare import (e.g., "lodash") → delegate to CDN resolution
      // Also handle private imports (#internal) and JSR spec imports
      if (/^#/.test(argPath) || isBareImport(argPath) || looksLikeJSRSpec(argPath)) {
        const ctx = withContext({ origin, build: Context.opaque(build) }, StateContext);
        return await CdnResolution(ctx)(args);
      }

      // Absolute import (e.g., "/lib/foo") → resolve against CDN origin
      return {
        path: getCDNUrl(argPath, origin).url.toString(),
        namespace: HTTP_NAMESPACE,
        sideEffects: typeof args.pluginData?.manifest?.sideEffects === "boolean"
          ? args.pluginData?.manifest.sideEffects
          : undefined,
        pluginData: args.pluginData,
      };
    }

    // Relative imports - resolve against parent's final URL
    let resolvedPath: string;
    
    if (isAbsolute(argPath)) {
      const parentUrl = new URL(args.pluginData?.url);
      parentUrl.pathname = argPath;
      resolvedPath = parentUrl.toString();
    } else {
      // Relative: "./foo" resolved against parent URL
      resolvedPath = urlJoin(args.pluginData?.url, "../", argPath);
    }

    // ========================================================================
    // Apply manifest field remappings for relative imports within a package
    //
    // Several top-level package.json fields ("browser", "react-native",
    // "electron") act as path-remapping layers. When the active resolve
    // conditions include one of those fields, matching relative imports
    // are rewritten to the platform-specific variant.
    //
    // Example — @exodus/bytes with browser conditions active:
    //   manifest.browser = { "./fallback/platform.js": "./fallback/platform.browser.js" }
    //   "./fallback/platform.js" → "./fallback/platform.browser.js"
    //
    // Example — react-native conditions active:
    //   manifest["react-native"] = { "./utf16.js": "./utf16.native.js" }
    //   "./utf16.js" → "./utf16.native.js"
    //
    // The packageBaseUrl (set by CdnPlugin) lets us convert the resolved
    // absolute URL back to a package-relative path for field lookup.
    // ========================================================================
    const manifest = args.pluginData?.manifest;
    const packageBaseUrl: string | undefined = args.pluginData?.packageBaseUrl;

    if (packageBaseUrl && manifest && resolvedPath.startsWith(packageBaseUrl)) {
      const conditions = getResolverConditions(args, effectiveResolveOpts);
      const packageRelPath = "./" + resolvedPath.slice(packageBaseUrl.length);
      const { path: remappedPath, excluded, matchedField } = applyManifestRemappings(
        packageRelPath,
        manifest,
        conditions,
      );

      if (excluded) {
        // Per-module remap to false → behavior depends on config.
        // Default is "stub" (spec-compliant empty export, matching webpack/rollup).
        // Package-level `browser: false` (whole-package exclusion) is
        // handled by CdnPlugin and defaults to "error".
        const importPolicy = LocalConfig.remapFalse?.importRemapFalse ?? "stub";
        const warnOnStub = LocalConfig.remapFalse?.warnOnStubbedRemapFalse ?? true;

        if (importPolicy === "error") {
          return {
            errors: [{
              text: `Module "${packageRelPath}" is excluded for the current environment`,
              detail: `Excluded by "${matchedField}" field in package.json for "${manifest.name ?? "unknown"}".`,
            }],
          };
        }

        if (importPolicy === "external") {
          dispatchEvent(LOGGER_INFO, `Marking excluded module "${packageRelPath}" (${matchedField} field) as external in "${manifest.name ?? "unknown"}"`);
          return {
            path: args.path,
            external: true,
          };
        }

        // Default: "stub"
        dispatchEvent(LOGGER_INFO, `Stubbing excluded module "${packageRelPath}" (${matchedField} field) in "${manifest.name ?? "unknown"}"`);
        return {
          path: `${manifest.name ?? "unknown"}/${packageRelPath}`,
          namespace: EXCLUDED_MODULE_NAMESPACE,
          pluginData: Object.assign({}, args.pluginData, {
            excludedBy: matchedField,
            originalPath: packageRelPath,
            suppressWarning: !warnOnStub,
          }),
        };
      }

      if (remappedPath !== packageRelPath) {
        resolvedPath = packageBaseUrl + remappedPath.replace(/^\.\//, "");
      }
    }

    return {
      path: resolvedPath,
      namespace: HTTP_NAMESPACE,
      sideEffects: typeof args.pluginData?.manifest?.sideEffects === "boolean"
        ? args.pluginData?.manifest.sideEffects
        : undefined,
      pluginData: args.pluginData,
    };
  };
}

// ============================================================================
// esbuild Plugin
// ============================================================================

/**
 * esbuild HTTP plugin for loading modules from URLs
 *
 * @param StateContext Context with config, assets, and filesystem
 */
export function HttpPlugin<T>(StateContext: Context<LocalState<T>>): ESBUILD.Plugin {
  // Resolve CDN host
  const LocalConfig = fromContext("config", StateContext)!;
  const { origin: host } = LocalConfig?.cdn && !/:/.test(LocalConfig?.cdn)
    ? getCDNUrl(LocalConfig?.cdn + ":")
    : getCDNUrl(LocalConfig?.cdn ?? DEFAULT_CDN_HOST);

  toContext("host", host ?? DEFAULT_CDN_HOST, StateContext);

  const Assets = fromContext("assets", StateContext) ?? [];
  const FileSystem = fromContext("filesystem", StateContext);

  return {
    name: HTTP_NAMESPACE,
    setup(build) {
      const ctx = withContext({ build: Context.opaque(build) }, StateContext);

      // Route HTTP/HTTPS URLs to this plugin
      build.onResolve({ filter: /^https?:\/\// }, args => ({
        path: args.path,
        namespace: HTTP_NAMESPACE,
        sideEffects: typeof args.pluginData?.manifest?.sideEffects === "boolean"
          ? args.pluginData?.manifest.sideEffects
          : undefined,
        pluginData: args.pluginData,
      }));

      // Route all imports within HTTP namespace through HttpResolution
      build.onResolve({ filter: /.*/, namespace: HTTP_NAMESPACE }, HttpResolution(ctx));

      // ====================================================================
      // Excluded module stubs
      //
      // When a per-module path remapping (browser, react-native, etc.)
      // maps a file to `false`, we serve an empty export stub. This is
      // spec-compliant: the module "doesn't exist" on this platform, so
      // consumers get `{}` at runtime — exactly like webpack/rollup.
      // ====================================================================
      build.onLoad({ filter: /.*/, namespace: EXCLUDED_MODULE_NAMESPACE }, (args) => {
        const field = args.pluginData?.excludedBy ?? "unknown";
        const originalPath = args.pluginData?.originalPath ?? args.path;
        const suppressWarning = args.pluginData?.suppressWarning === true;

        return {
          contents: EMPTY_EXPORT,
          loader: "js",
          warnings: suppressWarning ? [] : [{
            text: `Module "${originalPath}" stubbed (empty export)`,
            detail: `Excluded by "${field}" field in package.json. The module is replaced with an empty object for the current platform.`,
          }],
        };
      });

      // Whether esbuild has source maps enabled — when true we ask
      // maybeStripFlow to embed an inline source map so esbuild can
      // fold the Flow transformation into the final bundle map.
      const enableSourceMaps = !!build.initialOptions.sourcemap;

      // Load content from HTTP URLs
      build.onLoad({ filter: /.*/, namespace: HTTP_NAMESPACE }, async (args) => {
        // Probe for correct extension and fetch content
        const { url, content, contentType } = await determineExtension(args.path, {
          headersOnly: false,
          StateContext,
        });

        if (!content) return;

        // Store in virtual filesystem for bundle analyzer
        if (FileSystem) {
          const filePath = toURLPath(url);
          await setFile(FileSystem, filePath, content);
        }

        // Discover and fetch assets (WASM, Workers, etc.)
        const assetResults = await fetchAssets(url, content as Uint8Array<ArrayBuffer>, StateContext);
        
        const resolvedAssets = assetResults
          .filter((result): result is PromiseFulfilledResult<ESBUILD.OutputFile> => {
            if (result.status === "rejected") {
              dispatchEvent(LOGGER_WARN, `Asset fetch failed for '${url}':\n${result.reason}`);
              return false;
            }
            return true;
          })
          .map(result => result.value);

        toContext("assets", Assets.concat(resolvedAssets), StateContext);

        // Strip Flow type annotations from files that use Flow syntax.
        // React Native and the Metro/Expo ecosystem ship .js files with raw
        // Flow annotations (e.g. `import typeof`). esbuild can't parse Flow,
        // so we pre-process these files before handing them to the bundler.
        const { contents: processedContent, wasStripped } = maybeStripFlow(
          content as Uint8Array,
          { url, sourceMap: enableSourceMaps }
        );

        if (wasStripped) {
          dispatchEvent(LOGGER_INFO, `Stripped Flow types from ${url}`);
        }

        return {
          contents: processedContent,
          loader: inferLoader(url, contentType, content),
          // CRITICAL: Pass the final URL (after redirects) in pluginData
          // This is used as the base URL for resolving relative imports
          pluginData: { ...args.pluginData, url },
        };
      });
    },
  };
}