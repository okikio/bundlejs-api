// middleware/rate-limit.ts
/**
 * Rate Limiting Middleware
 * 
 * Uses hono-rate-limiter with Redis backend for:
 * - Distributed rate limiting across instances
 * - Standard RateLimit headers (IETF draft-6)
 * - Graceful degradation when Redis unavailable
 */

import type { EndpointMiddlewareHandler, FunctionAppEnv } from '@utils/endpoint/types'

import { createMiddleware } from 'hono/factory'
import { rateLimiter } from 'hono-rate-limiter'
import { RedisStore } from '@hono-rate-limiter/redis'
import { getRedisClient } from '#shared/cache/client.ts'
import { rateLimitExceeded } from '@utils/response'

export interface RateLimitOptions {
  windowMs: number
  limit: number
  keyGenerator?: (c: any) => string
}

/**
 * Create rate limit middleware with configurable limits
 */
export function rateLimitMiddleware<Env extends FunctionAppEnv = FunctionAppEnv>(
  options: RateLimitOptions
): EndpointMiddlewareHandler<Env> {
  const { windowMs, limit, keyGenerator } = options
  
  const redis = getRedisClient()
  
  // If Redis unavailable, use in-memory fallback (less ideal but functional)
  const store = redis 
    ? new RedisStore({ client: redis })
    : undefined
  
  return createMiddleware(
    rateLimiter<Env>({
      windowMs,
      limit,
      standardHeaders: 'draft-6',  // RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
      keyGenerator: keyGenerator ?? ((c) => {
        // Default: rate limit by IP
        return c.req.header('x-forwarded-for') 
          ?? c.req.header('x-real-ip')
          ?? 'unknown'
      }),
      store,
      handler: (c) => {
        // Return RFC 7807 problem response
        return c.json(...rateLimitExceeded(c.req.path, 60))
      },
    })
  )
}