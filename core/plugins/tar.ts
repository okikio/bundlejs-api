/**
 * Tarball Plugin for esbuild
 * 
 * Handles tarball-based package sources like `pkg.pr.new` by:
 * 1. Fetching and extracting tarballs into the virtual filesystem
 * 2. Resolving package entry points via exports/main fields
 * 3. Enabling imports from within extracted packages (including self-references)
 * 
 * @example
 * ```ts
 * // Direct tarball URL import
 * import { useQuery } from "https://pkg.pr.new/@tanstack/react-query@7988";
 * 
 * // Subpath import
 * import { QueryClient } from "https://pkg.pr.new/@tanstack/react-query@7988/build/modern";
 * ```
 */
import type { TarStreamEntry } from "@bundle/utils/tar";
import type { LocalState, ESBUILD } from "../types.ts";
import type { PackageJson } from "@bundle/utils/types";
import type { Context } from "../context/context.ts";

import { fromContext, toContext } from "../context/context.ts";

import { UntarStream } from "@bundle/utils/tar";
import { resolve, legacy } from "@bundle/utils/resolve-exports-imports";

import { normalize, join } from "@bundle/utils/path";
import { fetchWithCache } from "@bundle/utils/fetch-and-cache";

import { VIRTUAL_FILESYSTEM_NAMESPACE } from "./fs.ts";
import { dispatchEvent, LOGGER_INFO, LOGGER_WARN, LOGGER_ERROR } from "../configs/events.ts";

import { getResolverConditions } from "../../utils/resolve-conditions.ts";
import { setFile, getFile } from "../utils/filesystem.ts";
import { getCDNStyle } from "../utils/cdn-format.ts";

import {
	detectArchiveFromResponse,
	type ArchiveDetection,
	type ArchiveDiagnostic
} from "@bundle/utils/archive-detect";

import { parsePackageName } from "@bundle/utils/parse-package-name";

/** Tarball Plugin Namespace */
export const TARBALL_NAMESPACE = "tarball-url";

/** Root directory for extracted tarballs in VFS */
const TARBALL_ROOT = "/__tarballs__";

/**
 * Mounted tarball metadata stored in StateContext
 */
export interface TarballMount {
	/** When this mount was created (for cache eviction) */
	createdAt: number;
	/** VFS path to the extracted package root */
	packageRoot: string;
	/** The package.json manifest */
	manifest: PackageJson;
	/** Original tarball URL */
	sourceUrl: string;
}

/**
 * Extended LocalState with tarball-specific caches
 */
export interface TarballState {
	/** Map of tarball URL -> mount info */
	tarballMounts: Map<string, TarballMount>;
	/** Inflight tarball fetches to prevent duplicate work */
	tarballInflight: Map<string, Promise<TarballMount>>;
}

/**
 * Check if a URL points to a tarball-style CDN (like pkg.pr.new)
 */
function isTarballUrl(url: URL): boolean {
	return getCDNStyle(url.origin) === "tarball";
}

/**
 * Generate a stable, content-addressed key for a tarball URL
 */
async function getTarballKey(url: string): Promise<string> {
	// Normalize the URL for stable keys
	const normalized = new URL(url);
	normalized.hash = "";
	
	// Sort search params for consistency
	const params = Array.from(normalized.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
	normalized.search = "";
	for (const [k, v] of params) {
		normalized.searchParams.append(k, v);
	}
	
	const bytes = new TextEncoder().encode(normalized.toString());
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hashArray = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0"));
  return hashArray.join("").slice(0, 16);
}

export interface ParseTarballUrlResult {
  /**
   * The raw package spec as it appears in the URL path.
   *
   * Examples:
   * - "@tanstack/react-query@7988"
   * - "tinybench@a832a55"
   */
  pkgSpec: string;

  /**
   * The parsed npm package name (scope included if present).
   *
   * Examples:
   * - "@tanstack/react-query"
   * - "tinybench"
   */
  name: string;

  /**
   * The version selector from the spec.
   *
   * For pkg.pr.new this is commonly a commit SHA or PR number,
   * but you should treat it as an opaque string.
   */
  version: string | null;

  /**
   * Any remaining URL path after the package spec.
   *
   * Examples:
   * - ""
   * - "/build/modern"
   */
  subpath: string;

  /**
   * The “package root” URL (same origin, no subpath, no query/hash).
   */
  packageUrl: URL;

  /**
   * Present when the URL is the non-compact form: /owner/repo/...
   */
  owner: string | null;

  /**
   * Present when the URL is the non-compact form: /owner/repo/...
   */
  repo: string | null;
}

export interface ParseTarballUrlOptions {
  /**
   * If true, return empty-ish outputs instead of throwing on invalid inputs.
   */
  ignoreError?: boolean;

  /**
   * Used when the spec does not include "@version".
   * (You may want to set this to null if pkg.pr.new always requires it.)
   */
  defaultVersion?: string | null;
}

/**
 * Parse a pkg.pr.new URL and extract the package spec + subpath.
 *
 * Supports both URL shapes:
 * - Compact:     /<pkgSpec>/<subpath...>
 * - Non-compact: /<owner>/<repo>/<pkgSpec>/<subpath...>
 *
 * @example
 * ```ts
 * const r = parseTarballUrl(new URL("https://pkg.pr.new/@tanstack/react-query@7988/build/modern"));
 * // r.pkgSpec  -> "@tanstack/react-query@7988"
 * // r.name     -> "@tanstack/react-query"
 * // r.version  -> "7988"
 * // r.subpath  -> "/build/modern"
 * // r.packageUrl.href -> "https://pkg.pr.new/@tanstack/react-query@7988"
 * ```
 *
 * @example
 * ```ts
 * const r = parseTarballUrl(new URL("https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55"));
 * // r.owner    -> "tinylibs"
 * // r.repo     -> "tinybench"
 * // r.pkgSpec  -> "tinybench@a832a55"
 * // r.packageUrl.href -> "https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55"
 * ```
 */
export function parseTarballUrl(
  url: URL,
  options: ParseTarballUrlOptions = {},
): ParseTarballUrlResult {
  const ignoreError = options.ignoreError ?? false;
  const defaultVersion = options.defaultVersion ?? "latest";

  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 0) {
    return {
      pkgSpec: "",
      name: "",
      version: defaultVersion,
      subpath: "",
      packageUrl: new URL(url.toString()),
      owner: null,
      repo: null,
    };
  }

  // Guard against known non-package routes (fail fast rather than mis-parse).
  // (Extend this list if you discover more.)
  if (parts[0] === "template" || parts[0] === "badge" || parts[0] === "~") {
    if (!ignoreError) {
      throw new Error(`[parseTarballUrl] not a package URL: ${url.toString()}`);
    }

    return {
      pkgSpec: "",
      name: "",
      version: defaultVersion,
      subpath: "",
      packageUrl: new URL(url.toString()),
      owner: null,
      repo: null,
    };
  }

  // Detect non-compact form: /owner/repo/<pkgSpec>/...
  // The README shows: /${owner}/${repo}/${package}@{commit} 
  let owner: string | null = null;
  let repo: string | null = null;
  let startIndex = 0;

  if (parts.length >= 3) {
    const third = parts[2];

    // Heuristic: the third segment is where the package spec begins.
    // It is either:
    // - "@scope" (scoped package begins)
    // - "name@version" (unscoped with version selector)
    //
    // This matches the documented non-compact examples. 
    if (third.startsWith("@") || third.includes("@")) {
      owner = parts[0] ?? null;
      repo = parts[1] ?? null;
      startIndex = 2;
    }
  }

  // Determine how many segments represent the package spec.
  // Scoped: ["@scope", "name@ver"]  (2 segments)
  // Non-scoped: ["name@ver"]       (1 segment)
  const isScoped = (parts[startIndex] ?? "").startsWith("@");
  const pkgSegCount = isScoped ? 2 : 1;

  if (parts.length < startIndex + pkgSegCount) {
    if (!ignoreError) {
      throw new Error(`[parseTarballUrl] invalid pkg.pr.new package path: ${url.toString()}`);
    }

    return {
      pkgSpec: "",
      name: "",
      version: defaultVersion,
      subpath: "",
      packageUrl: new URL(url.toString()),
      owner,
      repo,
    };
  }

  const pkgSpecParts = parts.slice(startIndex, startIndex + pkgSegCount);
  const rest = parts.slice(startIndex + pkgSegCount);

  const pkgSpec = pkgSpecParts.join("/");

  // Use your existing parser to canonicalize name/version.
  const parsed = parsePackageName(pkgSpec, { ignoreError, defaultVersion });

  // If someone embeds a path in pkgSpec (rare), respect it.
  const subpathFromSpec = parsed.path || "";
  const subpathFromUrl = rest.length > 0 ? `/${rest.join("/")}` : "";
  const subpath = `${subpathFromSpec}${subpathFromUrl}`;

  // Build the package root URL (no subpath, no query/hash).
  const packageUrl = new URL(url.toString());
  packageUrl.search = "";
  packageUrl.hash = "";
  const rootParts: string[] = [];

  if (owner && repo) {
    rootParts.push(owner, repo);
  }

  rootParts.push(...pkgSpecParts);
  packageUrl.pathname = `/${rootParts.join("/")}`;

  return {
    pkgSpec,
    name: parsed.name,
    version: parsed.version,
    subpath,
    packageUrl,
    owner,
    repo,
  };
}


/**
 * Strip the "package/" prefix that npm tarballs typically have
 */
export function stripPackagePrefix(path: string): string {
	if (path.startsWith("package/")) {
		return path.slice("package/".length);
	}
	return path;
}

/**
 * Fetch and extract a tarball into the virtual filesystem
 */
export async function fetchAndExtractTarball<T>(
	url: string,
	packageRoot: string,
	StateContext: Context<LocalState<T>>
): Promise<PackageJson> {
	const FileSystem = fromContext("filesystem", StateContext)!;

  dispatchEvent(LOGGER_INFO, `Fetching tarball candidate: ${url}`);
	
	const { response } = await fetchWithCache(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch tarball: ${response.status} ${response.statusText}`);
	}

  const {
    detection,
    diagnostic,
    bodyForConsumption,
  } = await detectArchiveFromResponse(url, response, {
    peekWireBytes: 1024,
    peekTarBytes: 512,
  });

  // If it isn't even tarball-like, bail early with a useful explanation.
  if (!detection.isTarballLike) {
    dispatchEvent(LOGGER_WARN, diagnostic.summary);
    dispatchEvent(LOGGER_WARN, diagnostic.details);
    throw new Error(
      `TarballPlugin: URL did not resolve to a tarball-like payload.\n` +
        `${diagnostic.summary}\n` +
        `${diagnostic.details}`,
    );
  }

  // If we cannot consume a body, we cannot extract.
  if (!bodyForConsumption) {
    dispatchEvent(LOGGER_WARN, diagnostic.summary);
    dispatchEvent(LOGGER_WARN, diagnostic.details);
    throw new Error(`TarballPlugin: response has no body; cannot extract.\n${diagnostic.summary}`);
  }

  // Hard requirement: we only mount tar containers here.
  // (If you later add ZipPlugin, this becomes a router decision instead of an error.)
  if (detection.container !== "tar") {
    dispatchEvent(LOGGER_WARN, diagnostic.summary);
    dispatchEvent(LOGGER_WARN, diagnostic.details);
    throw new Error(
      `TarballPlugin: payload is not a tar container (detected=${detection.container}).\n` +
        `${diagnostic.summary}\n` +
        `${diagnostic.details}`,
    );
  }
	
	const contentType = response.headers.get("content-type")?.trim().toLowerCase();
	
	// pkg.pr.new returns application/tar+gzip
	if (contentType !== "application/tar+gzip" && !url.endsWith(".tgz") && !url.endsWith(".tar.gz")) {
		throw new Error(`Unexpected content type for tarball: ${contentType}`);
	}
	
  // Build the tar entry stream based on detected wrapper.
  //
  // - gzip: supported via DecompressionStream in most modern runtimes
  // - none/unknown: attempt direct untar (some servers lie; bytes decide)
  // - others: fail with explicit “unsupported compression”
  let tarEntryStream: ReadableStream<TarStreamEntry>;

  if (detection.compression === "gzip") {
    tarEntryStream = bodyForConsumption
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new UntarStream());
  } else if (detection.compression === "none" || detection.compression === "unknown") {
    tarEntryStream = bodyForConsumption.pipeThrough(new UntarStream());
  } else {
    // zstd/xz/bzip2/etc: you detected it correctly, but runtime can't decode it here.
    dispatchEvent(LOGGER_WARN, diagnostic.summary);
    dispatchEvent(LOGGER_WARN, diagnostic.details);
    throw new Error(
      `TarballPlugin: unsupported tar wrapper "${detection.compression}".\n` +
        `Add a decompressor (e.g. zstd) or route this to a dedicated plugin.\n` +
        `${diagnostic.summary}\n` +
        `${diagnostic.details}`,
    );
  }

  // Extract into VFS.
  const reader = tarEntryStream.getReader();
  let manifest: PackageJson | null = null;

  try {
    while (true) {
      const { done, value: entry } = await reader.read();
      if (done) break;

			// Normalize path and strip package/ prefix
      const relativePath = normalize(stripPackagePrefix(entry.path));
      if (!relativePath || relativePath === ".") continue;

			// Skip directories (they're created implicitly by setFile)
      if (entry.path.endsWith("/")) {
				// Consume the readable stream even for directories
        await entry.readable?.cancel();
        continue;
      }

			// Read file contents
      const blob = await new Response(entry.readable).blob();
      const fileContent = new Uint8Array(await blob.arrayBuffer());

			// Write to VFS
      const vfsPath = join(packageRoot, relativePath);
      await setFile(FileSystem, vfsPath, fileContent);

			// Capture package.json
      if (relativePath === "package.json") {
        try {
          const text = new TextDecoder().decode(fileContent);
          manifest = JSON.parse(text) as PackageJson;
        } catch (e) {
          dispatchEvent(LOGGER_WARN, `Failed to parse tarball package.json: ${String(e)}`);
        }
      }
    }
  } catch (e) {
    // This is where archive-detect earns its keep: if untar fails, we print the full reasoning trail.
		dispatchEvent(LOGGER_ERROR, new AggregateError([diagnostic.details], diagnostic.summary, { cause: e}));
    throw new Error(
      `TarballPlugin: extraction failed.\n` +
        `${diagnostic.summary}\n` +
        `${diagnostic.details}\n` +
        `Cause: ${String(e)}`,
    );
  } finally {
    reader.releaseLock();
  }

	// Fallback: try to read package.json from VFS if we missed it
  if (!manifest) {
    try {
      const pkgJsonPath = join(packageRoot, "package.json");
      const text = await getFile(FileSystem, pkgJsonPath, "string");
      if (text) manifest = JSON.parse(text) as PackageJson;
    } catch (e) {
      dispatchEvent(LOGGER_WARN, `Failed to read tarball package.json from VFS: ${String(e)}`);
    }
  }

  if (!manifest) {
    manifest = { name: "unknown", version: "0.0.0" };
  }

  dispatchEvent(
    LOGGER_INFO,
    `Extracted tarball: ${manifest.name}@${manifest.version} -> ${packageRoot} (compression=${detection.compression}, confidence=${detection.confidence})`,
  );

	return manifest;
}

/**
 * Resolve the package entry point using exports or legacy fields
 */
export function resolvePackageEntry(
	manifest: PackageJson,
	subpath: string,
	conditions: ReturnType<typeof getResolverConditions>
): string {
	// Normalize subpath for exports resolution
	const exportSubpath = subpath ? `.${subpath}` : ".";
	
	// Try modern exports resolution first
	try {
		const resolved = resolve(manifest, exportSubpath, {
			browser: conditions.browser,
			conditions: conditions.conditions,
			require: conditions.require
		});
		
		if (resolved) {
			const result = Array.isArray(resolved) ? resolved[0] : resolved;
			if (typeof result === "string") {
				return result.replace(/^\.\//, "/").replace(/^\./, "/");
			}
		}
	} catch {
		// Fall through to legacy resolution
	}
	
	// Try with require fallback if we're in import context
	if (!conditions.require) {
		try {
			const resolved = resolve(manifest, exportSubpath, {
				browser: conditions.browser,
				conditions: ["require", ...conditions.conditions],
				require: true
			});
			
			if (resolved) {
				const result = Array.isArray(resolved) ? resolved[0] : resolved;
				if (typeof result === "string") {
					return result.replace(/^\.\//, "/").replace(/^\./, "/");
				}
			}
		} catch {
			// Fall through to legacy resolution
		}
	}
	
	// For root import without subpath, try legacy resolution
	if (!subpath || subpath === "/") {
		try {
			const legacyResult = legacy(manifest, { browser: conditions.browser }) ||
				legacy(manifest, { fields: ["module", "main"] }) ||
				legacy(manifest, { fields: ["unpkg", "bin"] });
			
			if (legacyResult) {
				if (typeof legacyResult === "string") {
					return legacyResult.replace(/^\.\//, "/").replace(/^\./, "/");
				}
				if (Array.isArray(legacyResult) && legacyResult[0]) {
					return String(legacyResult[0]).replace(/^\.\//, "/").replace(/^\./, "/");
				}
				if (typeof legacyResult === "object") {
					const values = Object.values(legacyResult).filter(v => v && typeof v === "string");
					if (values.length > 0) {
						return String(values[0]).replace(/^\.\//, "/").replace(/^\./, "/");
					}
				}
			}
		} catch {
			// Fall through to default
		}
	}
	
	// If we have a subpath, use it directly
	if (subpath && subpath !== "/") return subpath;
	
	// Last resort: try common entry points
	return "/index.js";
}

/**
 * Get or create tarball mount, handling inflight deduplication
 */
export async function getOrCreateMount<T>(
	tarballUrl: string,
	StateContext: Context<LocalState<T> & TarballState>
): Promise<TarballMount> {
	const mounts = fromContext("tarballMounts", StateContext) ?? new Map<string, TarballMount>();
	const inflight = fromContext("tarballInflight", StateContext) ?? new Map<string, Promise<TarballMount>>();
	
	// Ensure maps are in context
	if (!fromContext("tarballMounts", StateContext)) {
		toContext("tarballMounts", mounts, StateContext);
	}
	if (!fromContext("tarballInflight", StateContext)) {
		toContext("tarballInflight", inflight, StateContext);
	}
	
	const key = await getTarballKey(tarballUrl);
	
	// Check existing mount
	const existing = mounts.get(key);
	if (existing) return existing;
	
	// Check inflight
	const inflightPromise = inflight.get(key);
	if (inflightPromise) return inflightPromise;
	
	// Create new mount
	const mountPromise = (async () => {
		const packageRoot = join(TARBALL_ROOT, key);
		const manifest = await fetchAndExtractTarball(tarballUrl, packageRoot, StateContext);
		
		const mount: TarballMount = {
			createdAt: Date.now(),
			packageRoot,
			manifest,
			sourceUrl: tarballUrl
		};
		
		mounts.set(key, mount);
		inflight.delete(key);
		
		return mount;
	})();
	
	inflight.set(key, mountPromise);
	
	try {
		return await mountPromise;
	} catch (e) {
		inflight.delete(key);
		throw e;
	}
}

/**
 * Check if a path is inside a mounted tarball package
 */
export function findMountForPath<T>(
	vfsPath: string,
	StateContext: Context<LocalState<T> & TarballState>
): TarballMount | null {
	const mounts = fromContext("tarballMounts", StateContext);
	if (!mounts) return null;
	
	for (const mount of mounts.values()) {
		if (vfsPath.startsWith(mount.packageRoot + "/") || vfsPath === mount.packageRoot) {
			return mount;
		}
	}
	
	return null;
}

/**
 * Resolution algorithm for tarball URLs
 * 
 * Handles:
 * - Direct tarball URL imports (https://pkg.pr.new/...)
 * - Self-reference imports from within extracted packages
 * - Subpath imports
 */
export function TarResolution<T>(StateContext: Context<LocalState<T>>) {
	const LocalConfig = fromContext("config", StateContext)!;
	const esbuildOpts = LocalConfig.esbuild ?? {};
	
  return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
		// Handle direct tarball URL imports
    if (/^https?:\/\//.test(args.path)) {
      // Not a valid URL, let other plugins handle
      const url = URL.parse(args.path);
			if (!url) return;
			
      // Not a tarball CDN, let HTTP/CDN plugins handle
			if (!isTarballUrl(url)) return; 
			
			const { subpath, packageUrl } = parseTarballUrl(url);
			const conditions = getResolverConditions(args, esbuildOpts);
			
			try {
				const mount = await getOrCreateMount(packageUrl.toString(), StateContext);
				const entryPath = resolvePackageEntry(mount.manifest, subpath, conditions);
        const resolvedPath = join(mount.packageRoot, entryPath);
				
				return {
					path: resolvedPath,
					namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
          pluginData: Object.assign({}, args.pluginData, {
						manifest: mount.manifest,
						packageRoot: mount.packageRoot,
						tarballUrl: packageUrl.toString(),
					})
        };
			} catch (e) {
				dispatchEvent(LOGGER_ERROR, e as Error);
				throw e;
			}
		}
		
		// Handle self-reference imports from within a tarball package
		// e.g., import { something } from "@tanstack/react-query" from within that package
		const importer = args.pluginData?.importer ?? args.importer;
		if (importer && typeof importer === "string") {
			const mount = findMountForPath(importer, StateContext);
			
			if (mount && mount.manifest.name) {
				const importPath = args.path.replace(/^node:/, "");
				
				// Check if this is a self-reference (import matches package name)
				if (importPath === mount.manifest.name || importPath.startsWith(mount.manifest.name + "/")) {
					const subpath = importPath === mount.manifest.name 
						? "" 
						: importPath.slice(mount.manifest.name.length);
					
					const conditions = getResolverConditions(args, esbuildOpts);
					const entryPath = resolvePackageEntry(mount.manifest, subpath, conditions);
					const resolvedPath = join(mount.packageRoot, entryPath);
					
					return {
						path: resolvedPath,
						namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
						pluginData: Object.assign({}, args.pluginData, {
							manifest: mount.manifest,
							packageRoot: mount.packageRoot,
							tarballUrl: mount.sourceUrl,
						})
					};
				}
			}
		}
		
		// Not a tarball-related import, let other plugins handle
		return;
	};
}

/**
 * Esbuild Tarball plugin
 * 
 * Handles tarball-based package sources like pkg.pr.new by:
 * 1. Intercepting tarball URLs before HTTP plugin
 * 2. Extracting packages to VFS
 * 3. Resolving entry points and self-references
 * 
 * @example
 * ```ts
 * // Plugin order (tarball before HTTP):
 * plugins: [
 *   AliasPlugin(StateContext),
 *   ExternalPlugin(StateContext),
 *   TarballPlugin(StateContext),  // <-- Must be before HTTP
 *   VirtualFileSystemPlugin(StateContext),
 *   HttpPlugin(StateContext),
 *   CdnPlugin(StateContext),
 * ]
 * ```
 */
export function TarballPlugin<T>(StateContext: Context<LocalState<T> & TarballState>): ESBUILD.Plugin {
	// Initialize tarball state if not present
	if (!fromContext("tarballMounts", StateContext))
		toContext("tarballMounts", new Map<string, TarballMount>(), StateContext);

	if (!fromContext("tarballInflight", StateContext))
		toContext("tarballInflight", new Map<string, Promise<TarballMount>>(), StateContext);
	
	return {
		name: TARBALL_NAMESPACE,
		setup(build) {
			// Intercept tarball URLs before HTTP plugin
			build.onResolve({ filter: /.*/ }, TarResolution(StateContext));
			
			// Also handle resolution within the tarball namespace (for chained resolution)
			build.onResolve({ filter: /.*/, namespace: TARBALL_NAMESPACE }, TarResolution(StateContext));
			
			// Handle self-references from VFS namespace (imports from within extracted packages)
			build.onResolve({ filter: /.*/, namespace: VIRTUAL_FILESYSTEM_NAMESPACE }, TarResolution(StateContext));
		},
	};
}