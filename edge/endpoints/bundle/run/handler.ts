// endpoints/bundle/run/handler.ts
/**
 * Bundle Run Handler
 * 
 * GET/POST /v1/bundle
 * 
 * Main orchestrator that:
 * 1. Parses input (query or body)
 * 2. Checks cache
 * 3. Executes bundle if needed
 * 4. Caches result
 * 5. Returns formatted response
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '#shared/server/types.ts'
import type { CorrelationVariables } from '#shared/middleware/correlation.ts'

import { createValidator } from '#shared/middleware/validation.ts'
import { rateLimitMiddleware } from '#middleware/rate-limit.ts'
import { cacheControlMiddleware, type CacheControlVariables } from '#middleware/cache-control.ts'

import { ok, internalServerError, badRequest } from '#shared/response/mod.ts'
import { getLogger } from '#shared/middleware/correlation.ts'

import { parseQueryToConfig } from '#shared/bundle/parse.ts'
import { executeBundle } from '#shared/bundle/service.ts'
import { generateCacheKey } from '#shared/cache/keys.ts'
import { getCachedResult, setCachedResult } from '#shared/cache/operations.ts'

import Definition from './definition.ts'

// ============================================================================
// TYPES
// ============================================================================

type HandlerVariables = CorrelationVariables & CacheControlVariables

export type AppEnv = FunctionAppEnv<HandlerVariables>

// ============================================================================
// MIDDLEWARE
// ============================================================================

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  // Rate limit: 120 req/min for bundling (expensive compute)
  rateLimitMiddleware({ windowMs: 60_000, limit: 120 }),
  
  // Parse cache mode from query
  cacheControlMiddleware,
  
  // Validate input
  createValidator('query', Definition.Schemas.Query),
]

// ============================================================================
// HANDLER
// ============================================================================

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async function (c) {
  const logger = getLogger(c)
  const startTime = performance.now()
  
  try {
    // Get input from query or body
    const method = c.req.method
    const input = method === 'POST' 
      ? await c.req.json()
      : c.req.valid('query')
    
    // Parse into bundle config
    const { inputCode, config, modules } = await parseQueryToConfig(input)
    
    if (!inputCode && modules.length === 0) {
      return c.json(...badRequest(c.req.path, 'No modules or code provided'))
    }
    
    // Generate cache key
    const cacheKey = generateCacheKey(config, modules)
    
    // Check cache (unless bypassing)
    const cacheMode = c.get('cacheMode') ?? 'use'
    
    if (cacheMode === 'use') {
      const cached = await getCachedResult(cacheKey)
      if (cached) {
        logger.info('Cache HIT', { key: cacheKey.slice(0, 20) })
        c.header('X-Cache', 'HIT')
        return c.json(...ok({ ...cached, cached: true }))
      }
    }
    
    logger.info('Cache MISS - executing bundle', {
      modules: modules.length,
      cacheMode,
    })
    c.header('X-Cache', cacheMode === 'bypass' ? 'BYPASS' : 'MISS')
    
    // Execute bundle
    const result = await executeBundle({
      config,
      inputCode,
      entryPointHash: cacheKey.slice(0, 8),
    })
    
    // Cache result (unless bypassing)
    if (cacheMode !== 'bypass') {
      await setCachedResult(cacheKey, result)
    }
    
    // Add timing header
    const duration = performance.now() - startTime
    c.header('X-Bundle-Duration-ms', duration.toFixed(2))
    
    logger.info('Bundle complete', {
      duration_ms: duration.toFixed(2),
      output_size: result.outputText?.length ?? 0,
    })
    
    return c.json(...ok(result))
    
  } catch (error) {
    logger.error('Bundle failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    
    return c.json(...internalServerError(
      c.req.path,
      error instanceof Error ? error.message : 'Bundle execution failed'
    ))
  }
}

export default Handler