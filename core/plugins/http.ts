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
import type { Context } from "../context/context.ts";
import type { CdnResolutionState } from "./cdn.ts";

import { fromContext, toContext } from "../context/context.ts";
import { CdnResolution } from "./cdn.ts";

import { fetchContent, fetchHeaders } from "@bundle/utils/fetch-and-cache";
import { decode } from "@bundle/utils/encode-decode";

import { LOGGER_ERROR, LOGGER_INFO, LOGGER_WARN, dispatchEvent } from "../configs/events.ts";

import { DEFAULT_CDN_HOST, getCDNStyle, getCDNUrl } from "../utils/cdn-format.ts";
import { inferLoader } from "../utils/loader.ts";
import { setFile } from "../utils/filesystem.ts";

import { isBareImport, isAbsolute } from "@bundle/utils/path";
import { toURLPath, urlJoin } from "@bundle/utils/url";

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
  opts: { fetchOpts?: RequestInit; retry?: number } = {}
): Promise<{ url: string; content: Uint8Array; contentType: string | null }> {
  const { fetchOpts, retry } = opts;
  
  try {
    const result = await fetchContent(url, {
      init: fetchOpts,
      retries: retry,
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
  opts: { retry?: number } = {}
): Promise<{ url: string; contentType: string | null }> {
  try {
    const result = await fetchHeaders(url, { retries: opts.retry });
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
    const { content: asset, url } = await fetchPkg(urlJoin(parentURL, assetURL));

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

  let firstError: Error | undefined;

  for (let i = 0; i < EndingVariantsLength; i++) {
    const suffix = AllEndingVariants[i];
    const testUrl = path + suffix;

    // Skip URLs we've already tried and failed
    if (failedSet.has(testUrl)) continue;

    try {
      if (headersOnly) {
        const { url, contentType } = await fetchPkgHeaders(testUrl);
        return { url, contentType };
      } else {
        const { url, contentType, content } = await fetchPkg(testUrl);
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

  return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
    const argPath = args.path;

    // Non-relative imports
    if (!argPath.startsWith(".") && !isAbsolute(argPath)) {
      // Direct HTTP URL
      if (/^https?:\/\//.test(argPath)) {
        return {
          path: argPath,
          namespace: HTTP_NAMESPACE,
          sideEffects: args.pluginData?.manifest?.sideEffects,
          pluginData: args.pluginData,
        };
      }

      // Determine origin for resolution
      const pathOrigin = new URL(
        urlJoin(args.pluginData?.url ?? host, "../", argPath)
      ).origin;

      const NPM_CDN = getCDNStyle(pathOrigin) === "npm";
      const origin = NPM_CDN ? pathOrigin : host;

      // Bare import (e.g., "lodash") → delegate to CDN resolution
      if (isBareImport(argPath)) {
        const ctx = StateContext.with({ build }) as Context<CdnResolutionState<T>>;
        return await CdnResolution(ctx)(args);
      }

      // Absolute import (e.g., "/lib/foo") → resolve against CDN origin
      return {
        path: getCDNUrl(argPath, origin).url.toString(),
        namespace: HTTP_NAMESPACE,
        sideEffects: args.pluginData?.manifest?.sideEffects,
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

    return {
      path: resolvedPath,
      namespace: HTTP_NAMESPACE,
      sideEffects: args.pluginData?.manifest?.sideEffects,
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
      const ctx = StateContext.with({ build }) as Context<HttpResolutionState<T>>;

      // Route HTTP/HTTPS URLs to this plugin
      build.onResolve({ filter: /^https?:\/\// }, args => ({
        path: args.path,
        namespace: HTTP_NAMESPACE,
        sideEffects: args.pluginData?.manifest?.sideEffects,
        pluginData: args.pluginData,
      }));

      // Route all imports within HTTP namespace through HttpResolution
      build.onResolve({ filter: /.*/, namespace: HTTP_NAMESPACE }, HttpResolution(ctx));

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

        return {
          contents: content,
          loader: inferLoader(url, contentType),
          // CRITICAL: Pass the final URL (after redirects) in pluginData
          // This is used as the base URL for resolving relative imports
          pluginData: { ...args.pluginData, url },
        };
      });
    },
  };
}