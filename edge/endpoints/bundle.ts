/**
 * Bundle endpoint - Main bundlejs API entry point.
 * 
 * GET / - Bundle packages and return size information.
 * 
 * Query parameters:
 * - `q` / `query`: Package(s) to bundle (comma-separated)
 * - `treeshake`: Exports to treeshake per package
 * - `share`: LZ-string compressed code
 * - `text`: Plaintext code input
 * - `config`: JSON5 build configuration
 * - `tsx` / `jsx`: Enable TSX/JSX mode
 * - `minify` / `pretty`: Control minification
 * - `sourcemap`: Sourcemap generation
 * - `format`: Output format (esm/cjs/iife)
 * - `polyfill`: Polyfill node builtins
 * 
 * @example
 * ```
 * GET /?q=react,vue
 * GET /?q=lodash&treeshake=[debounce]
 * GET /?q=@tanstack/react-query&config={"cdn":"esm.sh"}
 * ```
 */

import type { Context } from 'hono'
import type { Redis } from '@upstash/redis'
import type { RedisVariables } from '#shared/middleware/redis.ts'
import type { BundleResult } from './_schemas.ts'

import { z } from 'zod'
import JSON5 from '../vendor/json5.ts'

import { BundleQuerySchema } from './_schemas.ts'
import { normalizeBundleQuery, DEFAULT_INPUT } from '#shared/utils/parse-query.ts'

import { compress, createCompressConfig } from '@bundle/compress'
import { build, setFile, useFileSystem, createConfig, createNotice, BUILD_CONFIG } from '@bundle/core'
import { deepMerge, resolveVersion, parsePackageName } from '@bundle/utils'
import ESBUILD_WASM from '@bundle/core/wasm'

// =============================================================================
// Definition
// =============================================================================

export const Definition = {
  Name: 'bundle',
  Route: '/',
  Methods: ['GET'] as const,
  Input: BundleQuerySchema,
  Output: z.unknown(), // Response varies by query params
  Schemas: {
    Query: BundleQuerySchema,
  },
} as const

// =============================================================================
// Types
// =============================================================================

interface BundleConfig {
  entryPoints: string[]
  compression: ReturnType<typeof createCompressConfig>
  polyfill: boolean
  esbuild: {
    metafile?: boolean
    minify?: boolean
    sourcemap?: string | boolean
    format?: string
  }
  init: {
    platform: string
    worker: boolean
    wasmModule?: WebAssembly.Module
  }
  tsx?: boolean
  'package.json'?: Record<string, unknown>
}

type AppEnv = { Variables: RedisVariables }

// =============================================================================
// Shared State
// =============================================================================

let WASM_MODULE: Uint8Array | undefined
let wasmModule: WebAssembly.Module | undefined

const FileSystem = useFileSystem()

const timeFormatter = new Intl.RelativeTimeFormat('en', {
  style: 'narrow',
  numeric: 'auto',
})

// =============================================================================
// Utilities
// =============================================================================

async function hashString(str: string): Promise<string> {
  const data = new TextEncoder().encode(str)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function getPackageResultKey(moduleName: string): string {
  return `json-package/${moduleName}`
}

// =============================================================================
// Cache Utilities
// =============================================================================

async function getCachedResult(
  redis: Redis | null,
  jsonKey: string,
  badgeKey: string,
  badgeID: string,
  modules: Array<[string, string]>,
  exportAll: boolean,
  hasMutationQueries: boolean
): Promise<BundleResult | null> {
  if (!redis) return null

  try {
    const jsonString = await redis.get<string>(jsonKey)
    if (!jsonString) return null

    const result = JSON5.parse<BundleResult>(jsonString)
    if (result) return result

    // Check package-specific cache for single export-all queries
    if (modules.length === 1 && exportAll && !hasMutationQueries) {
      const [moduleName, mode] = modules[0]
      if (mode === 'export') {
        const packageKey = `${getPackageResultKey(moduleName)}/${jsonKey}`
        const packageString = await redis.get<string>(packageKey)
        if (packageString) {
          return JSON5.parse<BundleResult>(packageString)
        }
      }
    }
  } catch (e) {
    console.warn('[bundle] Cache lookup failed:', e)
  }

  return null
}

async function setCachedResult(
  redis: Redis | null,
  jsonKey: string,
  result: BundleResult,
  modules: Array<[string, string]>,
  exportAll: boolean,
  hasMutationQueries: boolean
): Promise<void> {
  if (!redis) return

  try {
    await redis.set(jsonKey, JSON5.stringify(result), { ex: 86400 }) // 24h TTL

    // Also cache under package key for single export-all queries
    if (modules.length === 1 && exportAll && !hasMutationQueries) {
      const [moduleName, mode] = modules[0]
      if (mode === 'export') {
        const packageKey = `${getPackageResultKey(moduleName)}/${jsonKey}`
        await redis.set(packageKey, JSON5.stringify(result))
      }
    }
  } catch (e) {
    console.warn('[bundle] Cache write failed:', e)
  }
}

// =============================================================================
// Core Bundle Logic
// =============================================================================

async function performBundle(
  inputCode: string,
  config: BundleConfig,
  versions: string[],
  modules: Array<[string, string]>,
  searchQueries: string
): Promise<[BundleResult, string]> {
  const fs = await FileSystem
  const start = performance.now()

  const entryPoints = config.entryPoints
  const entryPoint = Array.isArray(entryPoints)
    ? entryPoints[0]
    : typeof entryPoints === 'string'
    ? entryPoints
    : (entryPoints as { in: string }).in

  // Write input to virtual filesystem
  setFile(fs, entryPoint, inputCode)

  // Run esbuild
  const result = await build(config as unknown as Parameters<typeof build>[0], FileSystem)
  const end = performance.now()

  // Clear filesystem
  await fs?.clear?.()

  // Get output text
  let resultValue = result.contents[0]?.text ?? ''
  
  // Compress outputs
  const { content: _content, ...size } = await compress(
    result.contents.map((x: { contents: Uint8Array; path: string; text: string }) => {
      if (x.path === entryPoint) resultValue = x.text
      return x.contents
    }),
    config.compression
  )

  const duration = end - start
  const { init: _init, ...printableConfig } = createConfig('build', config as unknown as Parameters<typeof createConfig>[1])

  // Build warnings
  const [, warnings] = (
    await Promise.allSettled([
      null, // Gist disabled for now
      createNotice(result.warnings, 'warning', false),
    ])
  ).map((res) => (res.status === 'fulfilled' ? res.value : null))

  const versionsArr = Array.from(new Set(versions))
  const modulesArr = modules

  const finalResult: BundleResult = {
    query: decodeURIComponent(searchQueries),
    rawQuery: encodeURIComponent(searchQueries),
    ...(versionsArr.length === 1 ? { version: versionsArr[0] } : { versions: versionsArr }),
    modules: modulesArr as Array<[string, string]>,
    config: printableConfig as Record<string, unknown>,
    input: inputCode,
    size: size as BundleResult['size'],
    installSize: {
      total: result?.totalInstallSize ? Number(result?.totalInstallSize) : undefined,
      packages: result?.packageSizeArr,
    },
    time: timeFormatter.format(duration / 1000, 'seconds'),
    rawTime: duration,
    ...(result?.warnings?.length > 0 ? { warnings: warnings as string[] } : {}),
    ...(config.esbuild.metafile && result?.metafile ? { metafile: result.metafile } : {}),
  }

  return [finalResult, resultValue]
}

// =============================================================================
// Handler
// =============================================================================

export async function Handler(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const redis = c.get('redis')

  // Parse and validate query
  const rawQuery = Object.fromEntries(url.searchParams)
  const parseResult = BundleQuerySchema.safeParse(rawQuery)
  
  if (!parseResult.success) {
    return c.json({ error: 'Invalid query parameters', details: parseResult.error.flatten() }, 400)
  }

  const query = parseResult.data
  const normalized = normalizeBundleQuery(query)

  // Resolve package versions
  const rootPkg = (normalized.config['package.json'] ?? {}) as Record<string, Record<string, string>>
  const dependencies = {
    ...rootPkg.devDependencies,
    ...rootPkg.peerDependencies,
    ...rootPkg.dependencies,
  }

  const versionResults = await Promise.allSettled(
    normalized.modules
      .filter(([pkg]) => !/^https?:\/\//.test(pkg))
      .map(async ([pkg, mode]) => {
        const { name = pkg, version, path } = parsePackageName(pkg, { ignoreError: true })
        const resolvedVersion = await resolveVersion(
          dependencies[name] ? `${name}@${dependencies[name]}` : pkg
        )
        return [name, resolvedVersion ?? version, path, mode] as const
      })
  )

  const versions: string[] = []
  const modules: Array<[string, 'import' | 'export']> = []

  for (const result of versionResults) {
    if (result.status === 'fulfilled' && result.value) {
      const [name, ver, path, mode] = result.value
      versions.push(`${name}@${ver}`)
      modules.push([`${name}@${ver}${path}`, mode as 'import' | 'export'])
    }
  }

  // Build cache key
  const configObj: BundleConfig = deepMerge(
    deepMerge(
      deepMerge(
        { ...BUILD_CONFIG },
        {
          polyfill: normalized.polyfill,
          compression: createCompressConfig(normalized.config.compression as Parameters<typeof createCompressConfig>[0]),
        }
      ),
      normalized.config
    ),
    {
      esbuild: {
        ...(normalized.metafile ? { metafile: true } : {}),
        ...(normalized.minify !== null ? { minify: normalized.minify } : {}),
        ...(normalized.sourcemap ? { sourcemap: normalized.sourcemap } : {}),
        ...(normalized.format ? { format: normalized.format } : {}),
      },
      init: {
        platform: 'deno-wasm',
        worker: false,
      },
    }
  ) as BundleConfig

  configObj.entryPoints = [`/index${normalized.tsx ? '.tsx' : '.ts'}`]

  const jsonKeyObj = {
    ...configObj,
    versions,
    modules,
    initialValue: normalized.inputCode.trim(),
  }
  const jsonKey = `json/${JSON5.stringify(jsonKeyObj).trim()}`

  // Check mutation queries (things that affect cache validity)
  const hasMutationQueries = Boolean(
    query.share ||
    query.text ||
    query.minify !== undefined ||
    query.pretty !== undefined ||
    query.polyfill ||
    query.tsx ||
    query.jsx ||
    query.format ||
    query.config ||
    query.sourcemap
  )

  // Try cache first
  const badgeKey = `badge/${jsonKey}`
  const badgeID = JSON5.stringify({ ...jsonKeyObj, badge: {} }).trim()

  const cached = await getCachedResult(
    redis,
    jsonKey,
    badgeKey,
    badgeID,
    modules,
    normalized.exportAll,
    hasMutationQueries
  )

  if (cached) {
    console.log('[bundle] Returning cached result')
    return c.json(cached)
  }

  // Initialize WASM if needed
  if (!WASM_MODULE) {
    WASM_MODULE = await ESBUILD_WASM()
  }
  if (!wasmModule) {
    wasmModule = new WebAssembly.Module(WASM_MODULE as BufferSource)
  }

  // Create unique entry point
  const inputFileHash = await hashString(jsonKey)
  const finalConfig: BundleConfig = {
    ...configObj,
    entryPoints: [`/index.${inputFileHash}${normalized.tsx ? '.tsx' : '.ts'}`],
    init: {
      ...configObj.init,
      wasmModule,
    },
  }

  // Perform bundle
  const searchQueries = url.search || `?q=${query.q ?? query.query ?? 'spring-easing'}`
  
  try {
    const [result, _resultText] = await performBundle(
      normalized.inputCode,
      finalConfig,
      versions,
      modules,
      searchQueries
    )

    // Cache result
    await setCachedResult(redis, jsonKey, result, modules, normalized.exportAll, hasMutationQueries)

    console.log('[bundle] Returning fresh result')
    return c.json(result)
  } catch (error) {
    console.error('[bundle] Build failed:', error)
    
    if (error && typeof error === 'object' && 'msgs' in error) {
      return c.json({ error: 'Build failed', messages: (error as { msgs: string[] }).msgs }, 400)
    }
    
    return c.json({ error: String(error) }, 400)
  }
}

export default Handler