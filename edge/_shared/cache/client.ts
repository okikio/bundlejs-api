// _shared/cache/client.ts
/**
 * Cache Client
 *
 * Singleton Redis client with circuit breaker pattern for graceful degradation.
 * When Redis becomes unavailable, the service continues without caching.
 *
 * @module
 */
import { Redis } from '@upstash/redis'
import { getLogger } from '@logtape/logtape'

const logger = getLogger(['bundle', 'cache'])

// =============================================================================
// Constants
// =============================================================================

/** Duration to consider cache unhealthy after an error (30 seconds) */
const UNHEALTHY_DURATION_MS = 30_000

/** Environment variable names */
const ENV_UPSTASH_URL = 'UPSTASH_URL'
const ENV_UPSTASH_TOKEN = 'UPSTASH_TOKEN'

// =============================================================================
// Module State
// =============================================================================

/** Singleton Redis client instance */
let redisClient: Redis | null = null

/** Timestamp when cache was marked unhealthy */
let unhealthyAt: number | null = null

/** Initialization error for diagnostics */
let initError: Error | null = null

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the Redis client singleton.
 *
 * Returns null if:
 * - Redis is not configured (missing env vars)
 * - Redis is currently marked unhealthy
 * - Initialization failed
 *
 * **Circuit breaker behavior:**
 * After a Redis error, the cache is marked unhealthy for 30 seconds.
 * During this period, getRedisClient returns null to avoid cascading failures.
 * After 30 seconds, the next call will attempt to reconnect.
 *
 * @returns Redis client or null if unavailable
 *
 * @example
 * ```ts
 * const redis = getRedisClient()
 * if (redis) {
 *   const result = await redis.get('key')
 * } else {
 *   // Proceed without cache
 * }
 * ```
 */
export function getRedisClient(): Redis | null {
	// Check circuit breaker
	if (unhealthyAt !== null) {
		const elapsed = Date.now() - unhealthyAt
		if (elapsed < UNHEALTHY_DURATION_MS) {
			return null // Still in unhealthy period
		}
		// Recovery period elapsed, reset and try again
		unhealthyAt = null
	}

	// Return existing client if available
	if (redisClient) {
		return redisClient
	}

	// Try to initialize
	try {
		redisClient = createRedisClient()
		initError = null
		return redisClient
	} catch (e) {
		initError = e as Error
    logger.warn(new Error('[Cache] Failed to initialize Redis:', { cause: e }))
		return null
	}
}

/**
 * Check if cache is currently healthy and available.
 *
 * @returns true if cache is available
 */
export function isCacheHealthy(): boolean {
	// Check circuit breaker first
	if (unhealthyAt !== null) {
		const elapsed = Date.now() - unhealthyAt
		if (elapsed < UNHEALTHY_DURATION_MS) {
			return false
		}
	}

	// Check if client exists or can be created
	return getRedisClient() !== null
}

/**
 * Mark the cache as unhealthy.
 *
 * Call this when a Redis operation fails to trigger the circuit breaker.
 * The cache will be unavailable for 30 seconds before auto-recovery.
 *
 * @param error - Optional error for logging
 *
 * @example
 * ```ts
 * try {
 *   await redis.get('key')
 * } catch (e) {
 *   markCacheUnhealthy(e)
 *   // Proceed without cache
 * }
 * ```
 */
export function markCacheUnhealthy(error?: unknown): void {
	unhealthyAt = Date.now()
	if (error) {
    logger.warn(new Error('[Cache] Marked unhealthy due to error:', { cause: error }))
	}
}

/**
 * Manually reset the cache health status.
 *
 * Primarily used for testing or forced recovery.
 */
export function resetCacheHealth(): void {
	unhealthyAt = null
	initError = null
}

/**
 * Get cache diagnostics for health checks.
 *
 * @returns Diagnostic information
 */
export function getCacheDiagnostics(): {
	isHealthy: boolean
	hasClient: boolean
	unhealthyAt: number | null
	unhealthyDuration: number | null
	initError: string | null
	isConfigured: boolean
} {
	const now = Date.now()
	return {
		isHealthy: isCacheHealthy(),
		hasClient: redisClient !== null,
		unhealthyAt,
		unhealthyDuration: unhealthyAt ? now - unhealthyAt : null,
		initError: initError?.message ?? null,
		isConfigured: isRedisConfigured(),
	}
}

/**
 * Execute a function with cache fallback.
 *
 * If the cache operation fails, the error is caught, the cache is marked
 * unhealthy, and null is returned. This helper ensures cache failures
 * don't break the main flow.
 *
 * @param fn - Function that uses the Redis client
 * @returns Result or null on failure
 *
 * @example
 * ```ts
 * const result = await withCacheFallback(async (redis) => {
 *   return await redis.get('key')
 * })
 * // result is either the value or null (never throws)
 * ```
 */
export async function withCacheFallback<T>(
	fn: (redis: Redis) => Promise<T>
): Promise<T | null> {
	const redis = getRedisClient()
	if (!redis) {
		return null
	}

	try {
		return await fn(redis)
	} catch (e) {
		markCacheUnhealthy(e)
		return null
	}
}

// =============================================================================
// Internal Implementation
// =============================================================================

/**
 * Check if Redis environment variables are configured.
 */
function isRedisConfigured(): boolean {
	const url = Deno.env.get(ENV_UPSTASH_URL)
	const token = Deno.env.get(ENV_UPSTASH_TOKEN)
	return Boolean(url && token)
}

/**
 * Create a new Redis client instance.
 *
 * @throws If environment variables are missing
 */
function createRedisClient(): Redis {
	const url = Deno.env.get(ENV_UPSTASH_URL)
	const token = Deno.env.get(ENV_UPSTASH_TOKEN)

	if (!url || !token) {
		throw new Error(
			`Redis not configured. Set ${ENV_UPSTASH_URL} and ${ENV_UPSTASH_TOKEN} environment variables.`
		)
	}

	return new Redis({ url, token })
}

/**
 * Close and reset the Redis client.
 *
 * @internal Primarily for testing
 */
export function closeRedisClient(): void {
	redisClient = null
	unhealthyAt = null
	initError = null
}