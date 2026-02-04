/**
 * Badge endpoint - Generate shields.io badges for bundle sizes.
 * 
 * GET /badge - SVG badge
 * GET /badge/raster - PNG badge
 * 
 * Query parameters (in addition to bundle params):
 * - `badge`: Badge variant ('detailed', 'minified', or empty for default)
 * - `badge-style`: Shields.io style (flat, flat-square, plastic, for-the-badge, social)
 * - `badge-raster` / `png`: Return PNG instead of SVG
 * 
 * @example
 * ```
 * GET /badge?q=react
 * GET /badge?q=lodash&badge=detailed&badge-style=for-the-badge
 * GET /badge/raster?q=vue&png
 * ```
 */

import type { Context } from 'hono'
import type { RedisVariables } from '#shared/middleware/redis.ts'
import type { BundleResult, CompressionSize } from './_schemas.ts'

import { z } from 'zod'
import JSON5 from '#shared/vendor/json5.ts'
import { encodeBase64, decodeBase64 } from '@bundle/utils/encoding'

import { BadgeQuerySchema } from './_schemas.ts'
import { normalizeBundleQuery } from '#shared/utils/parse-query.ts'

// Import bundle logic (we need to get the bundle result first)
import { Handler as BundleHandler } from './bundle.ts'

// =============================================================================
// Definition
// =============================================================================

export const Definition = {
  Name: 'badge',
  Route: '/badge',
  Methods: ['GET'] as const,
  Input: BadgeQuerySchema,
  Output: z.union([z.string(), z.instanceof(Uint8Array)]),
  Schemas: {
    Query: BadgeQuerySchema,
  },
} as const

// =============================================================================
// Types
// =============================================================================

type AppEnv = { Variables: RedisVariables }

type BadgeVariant = 'default' | 'detailed' | 'minified' | 'uncompressed'

// =============================================================================
// Utilities
// =============================================================================

/**
 * Sanitize string for shields.io URL format.
 * - `-` → `--`
 * - `_` → `__`
 * - spaces → `_`
 */
function sanitizeShieldsIO(str: string): string {
  return str
    .replace(/-/g, '--')
    .replace(/_/g, '__')
    .replace(/\s/g, '_')
}

/**
 * Determine badge variant from query param.
 */
function getBadgeVariant(badgeParam: string | undefined): BadgeVariant {
  if (!badgeParam) return 'default'
  if (/detail/.test(badgeParam)) return 'detailed'
  if (/minif/.test(badgeParam)) return 'minified'
  if (/uncompress/.test(badgeParam)) return 'uncompressed'
  return 'default'
}

/**
 * Build shields.io badge URL.
 */
function buildBadgeUrl(
  size: CompressionSize,
  variant: BadgeVariant,
  modules: Array<[string, string]> | undefined,
  query: string,
  searchParams: string,
  style: string | undefined,
  isRaster: boolean
): URL {
  const host = isRaster ? 'raster.shields.io' : 'img.shields.io'
  
  // Determine what size to show
  let badgeSize = size.compressedSize
  let badgeType = size.type as string
  
  if (variant === 'minified' || variant === 'uncompressed') {
    badgeSize = size.uncompressedSize
    badgeType = variant
  }
  
  // Build label text
  const detailText = variant === 'detailed' ? `${size.uncompressedSize} -> ` : ''
  const modulesText = variant === 'detailed' && modules?.length
    ? ` (${modules.map(([p]) => p).join(', ')})`
    : ''
  
  const labelText = sanitizeShieldsIO(`bundlejs${modulesText}`)
  const sizeText = sanitizeShieldsIO(`${detailText}${badgeSize} (${badgeType})`)
  
  const urlQuery = encodeURIComponent(`https://bundlejs.com/${searchParams}`)
  const badgeUrl = new URL(`https://${host}/badge/${sizeText}-${labelText}-blue`)
  
  badgeUrl.searchParams.set('link', urlQuery)
  
  if (style) {
    badgeUrl.searchParams.set('style', style)
  }
  
  return badgeUrl
}

// =============================================================================
// Handler
// =============================================================================

export async function Handler(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const redis = c.get('redis')
  const isRasterPath = url.pathname === '/badge/raster' || url.pathname === '/badge-raster'

  // Parse query
  const rawQuery = Object.fromEntries(url.searchParams)
  const parseResult = BadgeQuerySchema.safeParse(rawQuery)
  
  if (!parseResult.success) {
    return c.json({ error: 'Invalid query parameters', details: parseResult.error.flatten() }, 400)
  }

  const query = parseResult.data
  const isRaster = isRasterPath || query['badge-raster'] || query.png

  // Build cache keys
  const normalized = normalizeBundleQuery(query)
  const jsonKeyObj = {
    ...normalized.config,
    versions: normalized.packages,
    modules: normalized.modules,
    initialValue: normalized.inputCode.trim(),
  }
  const jsonKey = `json/${JSON5.stringify(jsonKeyObj).trim()}`
  const badgeKey = `badge/${jsonKey}`
  
  const badgeIDObj = {
    ...jsonKeyObj,
    badge: {
      raster: isRaster,
      result: query.badge,
      style: query['badge-style'],
    },
  }
  const badgeID = JSON5.stringify(badgeIDObj).trim()

  // Check badge cache
  if (redis) {
    try {
      const cachedBadge = await redis.hget<string>(badgeKey, badgeID)
      const cachedResult = await redis.get<string>(jsonKey)
      
      if (cachedBadge && cachedResult) {
        console.log('[badge] Returning cached badge')
        
        const content = isRaster ? decodeBase64(cachedBadge) : cachedBadge
        return new Response(content, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'max-age=36, public',
            'Content-Type': isRaster ? 'image/png' : 'image/svg+xml',
          },
        })
      }
    } catch (e) {
      console.warn('[badge] Cache lookup failed:', e)
    }
  }

  // Get bundle result first (need size info)
  // We'll call the bundle handler internally
  const bundleResponse = await BundleHandler(c)
  
  if (!bundleResponse.ok) {
    return bundleResponse
  }

  const bundleResult: BundleResult = await bundleResponse.json()
  const { size, modules } = bundleResult

  // Determine badge variant
  const variant = getBadgeVariant(query.badge)
  
  // Build shields.io URL
  const badgeUrl = buildBadgeUrl(
    size,
    variant,
    modules,
    query.q ?? query.query ?? 'spring-easing',
    url.search,
    query['badge-style'],
    isRaster
  )

  console.log('[badge] Fetching from shields.io:', badgeUrl.href)

  // Fetch badge
  const badgeResponse = await fetch(badgeUrl)
  
  if (!badgeResponse.ok) {
    return new Response('Failed to generate badge', { status: 502 })
  }

  const badgeContent = isRaster
    ? new Uint8Array(await badgeResponse.arrayBuffer())
    : await badgeResponse.text()

  // Cache badge
  if (redis) {
    try {
      await redis.hset<string>(badgeKey, {
        [badgeID]: typeof badgeContent === 'string' ? badgeContent : encodeBase64(badgeContent),
      })
    } catch (e) {
      console.warn('[badge] Cache write failed:', e)
    }
  }

  return new Response(badgeContent, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'max-age=30, public',
      'Content-Type': isRaster ? 'image/png' : 'image/svg+xml',
    },
  })
}

export default Handler