/**
 * Bundle Service Type Definitions
 *
 * Core types shared across the bundle service for configuration,
 * results, and request/response contracts.
 *
 * Imports types from @bundle/core, @bundle/compress, and @bundle/utils
 * to maintain compatibility with the bundlejs monorepo.
 *
 * @module
 */

// Core types from @bundle/core
import type { BuildConfig, ESBUILD } from '@bundle/core'

// Compression types from @bundle/compress
import type { CompressConfig, CompressionType } from '@bundle/compress'

// Utility types from @bundle/utils
import type { PackageJson } from '@bundle/utils/types'

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Extended build configuration for the bundle service.
 *
 * Extends the core BuildConfig from @bundle/core with service-specific
 * options like compression settings, analysis output, and JSX/TSX support.
 */
export interface BundleConfig extends BuildConfig {
	/** Compression settings for output size calculation */
	compression?: CompressConfig

	/** Enable esbuild bundle analysis output */
	analysis?: boolean | string

	/** Enable JSX/TSX file support */
	tsx?: boolean
}

/**
 * Parsed configuration from query parameters.
 *
 * Intermediate representation after query parsing but before
 * full config resolution with defaults.
 */
export interface ParsedQueryConfig {
	/** Raw input code from share/text params */
	inputCode: string

	/** Resolved configuration object */
	config: BundleConfig

	/** Package versions resolved from query */
	versions: string[]

	/** Module specifiers with import/export mode */
	modules: ModuleSpec[]
}

/**
 * Module specifier with import/export declaration type.
 *
 * The tuple format matches the existing API:
 * - [0]: Full module specifier (e.g., "@okikio/animate@1.0.0")
 * - [1]: Declaration type ("import" | "export" | custom string)
 */
export type ModuleSpec = [specifier: string, mode: 'import' | 'export' | (string & {})]

// =============================================================================
// Result Types
// =============================================================================

/**
 * Compression size information.
 *
 * Matches the return type of compress() from @bundle/compress,
 * contains both raw bytes and human-readable formatted sizes.
 */
export interface CompressionSize {
	/** Compression algorithm used */
	type: CompressionType

	/** Human-readable uncompressed size (e.g., "45.2 kB") */
	uncompressedSize: string

	/** Human-readable compressed size (e.g., "12.1 kB") */
	compressedSize: string

	/** Raw uncompressed byte count */
	rawUncompressedSize: number

	/** Raw compressed byte count */
	rawCompressedSize: number
}

/**
 * Install size breakdown per package.
 */
export interface PackageSizeInfo {
	/** Package name */
	name: string

	/** Installed size in bytes */
	size: number
}

/**
 * Full bundle result returned from the bundling operation.
 *
 * Contains everything needed to:
 * - Display size information
 * - Generate badges
 * - Provide debugging info
 * - Cache and retrieve results
 */
export interface BundleResult {
	/** Original query string (decoded) */
	query: string

	/** URL-encoded query string for linking */
	rawQuery: string

	/** Configuration used for the build (without init) */
	config: Omit<BundleConfig, 'init'>

	/** Input source code that was bundled */
	input: string

	/** Single resolved version (when one module) */
	version?: string

	/** All resolved versions (when multiple modules) */
	versions?: string[]

	/** Module specifiers with their modes */
	modules?: ModuleSpec[]

	/** Compression size information */
	size: CompressionSize

	/** Install size breakdown */
	installSize?: {
		/** Total install size in bytes */
		total?: number

		/** Per-package size breakdown */
		packages?: PackageSizeInfo[]
	}

	/** Human-readable build duration */
	time: string

	/** Raw build duration in milliseconds */
	rawTime: number

	/** GitHub Gist ID for stored bundle (deprecated) */
	fileId?: string

	/** GitHub Gist API URL (deprecated) */
	fileUrl?: string

	/** GitHub Gist HTML URL (deprecated) */
	fileHTMLUrl?: string

	/** Build warnings from esbuild */
	warnings?: string[]

	/** esbuild metafile for analysis (ESBUILD.Metafile from @bundle/core) */
	metafile?: ESBUILD.Metafile

	/** Whether this result was served from cache */
	cached?: boolean
}

// =============================================================================
// Request Types
// =============================================================================

/**
 * Cache control modes for bundle requests.
 *
 * - `use`: Normal caching (read cache, write on miss)
 * - `bypass`: Skip cache entirely (no read, no write)
 * - `refresh`: Ignore cache on read, write new result
 */
export type CacheMode = 'use' | 'bypass' | 'refresh'

/**
 * Output format options for bundle responses.
 * Maps to esbuild's format option.
 */
export type OutputFormat = 'esm' | 'cjs' | 'iife'

/**
 * Compression algorithm options.
 * Maps to @bundle/compress CompressionType.
 */
export type CompressionOption = 'gzip' | 'brotli' | 'zstd' | 'lz4' | 'none'

/**
 * Badge detail level options.
 */
export type BadgeDetail = 'simple' | 'detailed' | 'minified'

/**
 * Badge style options (shields.io styles).
 */
export type BadgeStyle = 'flat' | 'flat-square' | 'plastic' | 'for-the-badge' | 'social'

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Internal state for WASM module caching.
 */
export interface WasmState {
	/** Raw WASM binary */
	wasmBytes: Uint8Array | null

	/** Compiled WebAssembly module */
	wasmModule: WebAssembly.Module | null

	/** Whether initialization is in progress */
	initializing: boolean
}

/**
 * Bundle execution options passed to the core bundler.
 */
export interface BundleExecutionOptions {
	/** Fully resolved configuration */
	config: BundleConfig

	/** Input source code */
	inputCode: string

	/** Hash prefix for entry point naming */
	entryPointHash: string
}

/**
 * Package.json fragment used in config resolution.
 * Uses PackageJson type from @bundle/utils/types.
 */
export type PackageJsonFragment = Partial<PackageJson>

// =============================================================================
// Re-exports for Convenience
// =============================================================================

/**
 * Re-export BuildConfig from @bundle/core for convenience.
 */
export type { BuildConfig } from '@bundle/core'

/**
 * Re-export CompressConfig and CompressionType from @bundle/compress.
 */
export type { CompressConfig, CompressionType } from '@bundle/compress'

/**
 * Re-export ESBUILD types for metafile, etc.
 */
export type { ESBUILD } from '@bundle/core'