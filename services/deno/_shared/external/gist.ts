/**
 * GitHub Gist Storage (DEPRECATED)
 *
 * This module provided storage for bundle results in GitHub Gists.
 * The feature has been disabled but the interface is preserved for
 * potential future re-enablement.
 *
 * **Why deprecated:**
 * - Rate limiting issues with GitHub API
 * - Complexity in managing Gist lifecycle
 * - Storage costs vs. caching benefits
 *
 * @module
 * @deprecated Feature disabled. All functions return null/undefined.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Result from creating a Gist.
 */
export interface GistResult {
	/** Gist ID */
	fileId: string
	/** Gist API URL */
	fileUrl: string
	/** Gist HTML URL */
	fileHTMLUrl: string
}

/**
 * Output file format from bundler.
 */
export interface OutputFile {
	path: string
	contents: Uint8Array
	text: string
}

// =============================================================================
// Stub Implementations
// =============================================================================

/**
 * Store bundle output files in a Gist.
 *
 * @deprecated Feature disabled - always returns undefined
 * @param _url - Request URL (unused)
 * @param _files - Output files (unused)
 * @returns Always undefined
 */
export async function setFile(
	_url: string,
	_files: OutputFile[]
): Promise<GistResult | undefined> {
	// Feature disabled
	return undefined
}

/**
 * Get bundle content from a Gist.
 *
 * @deprecated Feature disabled - always returns undefined
 * @param _id - Gist ID (unused)
 * @returns Always undefined
 */
export async function getFile(_id: string): Promise<string | undefined> {
	// Feature disabled
	return undefined
}

/**
 * Delete a Gist.
 *
 * @deprecated Feature disabled - always returns undefined
 * @param _id - Gist ID (unused)
 * @returns Always undefined
 */
export async function deleteFile(_id: string): Promise<unknown | undefined> {
	// Feature disabled
	return undefined
}

/**
 * List all Gists.
 *
 * @deprecated Feature disabled - yields nothing
 */
export async function* listFiles(): AsyncGenerator<{ data: { id: string }[] | null }> {
	// Feature disabled - empty generator
}

// =============================================================================
// Feature Flag
// =============================================================================

/**
 * Check if Gist storage is enabled.
 *
 * @returns Always false (feature disabled)
 */
export function isGistStorageEnabled(): boolean {
	return false
}

/**
 * Enable Gist storage (for potential future re-enablement).
 *
 * @throws Always throws - feature is disabled
 */
export function enableGistStorage(): never {
	throw new Error(
		'Gist storage is currently disabled. See module documentation for rationale.'
	)
}