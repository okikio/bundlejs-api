/**
 * Shields.io Badge Service
 *
 * Generates badges via the shields.io service with timeout handling
 * and graceful degradation.
 *
 * @module
 */
import type { BundleResult, BadgeStyle, BadgeDetail, CompressionSize } from '../bundle/types.ts'
import type { CompressionType } from '@bundle/compress'

import { encodeBase64 } from '@bundle/utils/encoding'

// =============================================================================
// Constants
// =============================================================================

/** Default timeout for shields.io requests (5 seconds) */
const DEFAULT_TIMEOUT_MS = 5000

/** Shields.io SVG endpoint */
const SHIELDS_SVG_HOST = 'img.shields.io'

/** Shields.io raster (PNG) endpoint */
const SHIELDS_RASTER_HOST = 'raster.shields.io'

// =============================================================================
// Types
// =============================================================================

/**
 * Badge generation options.
 */
export interface BadgeOptions {
	/** Bundle result containing size information */
	result: BundleResult

	/** Request URL for link generation */
	url: URL

	/** Badge detail level */
	detail?: BadgeDetail | string | null

	/** Badge style */
	style?: BadgeStyle | string | null

	/** Whether to generate raster (PNG) instead of SVG */
	raster?: boolean

	/** Query string for URL (used in badge link) */
	query?: string
}

/**
 * Badge generation result.
 */
export interface BadgeResponse {
	/** Whether the request succeeded */
	ok: boolean

	/** Badge content (SVG string or PNG Uint8Array) */
	badge?: string | Uint8Array

	/** Badge content as base64 (for PNG caching) */
	base64?: string

	/** True if the request timed out */
	timeout?: boolean

	/** HTTP status code */
	status?: number

	/** Error message if failed */
	error?: string

	/** Whether the badge is raster (PNG) */
	isRaster: boolean
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a badge from a bundle result.
 *
 * @param options - Badge generation options
 * @param timeoutMs - Request timeout in milliseconds
 * @returns Badge response with content or error
 *
 * @example
 * ```ts
 * const response = await generateBadge({
 *   result: bundleResult,
 *   url: requestUrl,
 *   detail: 'simple',
 *   style: 'flat',
 * })
 *
 * if (response.ok) {
 *   return new Response(response.badge, {
 *     headers: { 'Content-Type': response.isRaster ? 'image/png' : 'image/svg+xml' }
 *   })
 * }
 * ```
 */
export async function generateBadge(
	options: BadgeOptions,
	timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<BadgeResponse> {
	const { result, url, detail, style, raster = false, query } = options
	const { size } = result

	// Parse badge detail mode
	const detailStr = detail ?? ''
	const isMinified = /minify|minified/.test(detailStr)
	const isUncompressed = /uncompress/.test(detailStr)
	const isDetailed = /detail/.test(detailStr)

	// Build the badge URL
	const badgeUrl = buildBadgeUrl({
		size,
		modules: result.modules,
		query: query ?? (url.searchParams.get('q') || url.searchParams.get('query')) ?? 'spring-easing',
		requestUrl: url,
		isMinified,
		isUncompressed,
		isDetailed,
		style: style ?? undefined,
		raster,
	})

	// Fetch the badge with timeout
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

	try {
		const response = await fetch(badgeUrl, {
			signal: controller.signal,
		})

		clearTimeout(timeoutId)

		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				error: `Shields.io returned ${response.status}`,
				isRaster: raster,
			}
		}

		if (raster) {
			const buffer = await response.arrayBuffer()
			const badge = new Uint8Array(buffer)
			return {
				ok: true,
				badge,
				base64: encodeBase64(badge),
				isRaster: true,
			}
		} else {
			const badge = await response.text()
			return {
				ok: true,
				badge,
				isRaster: false,
			}
		}
	} catch (e) {
		clearTimeout(timeoutId)

		if ((e as Error).name === 'AbortError') {
			return {
				ok: false,
				timeout: true,
				error: 'Request timed out',
				isRaster: raster,
			}
		}

		return {
			ok: false,
			error: (e as Error).message,
			isRaster: raster,
		}
	}
}

/**
 * Fetch a badge directly from a pre-built URL.
 *
 * Lower-level function for when you already have the shields.io URL.
 *
 * @param badgeUrl - Full shields.io URL
 * @param raster - Whether this is a raster badge
 * @param timeoutMs - Request timeout
 * @returns Badge response
 */
export async function fetchBadge(
	badgeUrl: string | URL,
	raster: boolean = false,
	timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<BadgeResponse> {
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

	try {
		const response = await fetch(badgeUrl, {
			signal: controller.signal,
		})

		clearTimeout(timeoutId)

		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				error: `Shields.io returned ${response.status}`,
				isRaster: raster,
			}
		}

		if (raster) {
			const buffer = await response.arrayBuffer()
			const badge = new Uint8Array(buffer)
			return {
				ok: true,
				badge,
				base64: encodeBase64(badge),
				isRaster: true,
			}
		} else {
			const badge = await response.text()
			return {
				ok: true,
				badge,
				isRaster: false,
			}
		}
	} catch (e) {
		clearTimeout(timeoutId)

		if ((e as Error).name === 'AbortError') {
			return {
				ok: false,
				timeout: true,
				error: 'Request timed out',
				isRaster: raster,
			}
		}

		return {
			ok: false,
			error: (e as Error).message,
			isRaster: raster,
		}
	}
}

// =============================================================================
// URL Building
// =============================================================================

interface BuildBadgeUrlOptions {
	size: CompressionSize
	modules?: [string, string][]
	query: string
	requestUrl: URL
	isMinified: boolean
	isUncompressed: boolean
	isDetailed: boolean
	style?: string
	raster: boolean
}

/**
 * Build the shields.io badge URL.
 */
function buildBadgeUrl(options: BuildBadgeUrlOptions): URL {
	const {
		size,
		modules,
		query,
		requestUrl,
		isMinified,
		isUncompressed,
		isDetailed,
		style,
		raster,
	} = options

	// Determine badge type and size to display
	let badgeType: CompressionType | 'minified' | 'uncompressed' = size.type
	let badgeSize = size.compressedSize

	if (isMinified) {
		badgeType = 'minified'
		badgeSize = size.uncompressedSize
	} else if (isUncompressed) {
		badgeType = 'uncompressed'
		badgeSize = size.uncompressedSize
	}

	// Build link URL
	const linkUrl = new URL(requestUrl.search, 'https://bundlejs.com/')
	const encodedLink = encodeURIComponent(linkUrl.href)

	// Build badge label
	const moduleList = modules?.map(([p]) => p)?.join(', ') ?? query
	const detailText = isDetailed ? `${size.uncompressedSize} -> ` : ''
	const labelText = `bundlejs${isDetailed ? ` (${moduleList})` : ''}`

	// Sanitize for shields.io URL path
	const sanitizedDetail = sanitizeShieldsIO(detailText)
	const sanitizedSize = sanitizeShieldsIO(`${badgeSize} (${badgeType})`)
	const sanitizedLabel = sanitizeShieldsIO(labelText)

	// Build the URL
	const host = raster ? SHIELDS_RASTER_HOST : SHIELDS_SVG_HOST
	const badgeUrl = new URL(
		`https://${host}/badge/${sanitizedDetail}${sanitizedSize}-${sanitizedLabel}-blue`
	)

	// Add link parameter
	badgeUrl.searchParams.set('link', encodedLink)

	// Add style if specified
	if (style) {
		badgeUrl.searchParams.set('style', style)
	}

	return badgeUrl
}

/**
 * Sanitize text for use in shields.io URL path.
 *
 * Shields.io uses a custom encoding:
 * - `-` becomes `--`
 * - `_` becomes `__`
 * - ` ` becomes `_`
 */
function sanitizeShieldsIO(str: string): string {
	return str.replace(/-/g, '--').replace(/_/g, '__').replace(/\s/g, '_')
}

// =============================================================================
// Badge Type Detection
// =============================================================================

/**
 * Determine if a badge request is for raster (PNG) format.
 *
 * @param url - Request URL
 * @returns true if raster badge requested
 */
export function isRasterBadgeRequest(url: URL): boolean {
	return (
		url.searchParams.has('badge-raster') ||
		url.searchParams.has('png') ||
		['/badge/raster', '/badge-raster'].includes(url.pathname)
	)
}

/**
 * Determine if a request is for a badge.
 *
 * @param url - Request URL
 * @returns true if badge requested
 */
export function isBadgeRequest(url: URL): boolean {
	return (
		url.searchParams.has('badge') ||
		['/badge', '/badge/raster', '/badge-raster'].includes(url.pathname)
	)
}