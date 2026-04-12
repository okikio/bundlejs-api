/**
 * Cache Key Generation
 *
 * Deterministic key generation for bundle result caching.
 * Keys are SHA-256 hashes of the normalized configuration.
 *
 * @module
 */
import type { BundleConfig, ModuleSpec } from './types.ts'

import JSON5 from '@bundle/utils/json5'

// =============================================================================
// Constants
// =============================================================================

/** Maximum key length for Redis compatibility */
const MAX_KEY_LENGTH = 500

/** Prefix for JSON result keys */
const JSON_PREFIX = 'json'

/** Prefix for badge keys */
const BADGE_PREFIX = 'badge'

/** Prefix for package-specific result keys */
const PACKAGE_PREFIX = 'json-package'

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a cache key for a bundle configuration.
 *
 * The key is deterministic: same config + modules = same key.
 * Uses JSON5 serialization for consistent ordering.
 *
 * @param config - Bundle configuration
 * @param modules - Module specifiers with modes
 * @param inputCode - Input source code
 * @returns SHA-256 hash prefixed with 'json/'
 *
 * @example
 * ```ts
 * const key = await generateCacheKey(
 *   { esbuild: { format: 'esm' } },
 *   [['react@18.2.0', 'export']],
 *   'export * from "react";'
 * )
 * // => 'json/a1b2c3d4...'
 * ```
 */
export async function generateCacheKey(
	config: Omit<BundleConfig, 'init'>,
	modules: ModuleSpec[],
	versions: string[],
	inputCode: string
): Promise<string> {
	// Build the key object with consistent structure
	const keyObj = {
		...config,
		versions,
		modules,
		initialValue: inputCode.trim(),
	}

	// Serialize with JSON5 for consistent output
	const serialized = `${JSON_PREFIX}/${JSON5.stringify(keyObj).trim()}`

	// If the serialized key is short enough, use it directly
	// This preserves readability for debugging
	if (serialized.length <= MAX_KEY_LENGTH) {
		return serialized
	}

	// For long keys, hash the content
	const hash = await hashString(serialized)
	return `${JSON_PREFIX}/${hash}`
}

/**
 * Generate a badge cache key from a JSON cache key.
 *
 * @param jsonKey - The JSON result cache key
 * @returns Badge-prefixed key
 */
export function getBadgeKey(jsonKey: string): string {
	return `${BADGE_PREFIX}/${jsonKey}`
}

/**
 * Generate a badge ID for hash-based storage.
 *
 * The badge ID includes style options for proper cache segmentation.
 *
 * @param keyObj - Base key object
 * @param badgeOptions - Badge-specific options
 * @returns JSON5-serialized badge ID
 */
export function generateBadgeId(
	keyObj: Record<string, unknown>,
	badgeOptions: {
		raster?: boolean
		result?: string | null
		style?: string | null
	}
): string {
	return JSON5.stringify({
		...keyObj,
		badge: badgeOptions,
	}).trim()
}

/**
 * Generate a package-specific result key.
 *
 * Used for permanent caching of simple package exports.
 *
 * @param moduleName - Full module name with version (e.g., 'react@18.2.0')
 * @param jsonKey - The base JSON cache key
 * @returns Package-prefixed key
 *
 * @example
 * ```ts
 * const key = getPackageResultKey('react@18.2.0', 'json/abc123')
 * // => 'json-package/react@18.2.0/json/abc123'
 * ```
 */
export function getPackageResultKey(moduleName: string, jsonKey: string): string {
	return `${PACKAGE_PREFIX}/${moduleName}/${jsonKey}`
}

/**
 * Extract the module name from a package result key.
 *
 * @param packageKey - Full package result key
 * @returns Module name or null if invalid format
 */
export function parsePackageResultKey(packageKey: string): {
	moduleName: string
	jsonKey: string
} | null {
	const prefix = `${PACKAGE_PREFIX}/`
	if (!packageKey.startsWith(prefix)) {
		return null
	}

	const rest = packageKey.slice(prefix.length)
	const slashIndex = rest.indexOf('/')

	if (slashIndex === -1) {
		return null
	}

	return {
		moduleName: rest.slice(0, slashIndex),
		jsonKey: rest.slice(slashIndex + 1),
	}
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Hash a string using SHA-256.
 *
 * @param str - String to hash
 * @returns Hex-encoded hash
 */
async function hashString(str: string): Promise<string> {
	const encoder = new TextEncoder()
	const data = encoder.encode(str)

	const hashBuffer = await crypto.subtle.digest('SHA-256', data)
	const hashArray = Array.from(new Uint8Array(hashBuffer))

	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Generate a hash for entry point naming.
 *
 * Used to create unique entry point paths that incorporate
 * the full configuration for cache key purposes.
 *
 * @param jsonKey - The JSON cache key
 * @returns Short hash suitable for file names
 */
export async function generateEntryPointHash(jsonKey: string): Promise<string> {
	const hash = await hashString(jsonKey)
	// Return first 16 chars for reasonable uniqueness without excessive length
	return hash.slice(0, 16)
}