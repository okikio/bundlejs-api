import { retry } from "./async.ts";
import { LruCache } from "./lru.ts";

/**
 * Fetch-and-cache module with proper redirect handling.
 * 
 * **Key design decision**: Always cache under the *final* URL (`response.url`), 
 * not the original request URL. This ensures:
 * 
 * 1. Relative imports resolve correctly (bundlers need the final URL as base)
 * 2. No stale redirect targets when CDN aliases like `@latest` change
 * 3. Direct requests to final URLs hit cache
 * 
 * For efficiency, we also maintain a redirect map so requests to aliased URLs
 * can find cached content without re-fetching.
 * 
 * @example How Redirects Now Work
 * ```
 * Request: https://esm.sh/lodash@latest
 *          ↓
 * fetch-and-cache: fetch with redirect:'follow'
 *          ↓
 * Response.url: https://esm.sh/lodash@4.17.21
 *          ↓
 * Cache: stores under final URL + records redirect mapping
 *          ↓
 * http.ts: receives { url: "https://esm.sh/lodash@4.17.21", content, ... }
 *          ↓
 * pluginData.url = final URL
 *          ↓
 * Relative import "./debounce" resolves against final URL ✓
 * ```
 */

// ============================================================================
// Configuration
// ============================================================================

/** LRU cache capacity for responses */
export const CACHE_CAPACITY = 300;

/** LRU cache capacity for redirect mappings */
export const REDIRECT_MAP_CAPACITY = 500;

/** Default retry attempts for failed requests */
export const DEFAULT_RETRIES = 2;

// ============================================================================
// Caches
// ============================================================================

/** In-memory LRU cache for responses, keyed by final URL */
export const responseCache = new LruCache<string, Response>(CACHE_CAPACITY);

/** 
 * Maps original URLs to their final redirect targets.
 * Enables cache hits when requesting aliased URLs (e.g., `lodash@latest` → `lodash@4.17.21`)
 */
export const redirectMap = new LruCache<string, string>(REDIRECT_MAP_CAPACITY);

/** Cache API storage name */
export const CACHE_NAME = "EXTERNAL_FETCHES";

/** Feature detection */
export const SUPPORTS_CACHE_API = "caches" in globalThis;
export const SUPPORTS_REQUEST_API = "Request" in globalThis;

// ============================================================================
// Types
// ============================================================================

export interface FetchResult {
  /** The final URL after any redirects */
  url: string;
  /** The response (cloned if requested) */
  response: Response;
  /** Whether this came from cache */
  fromCache: boolean;
  /** Whether a redirect occurred */
  redirected: boolean;
}

export interface FetchOptions {
  /** Additional fetch options (headers, method, etc.) */
  init?: RequestInit;
  /** Number of retry attempts on failure. Default: 2 */
  retries?: number;
  /** Whether to clone the response before returning. Default: true */
  clone?: boolean;
  /** 
   * Cache behavior:
   * - 'normal': Use cache, update in background (stale-while-revalidate)
   * - 'force': Always use cache if available, never revalidate
   * - 'reload': Bypass cache, fetch fresh, update cache
   * - 'no-store': Bypass cache entirely, don't store response
   * Default: 'normal'
   */
  cacheMode?: 'normal' | 'force' | 'reload' | 'no-store';
}

// ============================================================================
// Cache API wrapper
// ============================================================================

let openCachePromise: Promise<Cache> | null = null;

/**
 * Opens the Cache API storage (singleton pattern)
 */
export function openCache(): Promise<Cache> {
  if (!SUPPORTS_CACHE_API) {
    throw new Error("Cache API not supported in this environment");
  }
  if (!openCachePromise) {
    openCachePromise = caches.open(CACHE_NAME);
  }
  return openCachePromise;
}

// ============================================================================
// Core fetch implementation
// ============================================================================

/**
 * Resolves a URL through the redirect map to find the final cached URL.
 * Returns the original URL if no redirect mapping exists.
 */
function resolveRedirect(url: string): string {
  return redirectMap.get(url) ?? url;
}

/**
 * Looks up a URL in cache, checking both the direct URL and any redirect mappings.
 */
async function lookupCache(url: string, cacheApi?: Cache): Promise<Response | undefined> {
  const finalUrl = resolveRedirect(url);
  
  if (SUPPORTS_CACHE_API && cacheApi) {
    const cached = await cacheApi.match(finalUrl);
    if (cached) return cached;
  }
  
  return responseCache.get(finalUrl);
}

/**
 * Stores a response in cache under the final URL.
 * If a redirect occurred, also stores the mapping from original → final URL.
 */
async function storeInCache(
  originalUrl: string,
  finalUrl: string,
  response: Response,
  cacheApi?: Cache
): Promise<void> {
  // Only cache successful GET responses
  // Note: response.ok is false for 3xx, but fetch with redirect:'follow' 
  // resolves with the final 2xx response, so we're caching the final response
  if (!response.ok) return;

  try {
    const cloned = response.clone();
    
    if (SUPPORTS_CACHE_API && cacheApi) {
      // Cache API: store under final URL
      await cacheApi.put(new Request(finalUrl), cloned);
    } else {
      // In-memory fallback: store under final URL
      responseCache.set(finalUrl, cloned);
    }
    
    // Track redirect mapping if URLs differ
    if (originalUrl !== finalUrl) {
      redirectMap.set(originalUrl, finalUrl);
    }
  } catch (err) {
    console.error(`[cache] Failed to store response for ${finalUrl}:`, err);
  }
}

/**
 * Performs the actual network fetch with retry logic.
 */
function doFetch(
  url: string,
  init: RequestInit = {},
  retries: number
): Promise<Response> {
  const fetchWithRedirect = async () => {
    const response = await fetch(url, {
      redirect: "follow",
      ...init,
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
    }
    
    return response;
  };

  if (retries > 0) {
    return retry(fetchWithRedirect, { maxAttempts: retries + 1 });
  }
  
  return fetchWithRedirect();
}

/**
 * Main fetch function with caching and proper redirect handling.
 * 
 * **Important**: The returned `url` is the *final* URL after redirects.
 * Use this for resolving relative imports in fetched content.
 * 
 * @example
 * ```ts
 * // Basic usage
 * const { url, response } = await fetchWithCache('https://esm.sh/lodash@latest');
 * // url is now 'https://esm.sh/lodash@4.17.21' (the final URL)
 * 
 * // The final URL is critical for relative imports:
 * // If lodash/index.js imports './debounce', resolve against the final URL
 * const debounceUrl = new URL('./debounce', url).toString();
 * ```
 */
export async function fetchWithCache(
  url: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const {
    init = {},
    retries = DEFAULT_RETRIES,
    clone = true,
    cacheMode = 'normal',
  } = options;

  // Only cache GET requests
  const method = init.method?.toUpperCase() ?? 'GET';
  const canCache = method === 'GET' && cacheMode !== 'no-store';
  
  const cacheApi = SUPPORTS_CACHE_API ? await openCache() : undefined;

  // Check cache first (unless reload mode)
  if (canCache && cacheMode !== 'reload') {
    const cached = await lookupCache(url, cacheApi);
    
    if (cached) {
      const finalUrl = resolveRedirect(url);
      
      // Stale-while-revalidate: return cached, refresh in background
      if (cacheMode === 'normal') {
        doFetch(url, init, retries)
          .then(response => storeInCache(url, response.url || url, response, cacheApi))
          .catch(err => console.error(`[cache] Background refresh failed for ${url}:`, err));
      }
      
      return {
        url: finalUrl,
        response: clone ? cached.clone() : cached,
        fromCache: true,
        redirected: url !== finalUrl,
      };
    }
  }

  // Fetch from network
  const response = await doFetch(url, init, retries);
  const finalUrl = response.url || url;
  const redirected = response.redirected || url !== finalUrl;
  
  // Store in cache
  if (canCache) {
    await storeInCache(url, finalUrl, response, cacheApi);
  }

  return {
    url: finalUrl,
    response: clone ? response.clone() : response,
    fromCache: false,
    redirected,
  };
}

// ============================================================================
// Convenience functions
// ============================================================================

/**
 * Fetches content and returns it as a Uint8Array along with metadata.
 * This is the most common pattern for bundlers.
 */
export async function fetchContent(
  url: string,
  options: FetchOptions = {}
): Promise<{
  url: string;
  content: Uint8Array;
  contentType: string | null;
  fromCache: boolean;
  redirected: boolean;
}> {
  const { url: finalUrl, response, fromCache, redirected } = await fetchWithCache(url, options);
  const contentType = response.headers.get("content-type");
  const content = new Uint8Array(await response.arrayBuffer());
  
  return { url: finalUrl, content, contentType, fromCache, redirected };
}

/**
 * Fetches only headers (useful for probing URLs without downloading content).
 * Uses HEAD request with GET fallback for servers that don't support HEAD.
 */
export async function fetchHeaders(
  url: string,
  options: Omit<FetchOptions, 'clone'> = {}
): Promise<{
  url: string;
  contentType: string | null;
  fromCache: boolean;
}> {
  const { init = {}, retries = 0, cacheMode = 'normal' } = options;
  
  // Try HEAD first
  try {
    const { url: finalUrl, response, fromCache } = await fetchWithCache(url, {
      init: { ...init, method: 'HEAD' },
      retries: 0,
      clone: false,
      cacheMode,
    });
    
    // Cancel the body if any (shouldn't be one for HEAD, but defensive)
    try { await response.body?.cancel(); } catch { /* ignore */ }
    
    const contentType = response.headers.get("content-type");
    
    return { url: finalUrl, contentType, fromCache };
  } catch (_) {
    // HEAD failed, try GET with immediate body cancellation
    const { url: finalUrl, response, fromCache } = await fetchWithCache(url, {
      init: { ...init, method: 'GET' },
      retries,
      clone: false,
      cacheMode: 'no-store', // Don't cache partial responses
    });
    
    // Cancel body immediately - we only wanted headers
    try { await response.body?.cancel(); } catch { /* ignore */ }
    
    const contentType = response.headers.get("content-type");
    if (contentType && /text\/html/i.test(contentType)) {
      throw new Error(`Received HTML instead of expected content for ${finalUrl}`);
    }
    
    return { url: finalUrl, contentType, fromCache };
  }
}

// ============================================================================
// Cache management
// ============================================================================

/**
 * Clears all cached data (both in-memory and Cache API)
 */
export async function clearCache(): Promise<void> {
  responseCache.clear();
  redirectMap.clear();
  
  if (SUPPORTS_CACHE_API) {
    await caches.delete(CACHE_NAME);
    openCachePromise = null;
  }
}

/**
 * Removes a specific URL from cache (both original and final URL mappings)
 */
export async function invalidate(url: string): Promise<void> {
  const finalUrl = resolveRedirect(url);
  
  responseCache.delete(finalUrl);
  redirectMap.delete(url);
  
  if (SUPPORTS_CACHE_API) {
    const cache = await openCache();
    await cache.delete(finalUrl);
  }
}

// ============================================================================
// Legacy API compatibility (deprecated, use new functions)
// ============================================================================

/**
 * @deprecated Use `fetchWithCache` instead
 */
export async function getRequest(
  url: RequestInfo | URL,
  opts: { permanent?: boolean; retry?: number; fetchOpts?: RequestInit } = {}
): Promise<Response> {
  const urlString = url.toString();
  const cacheMode = opts.permanent ? 'force' : 'normal';
  
  const { response } = await fetchWithCache(urlString, {
    init: opts.fetchOpts,
    retries: opts.retry,
    cacheMode,
  });
  
  return response;
}

/**
 * @deprecated Use `fetchContent` instead
 */
export async function newRequest(
  request: RequestInfo,
  opts: { retry?: number; cache?: Cache; fetchOpts?: RequestInit; clone?: boolean } = {}
): Promise<Response | null> {
  const url = SUPPORTS_REQUEST_API && request instanceof Request 
    ? request.url 
    : request.toString();
  
  const { response } = await fetchWithCache(url, {
    init: opts.fetchOpts,
    retries: opts.retry,
    clone: opts.clone ?? true,
  });
  
  return response;
}