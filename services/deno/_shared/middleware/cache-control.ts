/**
 * Cache Control Middleware
 *
 * Normalizes cache behavior for bundle endpoints.
 * Supports legacy paths and the `cache` query parameter.
 *
 * Flow:
 * +-----------+      +--------------------+      +------------------+
 * | Request   | ---> | Parse cache intent | ---> | Set c.var value |
 * +-----------+      +--------------------+      +------------------+
 */

import type { CacheMode } from '../bundle/types.ts'
import type { MiddlewareHandler } from 'hono'

export interface CacheControlVariables {
  cacheMode?: CacheMode
}

const DEFAULT_CACHE_MODE: CacheMode = 'use'

export const cacheControlMiddleware: MiddlewareHandler = async (c, next) => {
  const url = new URL(c.req.url)
  const cacheParam = url.searchParams.get('cache')

  let cacheMode: CacheMode = DEFAULT_CACHE_MODE

  if (url.pathname === '/no-cache') {
    cacheMode = 'bypass'
  } else if (cacheParam === 'use' || cacheParam === 'bypass' || cacheParam === 'refresh') {
    cacheMode = cacheParam
  }

  c.set('cacheMode', cacheMode)
  return await next()
}
