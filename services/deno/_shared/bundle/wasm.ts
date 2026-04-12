/**
 * WASM Module Management
 *
 * Singleton loader for the esbuild WASM module. The module is loaded
 * and compiled once, then cached for all subsequent bundle operations.
 *
 * @module
 */
import type { WasmState } from './types.ts'

import ESBUILD_WASM from '@bundle/core/wasm'

// =============================================================================
// Module State
// =============================================================================

/**
 * Singleton state for WASM module.
 *
 * We maintain both the raw bytes and compiled module because:
 * - Raw bytes: Required for initial compilation
 * - Compiled module: Required for esbuild init option
 */
const wasmState: WasmState = {
	wasmBytes: null,
	wasmModule: null,
	initializing: false,
}

// Initialization promise for deduplication
let initPromise: Promise<WebAssembly.Module> | null = null

// =============================================================================
// Public API
// =============================================================================

/**
 * Get the compiled WebAssembly module for esbuild.
 *
 * This function is safe to call concurrently - multiple calls during
 * initialization will share the same promise and return the same module.
 *
 * **Performance characteristics:**
 * - First call: ~100-500ms (fetch + compile)
 * - Subsequent calls: <1ms (cached)
 *
 * @returns Compiled WebAssembly.Module ready for esbuild init
 *
 * @example
 * ```ts
 * const wasmModule = await getWasmModule()
 *
 * const result = await build({
 *   entryPoints: ['/index.ts'],
 *   init: {
 *     platform: 'deno-wasm',
 *     worker: false,
 *     wasmModule,
 *   },
 * })
 * ```
 */
export async function getWasmModule(): Promise<WebAssembly.Module> {
	// Fast path: already initialized
	if (wasmState.wasmModule) {
		return wasmState.wasmModule
	}

	// Deduplication: if initialization is in progress, wait for it
	if (initPromise) {
		return initPromise
	}

	// Start initialization
	initPromise = initializeWasm()

	try {
		const module = await initPromise
		return module
	} finally {
		// Clear the promise after completion (success or failure)
		// This allows retry on failure
		initPromise = null
	}
}

/**
 * Check if WASM module is already loaded.
 *
 * Useful for conditional logic or health checks.
 *
 * @returns true if module is loaded and ready
 */
export function isWasmLoaded(): boolean {
	return wasmState.wasmModule !== null
}

/**
 * Get current WASM state for debugging.
 *
 * @returns Current state snapshot
 */
export function getWasmState(): Readonly<WasmState> {
	return { ...wasmState }
}

// =============================================================================
// Internal Implementation
// =============================================================================

/**
 * Initialize the WASM module.
 *
 * This is called once and the result is cached.
 */
async function initializeWasm(): Promise<WebAssembly.Module> {
	if (wasmState.initializing) {
		throw new Error('WASM initialization already in progress')
	}

	wasmState.initializing = true

	try {
		// Load WASM bytes if not already loaded
		if (!wasmState.wasmBytes) {
			wasmState.wasmBytes = await ESBUILD_WASM()
		}

		// Compile the module
		if (!wasmState.wasmModule) {
			wasmState.wasmModule = new WebAssembly.Module(
				wasmState.wasmBytes as BufferSource
			)
		}

		return wasmState.wasmModule
	} catch (error) {
		// Reset state on failure to allow retry
		wasmState.wasmBytes = null
		wasmState.wasmModule = null
		throw error
	} finally {
		wasmState.initializing = false
	}
}

/**
 * Reset WASM state (primarily for testing).
 *
 * @internal
 */
export function resetWasmState(): void {
	wasmState.wasmBytes = null
	wasmState.wasmModule = null
	wasmState.initializing = false
	initPromise = null
}