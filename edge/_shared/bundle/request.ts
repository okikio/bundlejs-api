/**
 * Bundle Request Orchestration
 *
 * Unifies parsing, cache lookup, and bundle execution for endpoints.
 *
 * Flow:
 * +---------+   +---------+   +---------+   +-----------+
 * | Input   |-->| Parse   |-->| Cache   |-->| Execute   |
 * +---------+   +---------+   +---------+   +-----------+
 */

import type { BundleRequestInput } from './parse.ts'
import type { BundleResult, BundleConfig, ModuleSpec, CacheMode } from './types.ts'

import { parseInputToConfig } from './parse.ts'
import { executeBundle, executeBundleWithOutput } from './service.ts'
import { generateCacheKey, generateEntryPointHash } from '../cache/keys.ts'
import { getCachedResult, setCachedResult } from '../cache/operations.ts'

export type BundleResolution = {
	url: URL
	cacheKey: string
	cached: boolean
	durationMs: number
	result: BundleResult
	outputText?: string
	config: BundleConfig
	inputCode: string
	modules: ModuleSpec[]
	versions: string[]
}

export interface ResolveBundleOptions {
	input: BundleRequestInput
	baseUrl: string
	cacheMode: CacheMode
	includeOutputText?: boolean | 'auto'
}

export async function resolveBundleRequest(
	options: ResolveBundleOptions
): Promise<BundleResolution> {
	const { input, baseUrl, cacheMode, includeOutputText = false } = options
	const startTime = performance.now()

	const { inputCode, config, modules, versions, url } = await parseInputToConfig(input, baseUrl)
	const wantsOutputText = includeOutputText === 'auto'
		? shouldIncludeOutputText(url)
		: includeOutputText

	const cacheKey = await generateCacheKey(config, modules, versions, inputCode)
	const entryPointHash = await generateEntryPointHash(cacheKey)

	const canReadCache = cacheMode === 'use' && !wantsOutputText

	if (canReadCache) {
		const cached = await getCachedResult(cacheKey)
		if (cached) {
			return {
				url,
				cacheKey,
				cached: true,
				durationMs: performance.now() - startTime,
				result: cached,
				config,
				inputCode,
				modules,
				versions,
			}
		}
	}

	const query = (url.searchParams.get('q') || url.searchParams.get('query')) ?? 'spring-easing'

	let result: BundleResult
	let outputText: string | undefined

	if (wantsOutputText) {
		const [bundleResult, rawOutput] = await executeBundleWithOutput({
			config,
			inputCode,
			entryPointHash,
			url,
			versions,
			modules,
			query,
		})

		result = bundleResult
		outputText = rawOutput
	} else {
		result = await executeBundle({
			config,
			inputCode,
			entryPointHash,
			url,
			versions,
			modules,
			query,
		})
	}

	if (cacheMode !== 'bypass') {
		await setCachedResult(cacheKey, result)
	}

	return {
		url,
		cacheKey,
		cached: false,
		durationMs: performance.now() - startTime,
		result,
		outputText,
		config,
		inputCode,
		modules,
		versions,
	}
}

function shouldIncludeOutputText(url: URL): boolean {
	return url.searchParams.has('file') || url.pathname === '/file'
}
