// _shared/bundle/service.ts
/**
 * Bundle Service
 *
 * Core orchestrator for the bundling operation. Coordinates:
 * - WASM module loading
 * - Build execution via @bundle/core
 * - Output compression
 * - Result assembly
 * 
 * Wraps esbuild-wasm with:
 * - Virtual filesystem setup
 * - Config normalization
 * - Error mapping to problem responses
 * - Timing instrumentation
 *
 * @module
 */
import type {
	BundleConfig,
	BundleResult,
	BundleExecutionOptions,
	ModuleSpec,
	CompressionSize,
} from './types.ts'

// Core build utilities from @bundle/core
import { build, setFile, useFileSystem, createConfig, createNotice } from '@bundle/core'

// Compression from @bundle/compress
import { compress } from '@bundle/compress'

// Local utilities
import { getWasmModule } from './wasm.ts'
import { generateEntryPointHash } from './key.ts'

import { getLogger } from '@logtape/logtape'

const logger = getLogger(['bundle', 'service'])

// =============================================================================
// Time Formatting
// =============================================================================

/**
 * Formatter for human-readable duration strings.
 */
const timeFormatter = new Intl.RelativeTimeFormat('en', {
	style: 'narrow',
	numeric: 'auto',
})

/**
 * Format duration in milliseconds to human-readable string.
 */
export function formatDuration(ms: number): string {
	return timeFormatter.format(ms / 1000, 'seconds')
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Execute a bundle operation.
 *
 * This is the main entry point for bundling. It handles:
 * 1. WASM module initialization (cached after first load)
 * 2. Virtual filesystem setup
 * 3. Build execution
 * 4. Output compression
 * 5. Result assembly
 *
 * @param options - Bundle execution options
 * @returns Bundle result with all metadata
 *
 * @example
 * ```ts
 * const result = await executeBundle({
 *   config: {
 *     esbuild: { format: 'esm', minify: true },
 *     compression: { type: 'gzip' },
 *   },
 *   inputCode: 'export * from "react";',
 *   entryPointHash: 'abc123',
 * })
 *
 * console.log(result.size.compressedSize) // "12.3 kB"
 * ```
 */
export async function executeBundle(
	options: BundleExecutionOptions & {
		url: URL
		versions: string[]
		modules: ModuleSpec[]
		query: string
	}
): Promise<BundleResult> {
	const { config, inputCode, entryPointHash, url, versions, modules, query } = options

	const start = performance.now()

	// Get the WASM module (cached after first load)
	const wasmModule = await getWasmModule()

	// Get the virtual filesystem
	const FileSystem = useFileSystem()
	const fs = await FileSystem

	// Determine entry point path
  const _entryPoints = config.entryPoints
  const _entryPoint = Array.isArray(_entryPoints)
    ? _entryPoints[0]
    : typeof _entryPoints === 'string'
    ? _entryPoints
			: (_entryPoints as { in: string }).in
	
	const isTsx = config.tsx || _entryPoint?.toString().endsWith('.tsx')
	const extension = isTsx ? '.tsx' : '.ts'
  const entryPointPath = `/index.${entryPointHash}${extension}`
  
  logger.debug('Writing input file', {
    isTsx,
    extension,
    entryPointHash,
    inputCodeLength: inputCode.length,
  })

	// Set the entry point file in the virtual filesystem
	setFile(fs, entryPointPath, inputCode)

	// Build the final config with WASM module
	const buildConfig: BundleConfig = {
		...config,
		entryPoints: [entryPointPath],
		init: {
			...config.init,
			wasmModule,
		},
  }

  logger.debug('Starting bundle', buildConfig)
  
	// Execute the build
	const buildResult = await build(buildConfig, FileSystem)
  const end = performance.now()
    
  logger.debug('Bundle complete', {
    duration_ms: (end - start).toFixed(2),
    output_size: buildResult.outputFiles?.length,
  })

	// Clear the filesystem after build
	await fs?.clear?.()

	// Get the bundled output text
	let resultText = buildResult.contents[0]?.text ?? ''

	// Determine the entry point input file for matching
	const entryPoints = buildConfig.entryPoints
	const entryPointInputFile = Array.isArray(entryPoints)
		? entryPoints[0]
		: typeof entryPoints === 'object' && 'in' in entryPoints
			? entryPoints.in
			: entryPoints

	// Compress the output
	const compressionResult = await compress(
		buildResult.contents.map((x: { contents: Uint8Array; path: string; text: string }) => {
			// Capture the text from the matching entry point
			if (x.path === entryPointInputFile) {
				resultText = x.text
			}
			return x.contents
		}),
		config.compression
	)

	// Extract size info (excluding content)
	const { content: _content, ...sizeInfo } = compressionResult
	const size = sizeInfo as CompressionSize

	// Create printable config (without init)
	const { init: _init, ...printableConfig } = createConfig('build', buildConfig)

	// Process warnings
	const [warnings] = (
		await Promise.allSettled([createNotice(buildResult.warnings, 'warning', false)])
	).map((res) => (res.status === 'fulfilled' ? res.value : null))

	// Calculate duration
	const duration = end - start

	// Deduplicate versions and modules
	const versionsArr = Array.from(new Set(versions))
	const modulesArr = Array.from(new Set(modules.map((m) => JSON.stringify(m)))).map(
		(s) => JSON.parse(s) as ModuleSpec
	)

	// Check for metafile query
	const metafileQuery = url.searchParams.has('metafile')
	const analysisQuery = url.searchParams.has('analysis') || url.searchParams.has('analyze')
	const enableMetafile = analysisQuery || metafileQuery || Boolean(config?.esbuild?.metafile)

	// Build the search queries string
	const searchQueries = url.search || `?q=${query}`

	// Assemble the result
	const result: BundleResult = {
		query: decodeURIComponent(searchQueries),
		rawQuery: encodeURIComponent(searchQueries),
		...(versionsArr.length === 1 ? { version: versionsArr[0] } : { versions: versionsArr }),
		modules: modulesArr,
		config: printableConfig as Omit<BundleConfig, 'init'>,
		input: inputCode,
		size,
		installSize: {
			total: Number(buildResult?.totalInstallSize),
			packages: buildResult?.packageSizeArr.map(([name, size]) => ({ name, size: Number(size) })),
		},
		time: formatDuration(duration),
		rawTime: duration,
		...(buildResult?.warnings?.length > 0 ? { warnings: warnings as string[] } : null),
		...(enableMetafile && buildResult?.metafile ? { metafile: buildResult.metafile } : null),
  }
  
  logger.info('Bundle + Compress complete', {
    duration_ms: duration.toFixed(2),
    output_size: `${_content?.length || 0} file(s)`,
    size,
    result
  })

	return result
}

/**
 * Execute a bundle and return the result with the raw output text.
 *
 * This variant returns both the result object and the raw bundled code,
 * which is needed for file responses and caching.
 *
 * @param options - Bundle execution options
 * @returns Tuple of [result, rawOutputText]
 */
export async function executeBundleWithOutput(
	options: BundleExecutionOptions & {
		url: URL
		versions: string[]
		modules: ModuleSpec[]
		query: string
	}
): Promise<[BundleResult, string]> {
	const { config, inputCode, entryPointHash, url, versions, modules, query } = options

	const start = performance.now()

	// Get the WASM module (cached after first load)
	const wasmModule = await getWasmModule()

	// Get the virtual filesystem
	const FileSystem = useFileSystem()
	const fs = await FileSystem

	// Determine entry point path
  const _entryPoints = config.entryPoints
  const _entryPoint = Array.isArray(_entryPoints)
    ? _entryPoints[0]
    : typeof _entryPoints === 'string'
    ? _entryPoints
			: (_entryPoints as { in: string }).in
	
	const isTsx = config.tsx || _entryPoint?.toString().endsWith('.tsx')
	const extension = isTsx ? '.tsx' : '.ts'
	const entryPointPath = `/index.${entryPointHash}${extension}`

	// Set the entry point file in the virtual filesystem
	setFile(fs, entryPointPath, inputCode)

	// Build the final config with WASM module
	const buildConfig: BundleConfig = {
		...config,
		entryPoints: [entryPointPath],
		init: {
			...config.init,
			wasmModule,
		},
	}

	// Execute the build
	const buildResult = await build(buildConfig, FileSystem)
	const end = performance.now()

	// Clear the filesystem after build
	await fs?.clear?.()

	// Get the bundled output text
	let resultText = buildResult.contents[0]?.text ?? ''

	// Determine the entry point input file for matching
	const entryPoints = buildConfig.entryPoints
	const entryPointInputFile = Array.isArray(entryPoints)
		? entryPoints[0]
		: typeof entryPoints === 'object' && 'in' in entryPoints
			? entryPoints.in
			: entryPoints

	// Compress the output
	const compressionResult = await compress(
		buildResult.contents.map((x: { contents: Uint8Array; path: string; text: string }) => {
			// Capture the text from the matching entry point
			if (x.path === entryPointInputFile) {
				resultText = x.text
			}
			return x.contents
		}),
		config.compression
	)

	// Extract size info (excluding content)
	const { content: _content, ...sizeInfo } = compressionResult
	const size = sizeInfo as CompressionSize

	// Create printable config (without init)
	const { init: _init, ...printableConfig } = createConfig('build', buildConfig)

	// Process warnings
	const [warnings] = (
		await Promise.allSettled([createNotice(buildResult.warnings, 'warning', false)])
	).map((res) => (res.status === 'fulfilled' ? res.value : null))

	// Calculate duration
	const duration = end - start

	// Deduplicate versions and modules
	const versionsArr = Array.from(new Set(versions))
	const modulesArr = Array.from(new Set(modules.map((m) => JSON.stringify(m)))).map(
		(s) => JSON.parse(s) as ModuleSpec
	)

	// Check for metafile query
	const metafileQuery = url.searchParams.has('metafile')
	const analysisQuery = url.searchParams.has('analysis') || url.searchParams.has('analyze')
	const enableMetafile = analysisQuery || metafileQuery || Boolean(config?.esbuild?.metafile)

	// Build the search queries string
	const searchQueries = url.search || `?q=${query}`

	// Assemble the result
	const result: BundleResult = {
		query: decodeURIComponent(searchQueries),
		rawQuery: encodeURIComponent(searchQueries),
		...(versionsArr.length === 1 ? { version: versionsArr[0] } : { versions: versionsArr }),
		modules: modulesArr,
		config: printableConfig as Omit<BundleConfig, 'init'>,
		input: inputCode,
		size,
		installSize: {
			total: Number(buildResult?.totalInstallSize),
			packages: buildResult?.packageSizeArr.map(([name, size]) => ({ name, size: Number(size) })),
		},
		time: formatDuration(duration),
		rawTime: duration,
		...(buildResult?.warnings?.length > 0 ? { warnings: warnings as string[] } : null),
		...(enableMetafile && buildResult?.metafile ? { metafile: buildResult.metafile } : null),
	}

	return [result, resultText]
}

/**
 * Prepare bundle execution options from parsed query config.
 *
 * Helper to bridge parseQueryToConfig output to executeBundle input.
 *
 * @param url - Request URL
 * @param parsed - Output from parseQueryToConfig
 * @returns Options ready for executeBundle
 */
export async function prepareBundleOptions(
	url: URL,
	parsed: {
		inputCode: string
		config: BundleConfig
		versions: string[]
		modules: ModuleSpec[]
	}
): Promise<
	BundleExecutionOptions & {
		url: URL
		versions: string[]
		modules: ModuleSpec[]
		query: string
	}
> {
	const query = (url.searchParams.get('q') || url.searchParams.get('query')) ?? 'spring-easing'

	// Generate cache key for entry point hash
	const keyObj = {
		...parsed.config,
		versions: parsed.versions,
		modules: parsed.modules,
		initialValue: parsed.inputCode.trim(),
	}
	const entryPointHash = await generateEntryPointHash(JSON.stringify(keyObj))

	return {
		config: parsed.config,
		inputCode: parsed.inputCode,
		entryPointHash,
		url,
		versions: parsed.versions,
		modules: parsed.modules,
		query,
	}
}