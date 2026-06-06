/**
 * Common response headers shared across runtimes.
 *
 * We keep this centralized to avoid subtle drift between Deno Deploy and
 * Cloudflare Workers responses (especially CORS-related behavior).
 */
export const headers = Object.entries({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET"
});

/**
 * Prefix for "permanent" (non-TTL) single-package cache entries.
 *
 * This mirrors the Deno Deploy Redis key layout so Workers can implement the
 * same behavior using KV.
 */
export const PACKAGE_PREFIX = "json-package";

/**
 * Compute the per-package cache namespace for a fully resolved module name.
 *
 * `moduleName` typically includes the pinned version and any subpath.
 */
export function getPackageResultKey(moduleName: string): string {
  return `${PACKAGE_PREFIX}/${moduleName}`;
}
