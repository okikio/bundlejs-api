/**
 * Endpoint Definitions Registry
 */

import BundleRun from './run/definition.ts'
import BundleFile from './file/definition.ts'
import BundleMetafile from './metafile/definition.ts'
import BundleAnalysis from './analysis/definition.ts'
import BundleWarnings from './warnings/definition.ts'
import BundleRaw from './raw/definition.ts'

import BadgeSvg from '../badge/svg/definition.ts'
import BadgeRaster from '../badge/raster/definition.ts'

import CachePurge from '../cache/purge/definition.ts'
import CacheClear from '../cache/clear/definition.ts'

import OpenApi from '../static/openapi/definition.ts'
import Plugin from '../static/plugin/definition.ts'
import Robots from '../static/robots/definition.ts'
import Llm from '../static/llms/definition.ts'
import ServiceWorker from '../static/sw/definition.ts'
import Favicon from '../static/favicon/definition.ts'
import AppleTouchIcon from '../static/apple-touch-icon/definition.ts'
import AppleTouchIconPrecomposed from '../static/apple-touch-icon-precomposed/definition.ts'

import Health from '../health/definition.ts'

export const EndpointDefinitions = {
  BundleRun,
  BundleFile,
  BundleMetafile,
  BundleAnalysis,
  BundleWarnings,
  BundleRaw,
  BadgeSvg,
  BadgeRaster,
  CachePurge,
  CacheClear,
  OpenApi,
  Plugin,
  Robots,
  Llm,
  ServiceWorker,
  Favicon,
  AppleTouchIcon,
  AppleTouchIconPrecomposed,
  Health,
} as const
