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
import { rateLimitMiddleware } from '#shared/middleware/rate-limit.ts'
import { cacheControlMiddleware, type CacheControlVariables } from '#shared/middleware/cache-control.ts'

import { ok, internalServerError, badRequest, validationFailed } from '#shared/response/mod.ts'
import { getLogger } from '#shared/middleware/correlation.ts'

import { resolveBundleRequest } from '#shared/bundle/request.ts'
import { generateLegacyResponse } from '#shared/bundle/legacy-response.ts'

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
  rateLimitMiddleware<AppEnv>({ windowMs: 60_000, limit: 120 }),
  
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
  const method = c.req.method
  const isLegacyPath = !c.req.path.includes('/v1/')
  
  try {
    // Get input from query or body
    let input = method === 'POST'
      ? await c.req.json()
      : c.req.valid('query')

    if (method === 'GET') {
      const requestUrl = new URL(c.req.url)
      if (requestUrl.searchParams.has('docs')) {
        return Response.redirect(
          'https://blog.okikio.dev/documenting-an-online-bundler-bundlejs#heading-configuration'
        )
      }
    }

    if (method === 'POST' && Definition.Schemas.Json) {
      const result = Definition.Schemas.Json.safeParse(input)
      if (!result.success) {
        const errors = result.error.issues.map((issue) => ({
          field: issue.path.length > 0 ? issue.path.join('.') : '_root',
          message: issue.message,
        }))
        return c.json(...validationFailed(c.req.path, errors))
      }

      input = result.data
    }

    const cacheMode = c.get('cacheMode') ?? 'use'

    const resolution = await resolveBundleRequest({
      input,
      baseUrl: c.req.url,
      cacheMode,
      includeOutputText: isLegacyPath ? 'auto' : false,
    })

    if (!resolution.inputCode && resolution.modules.length === 0) {
      return c.json(...badRequest(c.req.path, 'No modules or code provided'))
    }

    if (isLegacyPath) {
      return await generateLegacyResponse({
        url: resolution.url,
        result: resolution.result,
        outputText: resolution.outputText,
        cached: resolution.cached,
        durationMs: resolution.durationMs,
        cacheKey: resolution.cacheKey,
      })
    }

    const duration = performance.now() - startTime
    c.header('X-Bundle-Duration-ms', duration.toFixed(2))
    c.header(
      'X-Cache',
      resolution.cached
        ? 'HIT'
        : cacheMode === 'bypass'
        ? 'BYPASS'
        : cacheMode === 'refresh'
        ? 'REFRESH'
        : 'MISS'
    )

    logger.info('Bundle complete', {
      duration_ms: duration.toFixed(2),
      cached: resolution.cached,
    })

    return c.json(...ok(resolution.result))
    
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