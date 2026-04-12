/**
 * Cache Operations
 *
 * High-level cache operations with automatic error handling and
 * graceful degradation. All operations return null/undefined on failure
 * rather than throwing, to ensure cache failures don't break the main flow.
 *
 * @module
 */
import type { BundleResult } from '../bundle/types.ts'

import JSON5 from '@bundle/utils/json5'

import { withCacheFallback } from './client.ts'

// =============================================================================
// Constants
// =============================================================================

/** Default TTL for cached results (24 hours in seconds) */
const DEFAULT_TTL_SECONDS = 86400

/** Default TTL for badge hashes (1 hour in seconds) */
const BADGE_TTL_SECONDS = 3600

// =============================================================================
// JSON Result Operations
// =============================================================================

/**
 * Get a cached bundle result.
 *
 * @param key - Cache key (from generateCacheKey)
 * @returns Cached result or null if not found/error
 *
 * @example
 * ```ts
 * const cached = await getCachedResult('json/abc123')
 * if (cached) {
 *   // Use cached result
 * } else {
 *   // Execute bundle
 * }
 * ```
 */
export async function getCachedResult(key: string): Promise<BundleResult | null> {
	return withCacheFallback(async (redis) => {
		const value = await redis.get<string>(key)
		if (!value) return null

		try {
			return JSON5.parse<BundleResult>(value)
		} catch {
			console.warn('[Cache] Failed to parse cached result for key:', key)
			return null
		}
	})
}

/**
 * Store a bundle result in cache.
 *
 * @param key - Cache key
 * @param result - Bundle result to cache
 * @param ttlSeconds - TTL in seconds (default: 24 hours)
 * @returns true if stored successfully, false otherwise
 *
 * @example
 * ```ts
 * await setCachedResult('json/abc123', bundleResult)
 * ```
 */
export async function setCachedResult(
	key: string,
	result: BundleResult,
	ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<boolean> {
	const success = await withCacheFallback(async (redis) => {
		const serialized = JSON5.stringify(result)
		await redis.set(key, serialized, { ex: ttlSeconds })
		return true
	})

	return success ?? false
}

/**
 * Delete a cached result.
 *
 * @param key - Cache key to delete
 * @returns true if deleted, false otherwise
 */
export async function deleteCachedResult(key: string): Promise<boolean> {
	const success = await withCacheFallback(async (redis) => {
		await redis.del(key)
		return true
	})

	return success ?? false
}

/**
 * Delete multiple cached results.
 *
 * @param keys - Array of cache keys to delete
 * @returns Number of keys deleted, or 0 on error
 */
export async function deleteCachedResults(...keys: string[]): Promise<number> {
	const count = await withCacheFallback(async (redis) => {
		return await redis.del(...keys)
	})

	return count ?? 0
}

// =============================================================================
// Package Result Operations
// =============================================================================

/**
 * Store a package-specific result in permanent cache.
 *
 * Package results don't expire - they persist until explicitly deleted.
 * Used for simple "export all" bundles that are unlikely to change.
 *
 * @param key - Package result key (from getPackageResultKey)
 * @param result - Bundle result to cache
 * @returns true if stored successfully
 */
export async function setPackageResult(key: string, result: BundleResult): Promise<boolean> {
	const success = await withCacheFallback(async (redis) => {
		const serialized = JSON5.stringify(result)
		// No TTL for package results - they persist permanently
		await redis.set(key, serialized)
		return true
	})

	return success ?? false
}

/**
 * Get a package-specific cached result.
 *
 * @param key - Package result key
 * @returns Cached result or null
 */
export async function getPackageResult(key: string): Promise<BundleResult | null> {
	return getCachedResult(key) // Same logic, just different key pattern
}

// =============================================================================
// Badge Operations
// =============================================================================

/**
 * Get a cached badge.
 *
 * Badges are stored in a hash with the badge ID as field.
 * This allows multiple badge variants per bundle result.
 *
 * @param badgeKey - Badge cache key (from getBadgeKey)
 * @param badgeId - Badge ID (from generateBadgeId)
 * @returns Cached badge string (SVG or base64 PNG) or null
 */
export async function getCachedBadge(badgeKey: string, badgeId: string): Promise<string | null> {
	return withCacheFallback(async (redis) => {
		return await redis.hget<string>(badgeKey, badgeId)
	})
}

/**
 * Store a badge in cache.
 *
 * @param badgeKey - Badge cache key
 * @param badgeId - Badge ID
 * @param badge - Badge content (SVG string or base64-encoded PNG)
 * @returns true if stored successfully
 */
export async function setCachedBadge(
	badgeKey: string,
	badgeId: string,
	badge: string
): Promise<boolean> {
	const success = await withCacheFallback(async (redis) => {
		await redis.hset<string>(badgeKey, { [badgeId]: badge })
		return true
	})

	return success ?? false
}

/**
 * Delete all cached badges for a bundle.
 *
 * Called when the underlying bundle result changes to invalidate stale badges.
 *
 * @param badgeKey - Badge cache key
 * @returns true if deleted
 */
export async function deleteCachedBadges(badgeKey: string): Promise<boolean> {
	const success = await withCacheFallback(async (redis) => {
		await redis.del(badgeKey)
		return true
	})

	return success ?? false
}

// =============================================================================
// Cache Management Operations
// =============================================================================

/**
 * Clear all entries in the database.
 *
 * **Warning:** This is a destructive operation.
 *
 * @returns true if successful
 */
export async function flushCache(): Promise<boolean> {
	const success = await withCacheFallback(async (redis) => {
		await redis.flushdb({ async: true })
		return true
	})

	return success ?? false
}

/**
 * Clear all entries asynchronously.
 *
 * Returns immediately while flush happens in background.
 *
 * @returns true if command sent
 */
export async function flushCacheAsync(): Promise<boolean> {
	const success = await withCacheFallback(async (redis) => {
		await redis.flushdb({ async: true })
		return true
	})

	return success ?? false
}

/**
 * Check if a key exists in cache.
 *
 * @param key - Cache key to check
 * @returns true if exists, false if not or error
 */
export async function cacheKeyExists(key: string): Promise<boolean> {
	const exists = await withCacheFallback(async (redis) => {
		const count = await redis.exists(key)
		return count > 0
	})

	return exists ?? false
}

// =============================================================================
// Composite Operations
// =============================================================================

/**
 * Get or compute a cached result.
 *
 * Implements the cache-aside pattern:
 * 1. Check cache for existing result
 * 2. If found, return cached value
 * 3. If not found, execute compute function
 * 4. Store result in cache
 * 5. Return computed value
 *
 * @param key - Cache key
 * @param compute - Function to compute result on cache miss
 * @param ttlSeconds - TTL for cached result
 * @returns Result (cached or computed)
 *
 * @example
 * ```ts
 * const result = await getOrCompute(
 *   'json/abc123',
 *   async () => executeBundle(options),
 *   86400
 * )
 * ```
 */
export async function getOrCompute<T extends BundleResult>(
	key: string,
	compute: () => Promise<T>,
	ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<{ result: T; cached: boolean }> {
	// Try to get from cache
	const cached = await getCachedResult(key)
	if (cached) {
		return { result: cached as T, cached: true }
	}

	// Compute the result
	const result = await compute()

	// Store in cache (fire and forget)
	setCachedResult(key, result, ttlSeconds).catch((e) => {
		console.warn('[Cache] Failed to store result:', e)
	})

	return { result, cached: false }
}

/**
 * Invalidate cache entries related to a bundle.
 *
 * Deletes:
 * - JSON result key
 * - Badge key
 * - Package result key (if provided)
 *
 * @param jsonKey - Main JSON result key
 * @param badgeKey - Badge key
 * @param packageKey - Optional package result key
 * @returns Number of keys deleted
 */
export async function invalidateBundleCache(
	jsonKey: string,
	badgeKey: string,
	packageKey?: string
): Promise<number> {
	const keys = [jsonKey, badgeKey]
	if (packageKey) {
		keys.push(packageKey)
	}

	return deleteCachedResults(...keys)
}