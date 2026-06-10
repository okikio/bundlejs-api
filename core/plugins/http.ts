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
import type { AsyncDisposableStack } from "@bundle/utils/dispose";

import { Context, fromContext, toContext, withContext } from "../context/context.ts";

import { fetchContent, fetchHeaders } from "@bundle/utils/fetch-and-cache";
import { decode } from "@bundle/utils/encode-decode";

import { LOGGER_ERROR, LOGGER_INFO, dispatchEvent } from "../configs/events.ts";

import { DEFAULT_CDN_HOST, getCDNStyle, getCDNUrl } from "../utils/cdn-format.ts";
import { setFile } from "../utils/filesystem.ts";
import { PACKAGE_ENTRY_RESOLVE_EXTENSIONS, _knownExtensions } from "../utils/loader.ts";

import { extname, isBareImport, isAbsolute } from "@bundle/utils/path";
import { toURLPath, urlJoin } from "@bundle/utils/url";
import { looksLikeJSRSpec } from "@bundle/utils/jsr-spec";

/** HTTP Plugin Namespace */
export const HTTP_NAMESPACE = "http-url";

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
  opts: { fetchOpts?: RequestInit; retry?: number; cacheMode?: 'normal' | 'force' | 'reload' | 'no-store'; signal?: AbortSignal; scope?: AsyncDisposableStack } = {}
): Promise<{ url: string; content: Uint8Array; contentType: string | null }> {
  const { fetchOpts, retry, cacheMode = 'normal', signal, scope } = opts;
  
  try {
    const result = await fetchContent(url, {
      init: fetchOpts,
      retries: retry,
      cacheMode,
      signal,
      scope,
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
    const scope = fromContext("scope", StateContext);
    const { content: asset, url } = await fetchPkg(urlJoin(parentURL, assetURL), { signal: abort.signal, scope });

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

/**
 * Path suffixes used for package-root probing when a URL is extensionless.
 *
 * `""` tries the path as-is first.
 * `"/index"` is the Node/CommonJS-style directory fallback used for package roots.
 *
 * Example for `https://unpkg.com/pkg@1.0.0`:
 * - `""`      -> `https://unpkg.com/pkg@1.0.0`
 * - `"/index"` -> `https://unpkg.com/pkg@1.0.0/index`
 */
export const FilePaths = ["", "/index"];

/**
 * File suffixes used only for implicit package-entry probing.
 *
 * This intentionally models the part of Node's CommonJS `require()` fallback
 * that bundlejs can safely emulate here: `index.js` and `index.json`.
 *
 * Not included on purpose:
 * - `.node`: Node supports it for native addons, but bundlejs cannot load it
 * - `.cjs` / `.mjs`: supported only when explicit, not as automatic fallback
 */
export const FileEndings = ["", ...PACKAGE_ENTRY_RESOLVE_EXTENSIONS];

/**
 * Cross-product of package-root path variants and entry extensions.
 *
 * This is intentionally used only when the input URL is acting like an
 * extensionless package entry candidate. It must not be applied blindly to
 * URLs that already name a concrete file such as `style.module.css` or
 * `dist/index.js`, otherwise we would incorrectly probe paths like
 * `style.module.css/index.js`.
 */
export const AllEndingVariants = Array.from(
  new Set(
    FilePaths.flatMap(path => FileEndings.map(ext => path + ext))
  )
);

export const EndingVariantsLength = AllEndingVariants.length;

/**
 * Determine whether a URL already names a concrete file with a recognized
 * extension, and therefore should be fetched exactly as-is.
 *
 * Why this exists:
 * - `determineExtension()` is used for both package-root entry probing and
 *   ordinary HTTP file loads.
 * - Extensionless package roots such as `https://unpkg.com/spdx-exceptions@2.5.0`
 *   should broaden into `index.js` and `index.json`.
 * - Explicit files such as `.../index.js`, `.../styles.module.css`, or
 *   `.../data.json` should stay exact and must not broaden into nested
 *   `index.*` or additional extension probes.
 *
 * Behavior:
 * - Known extensions (`.js`, `.mjs`, `.cjs`, `.json`, `.css`, `.wasm`, `.node`, etc.)
 *   return `true` and are fetched exactly.
 * - Unknown suffix-style names such as `Expo.fx` or `uuid.types` return `false`
 *   so the caller can still probe `Expo.fx.ts`, `uuid.types.ts`, and similar
 *   conventions used by some ecosystems.
 */
export function hasRecognizedExplicitExtension(path: string): boolean {
  const pathname = new URL(path).pathname;
  const currentExt = extname(pathname);

  return currentExt.length > 0 && _knownExtensions.includes(currentExt.slice(1));
}

/**
 * Choose the suffix probe list for an HTTP URL.
 *
 * Mechanism:
 * - If the URL already points at a recognized concrete file, only try `""`
 *   so the fetch stays exact.
 * - Otherwise, use the broader package-entry probe list so extensionless or
 *   suffix-style paths can resolve.
 *
 * This keeps package-root fallback and suffix-style imports working without
 * over-broadening explicit files.
 */
export function getEndingVariants(path: string): string[] {
  if (hasRecognizedExplicitExtension(path)) {
    return [""];
  }

  return AllEndingVariants;
}

/**
 * Resolve a fetchable HTTP URL from an extensionless or suffix-style candidate.
 *
 * What this is trying to accomplish:
 * - Support package roots that omit `main`/`exports` and rely on implicit
 *   `index.*` files.
 * - Support suffix-style specifiers used by some packages, such as `Expo.fx`
 *   resolving to `Expo.fx.ts`.
 * - Avoid broadening URLs that already name a concrete file.
 *
 * Mechanism:
 * - Ask `getEndingVariants()` for the correct probe list.
 * - Try the exact URL first.
 * - If the path is extensionless or uses an unrecognized suffix, try a bounded
 *   set of package-entry fallbacks.
 * - Stop at the first successful HEAD/GET probe.
 *
 * Why the split with `getEndingVariants()` matters:
 * - A URL like `.../spdx-exceptions@2.5.0` must be allowed to fan out into
 *   `.../index.js` and `.../index.json`.
 * - A URL like `.../styles.module.css` must stay exact.
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
  const scope = StateContext ? fromContext("scope", StateContext) : undefined;

  let firstError: Error | undefined;
  const endingVariants = getEndingVariants(path);
  const endingVariantsLength = endingVariants.length;

  for (let i = 0; i < endingVariantsLength; i++) {
    const suffix = endingVariants[i];
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
        const { url, contentType, content } = await fetchPkg(testUrl, { cacheMode: 'normal', signal: abort?.signal, scope });
        return { url, contentType, content };
      }
    } catch (e) {
      failedSet.add(testUrl);
      
      // Keep the first error as it's usually most accurate
      if (i === 0) firstError = e as Error;

      // If we've exhausted all variants, throw
      if (i >= endingVariantsLength - 1) {
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

  return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
    const argPath = args.path;

    // Non-relative imports
    if (!argPath.startsWith(".") && !isAbsolute(argPath)) {
      // Direct HTTP URL — route to HTTP namespace.
      // sideEffects enrichment is handled by PackagePlugin when
      // package context exists in pluginData.
      if (/^https?:\/\//.test(argPath)) {
        return {
          path: argPath,
          namespace: HTTP_NAMESPACE,
          pluginData: args.pluginData,
        };
      }

      // Determine origin for CDN-follows-parent behavior:
      // when a file is loaded from esm.sh, its bare imports should
      // also resolve through esm.sh (not the configured CDN).
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

      // Bare import (e.g., "lodash") → delegate through build.resolve()
      // so CdnPlugin handles resolution with the correct CDN origin.
      // Also handle private imports (#internal) and JSR spec imports.
      //
      // The cdnOrigin is passed in pluginData so CdnPlugin can use
      // the parent file's CDN rather than the configured default.
      // This preserves the CDN-follows-parent behavior that was
      // previously achieved by calling CdnResolution() directly
      // with a context override.
      if (/^#/.test(argPath) || isBareImport(argPath) || looksLikeJSRSpec(argPath)) {
        return await build.resolve(argPath, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: Object.assign({}, args.pluginData, {
            cdnOrigin: origin,
          }),
        });
      }

      // Absolute import (e.g., "/lib/foo") → resolve against CDN origin.
      // sideEffects enrichment is handled by PackagePlugin.
      return {
        path: getCDNUrl(argPath, origin).url.toString(),
        namespace: HTTP_NAMESPACE,
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
    // Manifest field remapping + sideEffects computation are now handled by
    // PackagePlugin (registered before HttpPlugin). It intercepts relative
    // imports that have package context (pluginData.packageBaseUrl + manifest)
    // and returns an enriched result with remapped paths and accurate
    // sideEffects hints.
    //
    // This handler only fires for relative imports that:
    //   a) Have no package context (direct URL fetches, non-package origins)
    //   b) Fall outside the package base URL (escaping the package tree)
    //
    // In both cases, no remapping or sideEffects enrichment is applicable.
    // ========================================================================

    return {
      path: resolvedPath,
      namespace: HTTP_NAMESPACE,
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

  return {
    name: HTTP_NAMESPACE,
    setup(build) {
      const ctx = withContext({ build: Context.opaque(build) }, StateContext);

      // Route HTTP/HTTPS URLs to this plugin.
      // sideEffects enrichment is handled by PackagePlugin when
      // package context exists — this handler is a pure router.
      build.onResolve({ filter: /^https?:\/\// }, args => ({
        path: args.path,
        namespace: HTTP_NAMESPACE,
        pluginData: args.pluginData,
      }));

      // Route all imports within HTTP namespace through HttpResolution
      build.onResolve({ filter: /.*/, namespace: HTTP_NAMESPACE }, HttpResolution(ctx));

      // ────────────────────────────────────────────────────────────
      // NOTE: No onLoad handler here.
      //
      // All HTTP content loading (fetching, extension probing,
      // asset discovery, Flow type stripping, loader inference)
      // is handled by PackagePlugin, which is registered before
      // this plugin and owns onLoad for the http-url namespace.
      // ────────────────────────────────────────────────────────────
    },
  };
}