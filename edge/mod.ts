// mod.ts
/**
 * Bundle Service: Endpoint Definitions Registry
 * 
 * All endpoint contracts in one place for:
 * - Type-safe registration
 * - Client type generation
 * - OpenAPI schema derivation
 */

// Bundle endpoints
import BundleRunDef from './endpoints/bundle/run/definition.ts'
import BundleFileDef from './endpoints/bundle/file/definition.ts'
import BundleMetafileDef from './endpoints/bundle/metafile/definition.ts'
import BundleAnalysisDef from './endpoints/bundle/analysis/definition.ts'
import BundleWarningsDef from './endpoints/bundle/warnings/definition.ts'
import BundleRawDef from './endpoints/bundle/raw/definition.ts'

// Badge endpoints
import BadgeSvgDef from './endpoints/badge/svg/definition.ts'
import BadgeRasterDef from './endpoints/badge/raster/definition.ts'

// Cache admin endpoints
import CachePurgeDef from './endpoints/cache/purge/definition.ts'
import CacheClearDef from './endpoints/cache/clear/definition.ts'

// Static endpoints
import OpenApiDef from './endpoints/static/openapi/definition.ts'
import PluginDef from './endpoints/static/plugin/definition.ts'
import RobotsDef from './endpoints/static/robots/definition.ts'

// Health
import HealthDef from './endpoints/health/definition.ts'

// ============================================================================
// Definitions Registry
// ============================================================================

export const EndpointDefinitions = {
  // Bundle
  BundleRun: BundleRunDef,
  BundleFile: BundleFileDef,
  BundleMetafile: BundleMetafileDef,
  BundleAnalysis: BundleAnalysisDef,
  BundleWarnings: BundleWarningsDef,
  BundleRaw: BundleRawDef,
  
  // Badge
  BadgeSvg: BadgeSvgDef,
  BadgeRaster: BadgeRasterDef,
  
  // Cache admin
  CachePurge: CachePurgeDef,
  CacheClear: CacheClearDef,
  
  // Static
  OpenApi: OpenApiDef,
  Plugin: PluginDef,
  Robots: RobotsDef,
  
  // Health
  Health: HealthDef,
} as const

// ============================================================================
// Type Exports
// ============================================================================

export type BundleRunInput = typeof BundleRunDef.Input
export type BundleRunOutput = typeof BundleRunDef.Output

export type BundleFileInput = typeof BundleFileDef.Input
export type BundleFileOutput = typeof BundleFileDef.Output

// ... (similar for other endpoints)

export default EndpointDefinitions