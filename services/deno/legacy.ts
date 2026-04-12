// legacy/routes.ts
/**
 * Legacy Route Compatibility
 * 
 * Maps old bundlejs paths to new v1 handlers.
 * Allows gradual migration without breaking existing clients.
 */

import type { Hono, Env } from 'hono'
import type { BlankEnv } from 'hono/types'
import type { EndpointHandlerModule } from '@utils/endpoint/types'

export function registerLegacyRoutes<E extends Env = BlankEnv>(
  app: Hono<E>,
  handlers: Record<string, EndpointHandlerModule>
) {
  // Main bundle endpoint (root)
  // GET/POST / → /v1/bundle
  const bundleRun = handlers['bundle-run']
  if (bundleRun?.default) {
    app.on(['GET', 'POST'], ['/'], ...(bundleRun.Middleware ?? []), bundleRun.default)
  }
  
  // Output variants
  // GET /file → /v1/bundle/file
  const bundleFile = handlers['bundle-file']
  if (bundleFile?.default) {
    app.on(['GET'], ['/file'], ...(bundleFile.Middleware ?? []), bundleFile.default)
  }
  
  // GET /metafile → /v1/bundle/metafile
  const bundleMetafile = handlers['bundle-metafile']
  if (bundleMetafile?.default) {
    app.on(['GET'], ['/metafile'], ...(bundleMetafile.Middleware ?? []), bundleMetafile.default)
  }
  
  // GET /analysis, /analyze → /v1/bundle/analysis
  const bundleAnalysis = handlers['bundle-analysis']
  if (bundleAnalysis?.default) {
    app.on(['GET'], ['/analysis'], ...(bundleAnalysis.Middleware ?? []), bundleAnalysis.default)
    app.on(['GET'], ['/analyze'], ...(bundleAnalysis.Middleware ?? []), bundleAnalysis.default)
  }
  
  // GET /warnings → /v1/bundle/warnings
  const bundleWarnings = handlers['bundle-warnings']
  if (bundleWarnings?.default) {
    app.on(['GET'], ['/warnings'], ...(bundleWarnings.Middleware ?? []), bundleWarnings.default)
  }
  
  // GET /raw → /v1/bundle/raw
  const bundleRaw = handlers['bundle-raw']
  if (bundleRaw?.default) {
    app.on(['GET'], ['/raw'], ...(bundleRaw.Middleware ?? []), bundleRaw.default)
  }
  
  // Badge endpoints
  // GET /badge → /v1/badge
  const badgeSvg = handlers['badge-svg']
  if (badgeSvg?.default) {
    app.on(['GET'], ['/badge'], ...(badgeSvg.Middleware ?? []), badgeSvg.default)
  }
  
  // GET /badge/raster, /badge-raster → /v1/badge/raster
  const badgeRaster = handlers['badge-raster']
  if (badgeRaster?.default) {
    app.on(['GET'], ['/badge/raster'], ...(badgeRaster.Middleware ?? []), badgeRaster.default)
    app.on(['GET'], ['/badge-raster'], ...(badgeRaster.Middleware ?? []), badgeRaster.default)
  }
  
  // Cache control (legacy paths)
  // GET /no-cache → /v1/bundle with cache=bypass
  // (Handled via query param in new API, but we can support path)
  if (bundleRun?.default) {
    app.on(['GET'], ['/no-cache'], ...(bundleRun.Middleware ?? []), bundleRun.default)
  }
  
  // GET/POST /delete-cache → /v1/cache/purge
  const cachePurge = handlers['cache-purge']
  if (cachePurge?.default) {
    app.on(['GET', 'POST'], ['/delete-cache'], ...(cachePurge.Middleware ?? []), cachePurge.default)
  }
  
  // GET /clear-all-cache-123 → /v1/cache/clear
  const cacheClear = handlers['cache-clear']
  if (cacheClear?.default) {
    app.on(['GET'], ['/clear-all-cache-123'], ...(cacheClear.Middleware ?? []), cacheClear.default)
    app.on(['GET'], ['/clear-cache'], ...(cacheClear.Middleware ?? []), cacheClear.default)
  }
}