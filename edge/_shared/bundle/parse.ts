// _shared/bundle/parse.ts
/**
 * Query Parameter Parsing
 *
 * Parses URL query parameters into bundle configuration.
 * Handles the various input formats:
 * - q/query: Module specifiers
 * - treeshake: Export/import selections
 * - share: LZ-compressed code
 * - text: Plain text code
 * - config: JSON5 configuration
 *
 * @module
 */

import type { BundleConfig, ModuleSpec, ParsedQueryConfig } from './types.ts'
import type { PackageJson } from '@bundle/utils/types'

// Core utilities from @bundle/utils (barrel export)
import { deepMerge, parsePackageName, resolveVersion } from '@bundle/utils'

// Path utilities
import { basename, extname } from '@bundle/utils/path'

// JSON5 from utils
import JSON5 from '@bundle/utils/json5'

// Compression config
import { createCompressConfig } from '@bundle/compress'

// Build config from core
import { BUILD_CONFIG } from '@bundle/core'

import { decompressFromURL } from '@bundle/utils/lz-string'
import { getLogger } from '@logtape/logtape'

const logger = getLogger(['bundle', 'parse'])

// =============================================================================
// Constants
// =============================================================================

/** Default query value when none provided */
const DEFAULT_QUERY = 'spring-easing'

/** Default input code template */
export const DEFAULT_INPUT_CODE = [
	'export * from "spring-easing";',
	'export { default } from "spring-easing";',
].join('\n')

// =============================================================================
// Public API
// =============================================================================

/**
 * Parse URL into bundle configuration.
 *
 * This is the main entry point for query parsing. It handles all
 * the various query parameter formats and resolves package versions.
 *
 * @param url - Request URL with query parameters
 * @returns Parsed configuration ready for bundling
 *
 * @example
 * ```ts
 * const url = new URL('https://api.bundlejs.com/?q=react&treeshake=[useState]')
 * const parsed = await parseQueryToConfig(url)
 * // => { inputCode: '...', config: {...}, versions: ['react@18.2.0'], modules: [...] }
 * ```
 */
export async function parseQueryToConfig(url: URL): Promise<ParsedQueryConfig> {
	const searchParams = url.searchParams

	// Parse input code from various sources
	const inputCode = parseInputCode(url) || DEFAULT_INPUT_CODE

	// Parse base configuration from ?config parameter
	const userConfig = parseConfigParam(url) || {}

	// Extract config values we need to filter out from the final config
	const {
		init: _init,
		entryPoints: _entryPoints,
		ansi: _ansi,
		...filteredUserConfig
	} = userConfig as BundleConfig & { ansi?: unknown }

	// Determine feature flags from query params
	const tsxQuery = searchParams.has('tsx') || searchParams.has('jsx')
	const metafileQuery = searchParams.has('metafile') || url.pathname === '/metafile'
	const analysisQuery =
		searchParams.has('analysis') ||
		searchParams.has('analyze') ||
		['/analysis', '/analyze'].includes(url.pathname)
	const polyfill = searchParams.has('polyfill')

	// Parse formatting options
	const minify = parseMinifyOption(url, filteredUserConfig)
	const sourcemap = parseSourcemapOption(url, filteredUserConfig)
	const format = parseFormatOption(url, filteredUserConfig)

	// Determine if metafile should be enabled
	const enableMetafile = analysisQuery || metafileQuery || Boolean(filteredUserConfig?.analysis)

	// Build the configuration object
	const config: BundleConfig = deepMerge(
		deepMerge(
			deepMerge(Object.assign({}, BUILD_CONFIG), {
				polyfill,
				compression: createCompressConfig(filteredUserConfig.compression),
			}),
			filteredUserConfig
		),
		{
			esbuild: Object.assign(
				{},
				enableMetafile ? { metafile: enableMetafile } : {},
				minify !== null ? { minify } : {},
				sourcemap !== null ? { sourcemap } : {},
				format !== null ? { format } : {}
			),
			init: {
				platform: 'deno-wasm',
				worker: false,
			},
			tsx: tsxQuery || filteredUserConfig.tsx,
		} as BundleConfig
	)

	// Resolve versions and modules
	const { versions, modules } = await resolveModules(url, config)

	return {
		inputCode,
		config,
		versions,
		modules,
	}
}

/**
 * Parse the input code from query parameters.
 *
 * Priority:
 * 1. Generated from q/query + treeshake parameters
 * 2. Decompressed from share parameter
 * 3. Parsed from text parameter
 *
 * @param url - Request URL
 * @returns Input code string or null
 */
export function parseInputCode(url: URL): string | null {
	try {
		const searchParams = url.searchParams
		let result = ''

		// Parse q/query parameter into export/import statements
		const query = searchParams.get('query') || searchParams.get('q')
		const treeshake = searchParams.get('treeshake')

		if (query) {
			const queryArr = query.trim().split(',')
			const treeshakeArr = parseTreeshakeExports((treeshake ?? '').trim())
			const counts = new Map<string, number>()

			result +=
				'// Click Build for the Bundled, Minified & Compressed package size\n' +
				queryArr
					.map((q, i) => {
						const treeshakeExports =
							treeshakeArr[i] && treeshakeArr[i].trim() !== '*'
								? treeshakeArr[i].trim().split(',').join(', ')
								: '*'

						const [, , declaration = 'export', module] = /^(\((.*)\))?(.*)/.exec(q)!

						// Track duplicate modules for unique naming
						if (!counts.has(module)) counts.set(module, 0)
						const count = counts.set(module, counts.get(module)! + 1).get(module)! - 1
						const countStr = count <= 0 ? '' : count

						// Generate export/import statement
						const stmt = `${declaration} ${treeshakeExports} from ${JSON5.stringify(module)};`

						// Add default export if no treeshake specified
						if ((treeshake ?? '').trim().length <= 0) {
							const defaultName =
								declaration === 'import' || queryArr.length > 1
									? `as ${getModuleName(module)}Default${countStr} `
									: ''
							return `${stmt}\n${declaration} { default ${defaultName}} from ${JSON5.stringify(module)};`
						}

						return stmt
					})
					.join('\n')
		}

		// Decompress share parameter
		const share = searchParams.get('share')
		if (share) {
			result += '\n' + decompressFromURL(share.trim())
		}

		// Parse text parameter
		const plaintext = searchParams.get('text')
		if (plaintext) {
			result +=
				'\n' +
				JSON5.parse(
					// Support both quoted and unquoted text
					/^["']/.test(plaintext) && /["']$/.test(plaintext)
						? plaintext
						: JSON5.stringify('' + plaintext).replace(/\\\\/g, '\\')
				)
		}

		return result.trim() || null
	} catch (e) {
    logger.warn(new Error('[parseInputCode] Error:', { cause: e }))
		return null
	}
}

/**
 * Parse the config query parameter.
 *
 * @param url - Request URL
 * @returns Parsed configuration or null
 */
export function parseConfigParam(url: URL): Partial<BundleConfig> | null {
	try {
		const config = url.searchParams.get('config') ?? '{}'
		return deepMerge({}, JSON5.parse(config || '{}'))
	} catch (e) {
    logger.warn(new Error('[parseConfigParam] Error:', { cause: e }))
		return null
	}
}

// =============================================================================
// Treeshake Parsing
// =============================================================================

/**
 * Parse treeshake exports syntax.
 *
 * Supports bracket-delimited exports per package:
 * ```
 * "[{ x,y,z }],[*],[* as X]" → ["{ x,y,z }", "*", "* as X"]
 * ```
 *
 * @param str - Treeshake parameter value
 * @returns Array of export specifications
 */
export function parseTreeshakeExports(str: string): string[] {
	return (str ?? '').split(/\],/).map((s) => s.replace(/\[|\]/g, ''))
}

/**
 * Check if treeshake represents "export all" pattern.
 *
 * Export all is when:
 * - No treeshake specified
 * - All entries are `*` or `{ default }`
 *
 * @param treeshakeArr - Parsed treeshake array
 * @returns true if this represents export all
 */
export function isExportAll(treeshakeArr: string[]): boolean {
	const unique = Array.from(new Set(treeshakeArr))
	return unique.every((x) => /\*|{\s?default\s?}/.test(x))
}

// =============================================================================
// Module Resolution
// =============================================================================

/**
 * Resolve package versions from query parameters.
 *
 * @param url - Request URL
 * @param config - Parsed configuration
 * @returns Resolved versions and module specs
 */
async function resolveModules(
	url: URL,
	config: BundleConfig
): Promise<{ versions: string[]; modules: ModuleSpec[] }> {
	const searchParams = url.searchParams

	const hasQuery = searchParams.has('q') || searchParams.has('query')
	const shareQuery = searchParams.get('share')
	const textQuery = searchParams.get('text')

	const query = (searchParams.get('q') || searchParams.get('query')) ?? DEFAULT_QUERY

	// Get dependencies from config's package.json
	const rootPkg = (config['package.json'] ?? {}) as PackageJson
	const dependencies = Object.assign(
		{},
		rootPkg.devDependencies,
		rootPkg.peerDependencies,
		rootPkg.dependencies
	)

	// Skip resolution if no query and using share/text
	if (!hasQuery && (shareQuery || textQuery)) {
		return { versions: [], modules: [] }
	}

	// Parse query into module specs
	const querySpecs = query
		.split(',')
		.map((x) => {
			const declaration = /^\((\w+)\)/.exec(x)?.[1] ?? 'export'
			const module = x.replace(/^\((\w+)\)/, '')
			return [module, declaration] as const
		})
		.filter(([module]) => !/^https?:\/\//.exec(module))

	// Resolve versions in parallel
	const versionResults = await Promise.allSettled(
		querySpecs.map(async ([pkgName, declaration]) => {
			const { name = pkgName, version, path } = parsePackageName(pkgName, { ignoreError: true })
			const depVersion = dependencies[name]
			const resolvedVersion =
				(await resolveVersion(depVersion ? `${name}@${depVersion}` : pkgName)) ?? version

			return [name, resolvedVersion, path, declaration] as const
		})
	)

	// Collect successful resolutions
	const versions: string[] = []
	const modules: ModuleSpec[] = []

	for (const result of versionResults) {
		if (result.status === 'fulfilled' && result.value) {
			const [name, ver, path, declaration] = result.value
			versions.push(`${name}@${ver}`)
			modules.push([`${name}@${ver}${path}`, declaration as 'import' | 'export'])
		}
	}

	return { versions, modules }
}

// =============================================================================
// Option Parsing Helpers
// =============================================================================

/**
 * Parse minify/pretty options from URL.
 */
function parseMinifyOption(url: URL, config: Partial<BundleConfig>): boolean | null {
	const searchParams = url.searchParams
	const minifyQuery = searchParams.has('minify')
	const prettyQuery = searchParams.has('pretty')

	if (!minifyQuery && !prettyQuery) {
		return null
	}

	const minifyResult = searchParams.get('minify')
	const prettyResult = searchParams.get('pretty')

	if (minifyQuery) {
		return minifyResult?.length === 0 ? true : convertQueryValue(minifyResult) as boolean
	}

	if (prettyQuery) {
		const prettyValue = prettyResult?.length === 0 ? true : convertQueryValue(prettyResult)
		return !prettyValue
	}

	return config?.esbuild?.minify ?? null
}

/**
 * Parse sourcemap option from URL.
 */
function parseSourcemapOption(
	url: URL,
	config: Partial<BundleConfig>
) {
	const searchParams = url.searchParams

	if (!searchParams.has('sourcemap')) {
		return null
	}

	const result = searchParams.get('sourcemap')
	const value = convertQueryValue(result)

	if (typeof value === 'boolean') return value
	if (value === 'inline' || value === 'external' || value === 'both') return value

	return config?.esbuild?.sourcemap ?? null
}

/**
 * Parse format option from URL.
 */
function parseFormatOption(url: URL, config: Partial<BundleConfig>): string | null {
	const searchParams = url.searchParams

	if (!searchParams.has('format')) {
		return config?.esbuild?.format ?? null
	}

	return searchParams.get('format')
}

/**
 * Convert query string value to typed value.
 */
function convertQueryValue(str?: string | null): boolean | string | null {
	if (str === 'false') return false
	if (str === 'true') return true
	return str ?? null
}

// =============================================================================
// Module Name Helpers
// =============================================================================

/**
 * Get basename without extension from a path.
 */
function fromBasename(path: string): string {
	return basename(path.replace(/^https?:\/\//, ''), extname(path))
}

/**
 * Convert module specifier to a valid identifier name.
 *
 * @example
 * getModuleName('@okikio/animate') // => 'okikioAnimate'
 * getModuleName('react-dom') // => 'reactDom'
 */
export function getModuleName(str: string): string {
	const { name, path } = parsePackageName(str, { ignoreError: true })
	let _str = str

	if (/^https?:\/\//.test(str)) {
		_str = fromBasename(str)
	} else if (name.length > 0) {
		_str = name + (path ? fromBasename(path) : '')
	}

	return _str
		.split(/(?:-|_|\/)/g)
		.map((x, i) => (i > 0 && x.length > 0 ? x[0].toUpperCase() + x.slice(1) : x))
		.join('')
		.replace(/[^\w\s]/gi, '')
}