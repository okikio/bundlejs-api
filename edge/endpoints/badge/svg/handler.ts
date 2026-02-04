// endpoints/badge/svg/handler.ts
/**
 * Badge SVG Handler
 * 
 * GET /v1/badge
 * 
 * Generates shields.io badge from bundle size.
 * Handles:
 * - Bundle result lookup (cache or compute)
 * - Badge generation with timeout
 * - SVG response with caching headers
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '#shared/server/types.ts'

import { createValidator } from '#shared/middleware/validation.ts'
import { rateLimitMiddleware } from '#middleware/rate-limit.ts'

import { badRequest, badGateway, gatewayTimeout } from '#shared/response/mod.ts'
import { getLogger } from '#shared/middleware/correlation.ts'

import { parseQueryToConfig } from '#shared/bundle/parse.ts'
import { generateCacheKey } from '#shared/cache/keys.ts'
import { getCachedResult } from '#shared/cache/operations.ts'
import { fetchBadge, type BadgeOptions } from '#shared/external/shields.ts'

import Definition from './definition.ts'

export type AppEnv = FunctionAppEnv

// ============================================================================
// MIDDLEWARE
// ============================================================================

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  rateLimitMiddleware({ windowMs: 60_000, limit: 300 }),  // Higher limit for badges
  createValidator('query', Definition.Schemas.Query),
]

// ============================================================================
// HANDLER
// ============================================================================

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async function (c) {
  const logger = getLogger(c)
  
  try {
    const input = c.req.valid('query')
    const { inputCode, config, modules } = await parseQueryToConfig(input)
    
    // We need a bundle result to generate a badge
    const cacheKey = generateCacheKey(config, modules)
    const cached = await getCachedResult(cacheKey)
    
    if (!cached) {
      // No cached result - can't generate badge without bundling
      // (Could optionally trigger bundle here, but that's expensive for a badge request)
      return c.json(...badRequest(
        c.req.path,
        'No cached bundle result. Request /v1/bundle first.'
      ))
    }
    
    // Determine badge type and value
    const badgeType = input.badge ?? 'gzip'
    const size = cached.compressed?.[badgeType]?.size ?? cached.outputText?.length ?? 0
    const sizeFormatted = formatBytes(size)
    
    // Fetch badge from shields.io with timeout
    const badgeOptions: BadgeOptions = {
      label: badgeType === 'minified' ? 'minified' : `${badgeType} size`,
      message: sizeFormatted,
      color: getSizeColor(size),
    }
    
    const svgResult = await fetchBadge(badgeOptions)
    
    if (!svgResult.ok) {
      logger.warn('shields.io fetch failed', { status: svgResult.status })
      
      if (svgResult.timeout) {
        return c.json(...gatewayTimeout(c.req.path, 'Badge service timeout'))
      }
      return c.json(...badGateway(c.req.path, 'Badge service unavailable'))
    }
    
    // Return SVG with cache headers
    return new Response(svgResult.svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',  // 1 hour
        'X-Cache-Key': cacheKey.slice(0, 20),
      },
    })
    
  } catch (error) {
    logger.error('Badge generation failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    
    return c.json(...badGateway(c.req.path, 'Badge generation failed'))
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getSizeColor(bytes: number): string {
  if (bytes < 10_000) return 'brightgreen'
  if (bytes < 50_000) return 'green'
  if (bytes < 100_000) return 'yellow'
  if (bytes < 500_000) return 'orange'
  return 'red'
}

export default Handler