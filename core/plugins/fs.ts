// Based on https://github.com/okikio/bundle/blob/main/src/ts/plugins/virtual-fs.ts
import type { LocalState, ESBUILD } from "../types.ts";
import type { IFileSystem } from "../utils/filesystem.ts";
import type { Context } from "../context/context.ts";

import { getFile } from "../utils/filesystem.ts";
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

/**
 * Create an esbuild plugin that resolves and loads modules from the in-memory filesystem.
 *
 * Why this exists:
 * - Your build uses entry points like `/index.tsx` (not present on disk) :contentReference[oaicite:6]{index=6}
 * - You want Node-like resolution behavior while still letting esbuild do the heavy lifting
 *
 * Critical correctness rule:
 * - `onResolve` MUST return the final, canonical module path
 *   (esbuild caches by `(namespace, path)`; returning raw specifiers causes collisions).
 */
export function VirtualFileSystemPlugin<T = Uint8Array>(
  StateContext: Context<LocalState<T>>,
  opts: VirtualFileSystemPluginOptions = {}
): ESBUILD.Plugin {
  const FileSystem = fromContext("filesystem", StateContext)!;

	const prefixes = opts.prefixes ?? ["vfs:", "virtual:"];
	const enableIndexFallback = opts.enableIndexFallback ?? true;

  return {
    name: VIRTUAL_FILESYSTEM_NAMESPACE,
    setup(build) {
			const resolveExtensions = (build.initialOptions.resolveExtensions?.slice() ??
        RESOLVE_EXTENSIONS.slice());
      
			/**
			 * Only treat these as VFS paths:
			 * - `/absolute`
			 * - `./relative` or `../relative` (but ONLY when importer is already in VFS namespace)
			 * - `vfs:` / `virtual:` prefixed
			 */
			build.onResolve({ filter: /.*/ }, async (args) => {
				// 1) Never let VFS touch URLs. These belong to the HTTP/CDN pipeline.
				if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(args.path)) {
					return;
				}

				// 2) Strip optional VFS prefixes.
				const stripped = stripAnyPrefix(args.path, prefixes);

				const isAbsolute = stripped.startsWith("/");
				const isRelative = stripped.startsWith("./") || stripped.startsWith("../");

				// 3) Skip bare specifiers ("react", "@scope/pkg") entirely.
				// Let Alias/Cdn/External resolve those.
				if (!isAbsolute && !isRelative) {
					return;
				}

				// 4) Relative specifiers are only meaningful inside VFS.
				// Otherwise we risk capturing unrelated plugin namespaces.
				if (isRelative && args.namespace !== VIRTUAL_FILESYSTEM_NAMESPACE) {
					return;
				}

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

				if (!resolved) {
					return;
				}

				return {
					// IMPORTANT: This is now the canonical identity for the module.
					path: resolved,
					namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
					pluginData: Object.assign({}, args.pluginData, {
						vfsOriginalSpecifier: args.path,
					}),
				};
      });

      build.onLoad({ filter: /.*/, namespace: VIRTUAL_FILESYSTEM_NAMESPACE }, async (args) => {
        // args.path is canonical (because onResolve returned it).
        const content = await getFile(FileSystem, args.path, "buffer");

        // `getFile` returns null when missing/invalid; empty files are OK.
        if (content === null) {
          return;
        }

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
 * Remove the first matching prefix from `path` if present.
 */
function stripAnyPrefix(path: string, prefixes: readonly string[]): string {
	for (const prefix of prefixes) {
		if (path.startsWith(prefix)) {
			const rest = path.slice(prefix.length);
			// Allow both `vfs:/x` and `vfs:x`
			return rest.startsWith("/") ? rest : "/" + rest;
		}
	}
	return path;
}

async function resolveVfsPath<T>(
	fs: IFileSystem<T>,
	candidate: string,
	resolveExtensions: readonly string[],
	enableIndexFallback: boolean,
): Promise<string | null> {
	// 1) Exact file hit.
	if (await fileExists(fs, candidate)) {
		return candidate;
	}

	// 2) Extension probing for extensionless imports.
	if (extname(candidate).length === 0) {
		for (const ext of resolveExtensions) {
			const withExt = candidate + ext;
			if (await fileExists(fs, withExt)) {
				return withExt;
			}
		}
	}

	// 3) Optional directory -> index.* fallback.
	// We can’t reliably distinguish file vs folder using only `has()`,
	// so we just probe index.* in the directory path.
	if (enableIndexFallback) {
		for (const ext of resolveExtensions) {
			const indexPath = resolve(candidate, "index" + ext);
			if (await fileExists(fs, indexPath)) {
				return indexPath;
			}
		}
	}

	return null;
}

async function fileExists<T>(fs: IFileSystem<T>, path: string): Promise<boolean> {
	// This treats empty files as existing (Uint8Array length can be 0).
	// It also avoids counting directories as “existing modules”.
	const content = await getFile(fs, path, "buffer");
	return content !== null;
}



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
 */
