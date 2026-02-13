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
export const DEFAULT_RETRIES = 1;

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
  /**
   * Abort signal scoped to the build's lifetime.
   *
   * When provided, background stale-while-revalidate refreshes carry this
   * signal so they are cancelled when the build finishes.  This prevents
   * Deno's test-runner sanitizer from detecting leaked `fetchCancelHandle`
   * or `op_cache_put` resources.
   *
   * The signal is **only** applied to background refreshes — primary
   * (awaited) fetches are not affected, so in-progress builds won't be
   * interrupted.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   */
  signal?: AbortSignal;
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
// In-flight request deduplication
// ============================================================================

/**
 * Capacity for the in-flight request deduplication map.
 *
 * Limits memory when many unique URLs are fetched concurrently.
 * Once full, the oldest entry is evicted (LRU) so a duplicate request
 * will simply start a fresh fetch — correctness is preserved, only the
 * dedup optimisation is lost.
 */
export const INFLIGHT_CAPACITY = 200;

/**
 * Maps a URL to its **in-progress** network fetch promise.
 *
 * When two callers request the same URL before the first fetch settles,
 * the second caller joins the existing promise instead of issuing a
 * duplicate HTTP request.  The entry is removed as soon as the promise
 * settles so subsequent requests go to the normal cache-or-fetch path.
 *
 * This also bounds the number of concurrent fire-and-forget
 * `backgroundRefresh` calls: if a background refresh for URL X is already
 * in progress, the next stale-while-revalidate hit simply joins the
 * existing refresh rather than spawning a second one.
 */
export const inflight = new LruCache<string, Promise<Response>>(INFLIGHT_CAPACITY);

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
  cacheApi?: Cache,
  signal?: AbortSignal,
): Promise<void> {
  // Only cache successful GET responses
  // Note: response.ok is false for 3xx, but fetch with redirect:'follow' 
  // resolves with the final 2xx response, so we're caching the final response
  if (!response.ok) {
    // Cancel unconsumed body to prevent resource leak
    await response.body?.cancel();
    return;
  }

  // If the build finished (signal aborted) between fetch-complete and
  // cache-write, skip the write to avoid starting an `op_cache_put` that
  // would outlive the caller.
  if (signal?.aborted) {
    await response.body?.cancel();
    return;
  }

  try {
    if (SUPPORTS_CACHE_API && cacheApi) {
      // Cache API: store under final URL
      await cacheApi.put(new Request(finalUrl), response);
    } else {
      // In-memory fallback: store under final URL
      responseCache.set(finalUrl, response);
    }
    
    // Track redirect mapping if URLs differ
    if (originalUrl !== finalUrl) {
      redirectMap.set(originalUrl, finalUrl);
    }
  } catch (err) {
    // Swallow errors that occur because the signal fired mid-write
    if (signal?.aborted) return;
    console.error(`[cache] Failed to store response for ${finalUrl}:`, err);
  }
}

/**
 * Performs the actual network fetch with retry logic.
 */
function doFetch(
  url: string,
  init: RequestInit = {},
  _retries: number
): Promise<Response> {
  const fetchWithRedirect = async () => {
    const response = await fetch(url, {
      redirect: "follow",
      ...init,
    });
    
    if (!response.ok) {
      // Cancel the body before throwing — prevents leaked response streams
      // when the caller never reads the body of a failed request.
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
    }
    
    return response;
  };

  // TODO: re-enable retry logic
  // if (_retries > 0) {
  //   return retry(fetchWithRedirect, { maxAttempts: _retries + 1 });
  // }
  
  return fetchWithRedirect();
}

/**
 * Background refresh with smart fallback for stale-while-revalidate.
 * 
 * Tries the original URL first to discover version updates (e.g., @latest → @4.17.22).
 * Falls back to the final URL if original returns 404 (e.g., extensionless URLs).
 * 
 * This handles two cases:
 * 1. Version aliases (@latest): original URL works, may resolve to newer version
 * 2. Extension probing (dbcs-codec → dbcs-codec.js): original 404s, use final URL
 */
async function backgroundRefresh(
  originalUrl: string,
  finalUrl: string,
  init: RequestInit,
  retries: number,
  cacheApi?: Cache
): Promise<void> {
  // Bail early if already aborted (e.g. build finished before refresh started)
  if (init.signal?.aborted) return;

  try {
    // Try original URL first — this allows version discovery for @latest etc.
    const response = await doFetch(originalUrl, init, retries);

    // Check abort *after* fetch completes but *before* the cache write.
    // Avoids starting an `op_cache_put` that would outlive the caller.
    if (init.signal?.aborted) {
      await response.body?.cancel();
      return;
    }

    const resolvedUrl = response.url || originalUrl;
    await storeInCache(originalUrl, resolvedUrl, response, cacheApi, init.signal ?? undefined);
  } catch (err) {
    // Silently swallow abort errors — expected during build cleanup
    if (err instanceof DOMException && err.name === "AbortError") return;
    if (init.signal?.aborted) return;

    // If original URL failed with 404 and we have a different final URL,
    // try the final URL (handles extension probing case)
    const is404 = err instanceof Error && err.message.includes("404");

    if (is404 && originalUrl !== finalUrl) {
      try {
        if (init.signal?.aborted) return;

        const response = await doFetch(finalUrl, init, retries);

        if (init.signal?.aborted) {
          await response.body?.cancel();
          return;
        }

        const resolvedUrl = response.url || finalUrl;
        await storeInCache(finalUrl, resolvedUrl, response, cacheApi, init.signal ?? undefined);
      } catch (fallbackErr) {
        if (fallbackErr instanceof DOMException && fallbackErr.name === "AbortError") return;
        if (init.signal?.aborted) return;

        // Both failed — log but don't throw (background operation)
        console.error(`[cache] Background refresh failed for ${finalUrl}:`, fallbackErr);
      }
    } else {
      // Not a 404 or no fallback available — log the original error
      console.error(`[cache] Background refresh failed for ${originalUrl}:`, err);
    }
  }
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

  // Only cache GET requests (not HEAD, POST, etc.)
  const method = init.method?.toUpperCase() ?? 'GET';
  const canCache = method === 'GET' && cacheMode !== 'no-store';
  
  const cacheApi = SUPPORTS_CACHE_API ? await openCache() : undefined;

  // Check cache first (unless reload mode)
  if (canCache && cacheMode !== 'reload') {
    const cached = await lookupCache(url, cacheApi);
    
    if (cached) {
      const finalUrl = resolveRedirect(url);
      
      // Stale-while-revalidate: return cached, refresh in background.
      //
      // When an AbortSignal is provided (per-build lifecycle), the signal
      // is threaded into the background fetch so it is cancelled when the
      // build finishes — preventing Deno's sanitizer from detecting
      // leaked `fetchCancelHandle` / `op_cache_put` resources.
      //
      // When no signal is provided, the refresh is plain fire-and-forget
      // — fine for standalone / REPL usage where leak detection isn't a
      // concern.
      if (cacheMode === 'normal') {
        const refreshInit: RequestInit = options.signal
          ? { ...init, signal: options.signal }
          : init;
        void backgroundRefresh(url, finalUrl, refreshInit, retries, cacheApi);
      }

      // Clone response if requested (Cache API responses can be reused, but in-memory ones cannot)
      const isMemory = !cacheApi;
      const returnResponse =
        isMemory ? cached.clone() : (clone ? cached.clone() : cached);

      return {
        url: finalUrl,
        response: returnResponse,
        fromCache: true,
        redirected: url !== finalUrl,
      };
    }
  }

  // -----------------------------------------------------------------
  // Network fetch with request deduplication
  // -----------------------------------------------------------------
  // If another caller is already fetching the same URL, join that
  // promise instead of issuing a duplicate HTTP request.
  // When the shared fetch settles we read the result from cache so
  // every caller gets its own clone and the response body isn't
  // consumed twice.
  // -----------------------------------------------------------------

  const existing = inflight.get(url);
  if (existing) {
    // Join the in-flight request, then read the result from cache.
    try { await existing; } catch { /* original caller handles the error */ }

    const deduped = await lookupCache(url, cacheApi);
    if (deduped) {
      const finalUrl = resolveRedirect(url);
      return {
        url: finalUrl,
        response: deduped.clone(),
        fromCache: true,
        redirected: url !== finalUrl,
      };
    }
    // Cache miss after dedup — fall through to a fresh fetch below.
  }

  // Start the authoritative fetch and register it in the inflight map
  // so concurrent callers can join.
  const fetchPromise = doFetch(url, init, retries);
  inflight.set(url, fetchPromise);

  let response: Response;
  try {
    response = await fetchPromise;
  } finally {
    inflight.delete(url);
  }

  const finalUrl = response.url || url;
  const redirected = response.redirected || url !== finalUrl;
  
  // Make ONE clone for cache (because cache.put consumes the body)
  if (canCache) {
    // Pass the clone into caching, so storeInCache DOES NOT clone again.
    await storeInCache(url, finalUrl, response.clone(), cacheApi);
  }

  // Return the original response.
  // This keeps exactly two branches total: (1) cache clone, (2) original return.
  return {
    url: finalUrl,
    response,
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
  const { init = {}, retries = 0, cacheMode = 'normal', signal } = options;
  
  // Try HEAD first
  try {
    const { url: finalUrl, response, fromCache } = await fetchWithCache(url, {
      init: { ...init, method: 'HEAD' },
      retries: 0,
      clone: false,
      cacheMode,
      signal,
    });
    
    const contentType = response.headers.get("content-type");
    
    return { url: finalUrl, contentType, fromCache };
  } catch (_) {
    // HEAD failed, try GET with immediate body cancellation
    const { url: finalUrl, response, fromCache } = await fetchWithCache(url, {
      init: { ...init, method: 'GET' },
      retries,
      clone: false,
      cacheMode: 'no-store', // Don't cache partial responses
      signal,
    });
    
    const contentType = response.headers.get("content-type");
    
    // Cancel body immediately - we only wanted headers
    try { void response.body?.cancel(); } catch { /* ignore cancel errors */ }

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
  inflight.clear();
  
  if (SUPPORTS_CACHE_API) {
    try {
      await caches.delete(CACHE_NAME);
    } catch (e) { console.error(e) }
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
  inflight.delete(url);
  
  if (SUPPORTS_CACHE_API) {
    try {
      const cache = await openCache();
      await cache.delete(finalUrl);
    } catch (e) { console.error(e) }
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
  opts: { cacheMode?: FetchOptions['cacheMode']; retry?: number; fetchOpts?: RequestInit } = {}
): Promise<Response> {
  const urlString = url.toString();
  
  const { response } = await fetchWithCache(urlString, {
    init: opts.fetchOpts,
    retries: opts.retry,
    cacheMode: opts.cacheMode,
  });
  
  return response;
}