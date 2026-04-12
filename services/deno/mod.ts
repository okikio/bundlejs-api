// mod.ts
/**
 * Bundle Service: Main Entry Point
 * 
 * Creates Hono app with:
 * - Global middleware (security, cors, logging, timing)
 * - Rate limiting per-tier
 * - All endpoints registered from definitions
 * - Legacy path compatibility
 */

import type { EndpointHandlerModule } from '@utils/endpoint/types'
import { createServer } from '@utils/server'
import { showRoutes } from 'hono/dev'

// Import endpoint handlers
import * as BundleRunHandler from './endpoints/bundle/run/handler.ts'
import * as BundleFileHandler from './endpoints/bundle/file/handler.ts'
import * as BundleMetafileHandler from './endpoints/bundle/metafile/handler.ts'
import * as BundleAnalysisHandler from './endpoints/bundle/analysis/handler.ts'
import * as BundleWarningsHandler from './endpoints/bundle/warnings/handler.ts'
import * as BundleRawHandler from './endpoints/bundle/raw/handler.ts'

import * as BadgeSvgHandler from './endpoints/badge/svg/handler.ts'
import * as BadgeRasterHandler from './endpoints/badge/raster/handler.ts'

import * as CachePurgeHandler from './endpoints/cache/purge/handler.ts'
import * as CacheClearHandler from './endpoints/cache/clear/handler.ts'

import * as StaticHandler from './endpoints/static/handler.ts'

import { EndpointDefinitions } from './index.ts'
import { registerLegacyRoutes } from './legacy.ts'

// ============================================================================
// Handler Registry
// ============================================================================

export const EndpointHandlers = {
  // Bundle endpoints
  [EndpointDefinitions.BundleRun.Name]: BundleRunHandler,
  [EndpointDefinitions.BundleFile.Name]: BundleFileHandler,
  [EndpointDefinitions.BundleMetafile.Name]: BundleMetafileHandler,
  [EndpointDefinitions.BundleAnalysis.Name]: BundleAnalysisHandler,
  [EndpointDefinitions.BundleWarnings.Name]: BundleWarningsHandler,
  [EndpointDefinitions.BundleRaw.Name]: BundleRawHandler,
  
  // Badge endpoints
  [EndpointDefinitions.BadgeSvg.Name]: BadgeSvgHandler,
  [EndpointDefinitions.BadgeRaster.Name]: BadgeRasterHandler,
  
  // Cache admin endpoints
  [EndpointDefinitions.CachePurge.Name]: CachePurgeHandler,
  [EndpointDefinitions.CacheClear.Name]: CacheClearHandler,
  
  // Static endpoints
  [EndpointDefinitions.Static.Name]: StaticHandler,
} as const satisfies Record<string, EndpointHandlerModule>

// ============================================================================
// Create App
// ============================================================================

const app = createServer('', {
  serviceName: 'bundle-service',
  cors: {
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Request-ID', 'X-Cache', 'X-Bundle-Duration-ms'],
  },
})

// ============================================================================
// Register Endpoints
// ============================================================================

Object.values(EndpointDefinitions).forEach((endpoint) => {
  const route = endpoint.Route
  const methods = Array.from(new Set(endpoint.Methods)) as Array<
    'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH'
  >

  const handlerModule = EndpointHandlers[endpoint.Name] as EndpointHandlerModule
  const middleware = handlerModule.Middleware ?? []
  const handler = handlerModule.default

  if (!handler) {
    console.warn(`No handler found for endpoint: ${endpoint.Name}`)
    return
  }

  app.on(methods, [route], ...middleware, handler)
})

// Register legacy routes for backward compatibility
registerLegacyRoutes(app, EndpointHandlers)

// Show registered routes
showRoutes(app, { verbose: true })

// ============================================================================
// Export
// ============================================================================

export { app }
export default app