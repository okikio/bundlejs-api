/**
 * Legacy Bundle Response Builder
 *
 * Produces legacy response formats (HTML, JS, raw JSON, badges) from a bundle result.
 * This preserves behavior for old paths like /, /file, /analysis, /warnings, /raw.
 *
 * Flow:
 * +---------+   +-----------------+   +-------------------+
 * | Result  |-->| Detect mode     |-->| Format response   |
 * +---------+   | (badge/file/...)|   | (HTML/JS/JSON)    |
 *               +-----------------+   +-------------------+
 */

import type { BundleResult, BundleConfig, ModuleSpec } from './types.ts'

import { ansi } from '@bundle/utils'
import { decodeBase64 } from '@bundle/utils/encoding'
import { getEsbuild } from '@bundle/core'

import { generateBadge } from '../external/shields.ts'
import { getBadgeKey, generateBadgeId } from '../bundle/key.ts'
import { getCachedBadge, setCachedBadge } from '../cache/operations.ts'
import { API_DOCS } from './schema.ts'

import styleText from './style.ts'

export type LegacyResponseOptions = {
	url: URL
	result: BundleResult
	outputText?: string
	cached: boolean
	durationMs: number
	cacheKey: string
}

export async function generateLegacyResponse(
	options: LegacyResponseOptions
): Promise<Response> {
	const { url, result, outputText, cached, durationMs, cacheKey } = options
	const path = url.pathname
	const noCache = ['/no-cache', '/clear-cache', '/delete-cache'].includes(path)

	const analysisQuery =
		url.searchParams.has('analysis') ||
		url.searchParams.has('analyze') ||
		['/analysis', '/analyze'].includes(path) ||
		path.endsWith('/analysis') ||
		path.endsWith('/analyze')

	const analysisResult = url.searchParams.get('analysis') || url.searchParams.get('analyze')

	const metafileQuery = url.searchParams.has('metafile') || path.endsWith('/metafile')
	const fileQuery = url.searchParams.has('file') || path.endsWith('/file')

	const badgeQuery = url.searchParams.has('badge') || ['/badge', '/badge/raster', '/badge-raster'].includes(path) || path.endsWith('/badge') || path.endsWith('/badge/raster') || path.endsWith('/badge-raster')
	const warningsQuery = url.searchParams.has('warnings') || url.searchParams.has('warning') || path.endsWith('/warnings')
	const rawQuery = url.searchParams.has('raw') || path.endsWith('/raw')

	const badgeResult = url.searchParams.get('badge')
	const badgeStyle = url.searchParams.get('badge-style')
	const badgeRasterQuery = url.searchParams.has('badge-raster') || url.searchParams.has('png') || ['/badge/raster', '/badge-raster'].includes(path) || path.endsWith('/badge/raster') || path.endsWith('/badge-raster')
	const query = (url.searchParams.get('q') || url.searchParams.get('query')) ?? 'spring-easing'

	if (badgeQuery) {
		const keyObj = buildLegacyKeyObject(result)
		const badgeKey = getBadgeKey(cacheKey)
		const badgeId = generateBadgeId(keyObj, {
			raster: badgeRasterQuery,
			result: badgeResult,
			style: badgeStyle,
		})

		const cachedBadge = await getCachedBadge(badgeKey, badgeId)
		if (cachedBadge) {
			return new Response(badgeRasterQuery ? decodeBase64(cachedBadge) : cachedBadge, {
				status: 200,
				headers: {
					'Cache-Control': 'max-age=36, public',
					'Content-Type': badgeRasterQuery ? 'image/png' : 'image/svg+xml',
				},
			})
		}

		const badgeResponse = await generateBadge({
			result,
			url,
			detail: badgeResult,
			style: badgeStyle,
			raster: badgeRasterQuery,
			query,
		})

		if (!badgeResponse.ok || !badgeResponse.badge) {
			return new Response('Badge generation failed', {
				status: badgeResponse.timeout ? 504 : 502,
				headers: {
					'Content-Type': 'text/plain',
					'x-content-type-options': 'nosniff',
				},
			})
		}

		if (badgeResponse.isRaster) {
			const badgeBytes = badgeResponse.badge as Uint8Array
			const badgeCopy = Uint8Array.from(badgeBytes)
			const badgeBlob = new Blob([badgeCopy])

			await setCachedBadge(badgeKey, badgeId, badgeResponse.base64 ?? '')
			return new Response(badgeBlob, {
				status: 200,
				headers: {
					'Cache-Control': 'max-age=30, public',
					'Content-Type': 'image/png',
				},
			})
		}

		await setCachedBadge(badgeKey, badgeId, badgeResponse.badge as string)
		return new Response(badgeResponse.badge as string, {
			status: 200,
			headers: {
				'Cache-Control': 'max-age=30, public',
				'Content-Type': 'image/svg+xml',
			},
		})
	}

	if (fileQuery) {
		const fileResult = outputText ?? ' '
		return new Response(fileResult, {
			status: 200,
			headers: {
				'Cache-Control': `max-age=${noCache ? 30 : 720}, public`,
				'Content-Type': 'text/javascript',
			},
		})
	}

	if (analysisQuery && result.metafile) {
		const { analyzeMetafile } = await getEsbuild()
		const verboseAnalysis = analysisResult === 'verbose'

		const analysis = await analyzeMetafile(result.metafile, {
			color: true,
			verbose: verboseAnalysis,
		})

		return new Response(generateHtmlMessages([ansi(analysis)]), {
			status: 200,
			headers: {
				'Cache-Control': `max-age=${noCache ? 30 : 180}, public`,
				'Content-Type': 'text/html',
			},
		})
	}

	if (metafileQuery && result.metafile) {
		return new Response(JSON.stringify(result.metafile), {
			status: 200,
			headers: {
				'Cache-Control': `max-age=${noCache ? 30 : 180}, public`,
				'Content-Type': 'application/json',
			},
		})
	}

	if (warningsQuery) {
		return new Response(generateHtmlMessages(result.warnings ?? ['No warnings for this bundle']), {
			status: 200,
			headers: {
				'Cache-Control': 'max-age=30, public',
				'Content-Type': 'text/html',
			},
		})
	}

	if (rawQuery) {
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: {
				'Cache-Control': 'max-age=30, public',
				'Content-Type': 'application/json',
			},
		})
	}

	const { metafile: _metafile, warnings: _warnings, ...usefulInfo } = result
	const addDocs = url.search === '' ? API_DOCS : {}
	const cachedTiming = cached ? {
		time: formatDuration(durationMs),
		rawTime: durationMs,
	} : null

	const finalResult = Object.assign({}, usefulInfo, addDocs, cachedTiming ?? {})

	return new Response(JSON.stringify(finalResult), {
		status: 200,
		headers: {
			'Cache-Control': 'max-age=720, public',
			'Content-Type': 'application/json',
		},
	})
}

export function generateHtmlMessages(msgs: string[]): string {
	return [
		`<style>${styleText}</style>`,
		`<pre>${msgs.join('\n')}</pre>`,
	].join('')
}

function buildLegacyKeyObject(result: BundleResult): Record<string, unknown> {
	const config = result.config as BundleConfig
	const versions = result.versions ?? (result.version ? [result.version] : [])
	const modules = result.modules ?? [] as ModuleSpec[]

	return Object.assign({}, config, {
		versions,
		modules,
		initialValue: result.input.trim(),
	})
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000
	return `${seconds.toFixed(1)}s`
}
