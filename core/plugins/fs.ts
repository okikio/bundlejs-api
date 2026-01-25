// Based on https://github.com/okikio/bundle/blob/main/src/ts/plugins/virtual-fs.ts
import type { LocalState, ESBUILD } from "../types.ts";
import type { IFileSystem } from "../utils/filesystem.ts";
import type { Context } from "../context/context.ts";

import { fileExists, getFile } from "../utils/filesystem.ts";
import { fromContext } from "../context/context.ts";
import { inferLoader, RESOLVE_EXTENSIONS } from "../utils/loader.ts";
import { dirname, extname, resolve } from "@bundle/utils/path";

export const VIRTUAL_FILESYSTEM_NAMESPACE = "virtual-filesystem";

/**
 * Options for the Virtual FS resolver.
 *
 * The default behavior matches esbuild’s filesystem resolver as closely as is practical:
 * - Uses `build.initialOptions.resolveExtensions` (or RESOLVE_EXTENSIONS fallback)
 * - Resolves relative specifiers using `resolveDir` (provided by `onLoad`)
 * - Returns canonical absolute paths from `onResolve` to avoid module identity collisions
 */
export interface VirtualFileSystemPluginOptions {
	/**
	 * Optional scheme prefixes that force resolution through VFS.
	 *
	 * Examples:
	 * - `vfs:/index.tsx`
	 * - `virtual:/src/main.ts`
	 */
	prefixes?: readonly string[];

	/**
	 * If true, directory imports will try `index.*` (like bundlers commonly do).
	 * Default: true
	 */
	enableIndexFallback?: boolean;
}

export interface VfsResolutionState<T> extends LocalState<T> { 
	resolveExtensions: string[],
	enableIndexFallback: boolean,
	prefixes: string[]
}

export async function resolveVfsPath<T>(
	fs: IFileSystem<T>,
	candidate: string,
	resolveExtensions: readonly string[],
	enableIndexFallback = true,
): Promise<string | null> {
	// 1) Exact file hit.
	if (await fileExists(fs, candidate))
		return candidate;

	// 2) Extension probing for extensionless imports.
	if (extname(candidate).length === 0) {
		for (const ext of resolveExtensions) {
			const withExt = candidate + ext;
			if (await fileExists(fs, withExt)) 
				return withExt;
		}
	}

	// 3) Optional directory -> index.* fallback.
	// We can’t reliably distinguish file vs folder using only `has()`,
	// so we just probe index.* in the directory path.
	if (enableIndexFallback) {
		for (const ext of resolveExtensions) {
			const indexPath = resolve(candidate, "index" + ext);
			if (await fileExists(fs, indexPath)) 
				return indexPath;
		}
	}

	return null;
}

/**
 * Remove the first matching prefix from `path` if present.
 */
export function stripAnyPrefix(path: string, prefixes: readonly string[]): string {
	for (const prefix of prefixes) {
		if (path.startsWith(prefix)) {
			const rest = path.slice(prefix.length);
			// Allow both `vfs:/x` and `vfs:x`
			return rest.startsWith("/") ? rest : "/" + rest;
		}
	}

	return path;
}

/**
 * Core resolution logic shared by all VFS handlers.
 * 
 * Returns undefined if the path doesn't resolve to a VFS file,
 * allowing other plugins to handle it.
 */
export function VfsResolution<T>(StateContext: Context<VfsResolutionState<T>>) {
	const FileSystem = fromContext("filesystem", StateContext)!;

	const enableIndexFallback = fromContext("enableIndexFallback", StateContext) ?? true;
	const resolveExtensions = fromContext("resolveExtensions", StateContext) ?? [];
	const prefixes = fromContext("prefixes", StateContext) ?? [];
	
	return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
		// 1) Never let VFS touch URLs. These belong to the HTTP/CDN pipeline.
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(args.path)) return;

		// 2) Strip optional VFS prefixes.
		const stripped = stripAnyPrefix(args.path, prefixes);

		const isAbsolute = stripped.startsWith("/");
		const isRelative = stripped.startsWith("./") || stripped.startsWith("../");

		// 3) Skip bare specifiers ("react", "@scope/pkg") entirely.
		// Let Alias/Cdn/External resolve those.
		if (!isAbsolute && !isRelative) return;

		// 4) Relative specifiers are only meaningful inside VFS.
		// Otherwise we risk capturing unrelated plugin namespaces.
		if (isRelative && args.namespace !== VIRTUAL_FILESYSTEM_NAMESPACE) return;

		// 5) Base directory:
		// For VFS modules, esbuild will pass us `resolveDir` (because we return it in onLoad).
		// For entry points, resolveDir may be empty; absolute paths still work.
		const baseDir = args.resolveDir && args.resolveDir.length > 0
			? args.resolveDir
			: "/";

		const candidate = isRelative ? resolve(baseDir, stripped) : resolve(stripped);

		// 6) Probe the VFS similarly to esbuild’s filesystem resolver:
		// - exact path
		// - extension probing if extensionless
		// - optional directory -> index.* fallback
		const resolved = await resolveVfsPath(FileSystem, candidate, resolveExtensions, enableIndexFallback);
		if (!resolved) return;

		return {
			// IMPORTANT: This is now the canonical identity for the module.
			path: resolved,
			namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
			pluginData: Object.assign({}, args.pluginData, {
				vfsOriginalSpecifier: args.path,
			}),
		};
	};
}

/**
 * Create an esbuild plugin that resolves and loads modules from the in-memory filesystem.
 *
 * Why this exists:
 * - Your build uses entry points like `/index.tsx` (not present on disk)
 * - You want Node-like resolution behavior while still letting esbuild do the heavy lifting
 *
 * Critical correctness rule:
 * - `onResolve` MUST return the final, canonical module path
 *   (esbuild caches by `(namespace, path)`; returning raw specifiers causes collisions).
 * 
 * Uses multiple targeted handlers instead of a single catch-all.
 * This eliminates the need to explicitly skip URLs/bare imports and reduces
 * unnecessary processing overhead.
 *
 * Handler strategy:
 * 1. VFS-prefixed paths (`vfs:`, `virtual:`) - any namespace
 * 2. Absolute paths (`/...`) - any namespace  
 * 3. Relative paths (`./`, `../`) - VFS namespace ONLY
 *
 * This ensures:
 * - URLs are never matched (no need for explicit skip)
 * - Bare imports are never matched (no need for explicit skip)
 * - Relative imports from other namespaces don't trigger VFS
 */
export function VirtualFileSystemPlugin<T = Uint8Array>(
  StateContext: Context<LocalState<T>>,
  opts: VirtualFileSystemPluginOptions = {}
): ESBUILD.Plugin {
  const FileSystem = fromContext("filesystem", StateContext)!;

	const prefixes = opts.prefixes ?? ["vfs:", "virtual:"];
	const enableIndexFallback = opts.enableIndexFallback ?? true;

	// Build regex for VFS prefixes: /^(vfs:|virtual:)/
	const prefixPattern = new RegExp(`^(${prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);

  return {
    name: VIRTUAL_FILESYSTEM_NAMESPACE,
    setup(build) {
			const resolveExtensions = (
				build.initialOptions.resolveExtensions?.slice()
				?? RESOLVE_EXTENSIONS.slice()
			);

			const ctx = StateContext.with({
				resolveExtensions,
				enableIndexFallback,
				prefixes
			}) as Context<VfsResolutionState<T>>;

			/**
			 * Handler 1: VFS-prefixed paths (any namespace)
			 * 
			 * Matches: `vfs:/index.tsx`, `virtual:./component.ts`
			 * These are explicit VFS references that should always be handled.
			 */
			build.onResolve({ filter: prefixPattern }, VfsResolution(ctx));

			/**
			 * Handler 2: Absolute paths (any namespace)
			 * 
			 * Matches: `/index.tsx`, `/src/main.ts`
			 * Absolute paths can come from any namespace and should resolve against VFS root.
			 * 
			 * Note: This does NOT match URLs like `https://...` because they start with
			 * a protocol, not `/`. The regex `^\/` only matches paths starting with `/`.
			 */
			build.onResolve({ filter: /^\// }, VfsResolution(ctx));

			/**
			 * Handler 3: Relative paths from VFS namespace ONLY
			 * 
			 * Matches: `./foo`, `../bar` (when importer is in VFS namespace)
			 * 
			 * Critical: We only handle relative imports when the importer is already
			 * in the VFS namespace. This prevents VFS from intercepting relative
			 * imports from HTTP/CDN modules.
			 */
			build.onResolve({ filter: /^\.\.?\//, namespace: VIRTUAL_FILESYSTEM_NAMESPACE }, VfsResolution(ctx));

			/**
			 * onLoad handler for VFS namespace
			 * 
			 * Loads file contents from the virtual filesystem.
			 */
      build.onLoad({ filter: /.*/, namespace: VIRTUAL_FILESYSTEM_NAMESPACE }, async (args) => {
        // args.path is canonical (because onResolve returned it).
        const content = await getFile(FileSystem, args.path, "buffer");

        // `getFile` returns null when missing/invalid; empty files are OK.
        if (content === null) return;

        return {
          contents: content,
          loader: inferLoader(args.path),
          // This is the correct way to enable relative resolution in custom namespaces.
          resolveDir: dirname(args.path),
          pluginData: Object.assign({}, args.pluginData, {
            importer: args.path,
          }),
        };
      });
    },
  };
};

/**
 * Examples
 *
 * Example 1: Collision-proof relative resolution
 * - /a/index.ts imports "./shared"
 * - /b/index.ts imports "./shared"
 *
 * With this plugin, the resolved module paths become:
 * - /a/shared.ts  (or /a/shared.js, etc depending on resolveExtensions + existing files)
 * - /b/shared.ts
 *
 * Those are distinct module identities, so esbuild won’t mix them.
 *
 * Example 2: URL/tarball import does not get intercepted
 * - /index.ts imports "https://pkg.pr.new/@tanstack/react-query@7988"
 *
 * VFS returns undefined for URLs, so your HTTP/CDN plugins handle it.
 * 
 * Complex examples:
 *
 * Example 1: Direct VFS entry point
 * - Entry: `/index.tsx`
 * - Handler 2 (absolute) matches, resolves via VFS
 *
 * Example 2: Relative import within VFS
 * - Importer: `/index.tsx` (VFS namespace)
 * - Import: `./component.tsx`
 * - Handler 3 (relative + VFS namespace) matches, resolves relative to importer
 *
 * Example 3: HTTP URL import
 * - Import: `https://esm.sh/react`
 * - No handler matches (not prefixed, not absolute `/`, not relative)
 * - Falls through to HTTP/CDN plugins
 *
 * Example 4: Bare import
 * - Import: `react`
 * - No handler matches
 * - Falls through to Alias/External/CDN plugins
 *
 * Example 5: Tarball URL
 * - Import: `https://pkg.pr.new/@tanstack/react-query@7988`
 * - No handler matches
 * - TarballPlugin can handle it without VFS interference
 *
 * Example 6: Relative import from HTTP module
 * - Importer: `https://esm.sh/react` (HTTP namespace)
 * - Import: `./scheduler`
 * - Handler 3 does NOT match (wrong namespace)
 * - HttpPlugin handles the relative resolution
 */
