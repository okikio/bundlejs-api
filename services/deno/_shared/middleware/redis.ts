/**
 * Redis middleware for bundlejs edge functions.
 * 
 * Initializes Upstash Redis client and makes it available via context.
 * Gracefully handles missing credentials or connection failures.
 */

import type { MiddlewareHandler } from 'hono'
import { Redis } from '@upstash/redis'

// =============================================================================
// Types
// =============================================================================

export interface RedisVariables {
  redis: Redis | null
}

// =============================================================================
// Singleton Redis Instance
// =============================================================================

let redisInstance: Redis | null = null
let redisInitialized = false

/**
 * Get or create Redis instance.
 * Returns null if credentials are missing or connection fails.
 */
function getRedis(): Redis | null {
  if (redisInitialized) return redisInstance

  try {
    const url = Deno.env.get('UPSTASH_URL')
    const token = Deno.env.get('UPSTASH_TOKEN')

    if (!url || !token) {
      console.warn('[redis] Missing UPSTASH_URL or UPSTASH_TOKEN - caching disabled')
      redisInitialized = true
      return null
    }

    redisInstance = new Redis({ url, token })
    redisInitialized = true
    return redisInstance
  } catch (error) {
    console.warn('[redis] Failed to initialize:', error)
    redisInitialized = true
    return null
  }
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Middleware that initializes Redis and attaches it to context.
 * 
 * Access via `c.get('redis')` - may be null if Redis is unavailable.
 * 
 * @example
 * ```ts
 * app.use('*', redisMiddleware)
 * 
 * app.get('/bundle', async (c) => {
 *   const redis = c.get('redis')
 *   if (redis) {
 *     const cached = await redis.get('key')
 *   }
 * })
 * ```
 */
export const redisMiddleware: MiddlewareHandler<{ Variables: RedisVariables }> = async (c, next) => {
  c.set('redis', getRedis())
  await next()
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Reset Redis instance (useful for testing).
 */
export function resetRedis(): void {
  redisInstance = null
  redisInitialized = false
}

/**
 * Check if Redis is available.
 */
export function isRedisAvailable(): boolean {
  return getRedis() !== null
}