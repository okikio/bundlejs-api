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

import { normalize, join, resolve as resolvePath } from "@bundle/utils/path";
import { fetchWithCache } from "@bundle/utils/fetch-and-cache";

import { VIRTUAL_FILESYSTEM_NAMESPACE, resolveVfsPath } from "./fs.ts";
import { EXCLUDED_MODULE_NAMESPACE } from "./http.ts";
import { dispatchEvent, LOGGER_INFO, LOGGER_WARN, LOGGER_ERROR } from "../configs/events.ts";

import { getResolverConditions, getLegacyMainFields } from "../../utils/resolve-conditions.ts";
import { setFile, getFile } from "../utils/filesystem.ts";
import { getCDNStyle } from "../utils/cdn-format.ts";
import { RESOLVE_EXTENSIONS } from "../utils/loader.ts";
import {
  resolvePackageEntry as resolvePackageEntryShared,
  normalizeResolvedPath,
} from "../utils/cdn-resolution.ts";

import {
	detectArchiveFromResponse,
  detectArchiveFromPathHint,
} from "@bundle/utils/archive-detect";

import { parsePackageName } from "@bundle/utils/parse-package-name";

/** Tarball Plugin Namespace */
export const TARBALL_NAMESPACE = "tarball-url";

/**
 * Walk URL pathname segments to locate the tarball filename.
 *
 * Delegates per-segment detection to `detectArchiveFromPathHint()` from
 * archive-detect, which handles:
 * - Multi-extension priority (`.tar.gz` before `.tar`)
 * - Short conventions (`.tgz`, `.txz`, `.tzst`)
 * - Ambiguous cases (`.gz` alone → `isTarballLike: false`)
 * - Confidence and container/compression classification
 *
 * Returns the split point: everything up to and including the tarball
 * segment is the fetch URL; everything after is a subpath.
 *
 * This avoids re-inventing archive-detect's extension matching with custom
 * regex — the detection function is the single source of truth for "is this
 * filename a tarball?" and the tar plugin should not duplicate that logic.
 *
 * @returns The tarball pathname and remaining subpath, or null if no segment is tarball-like.
 *
 * @example
 * findTarballSplitInPathname("/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator")
 * // { tarballPath: "/drizzle-orm/-/drizzle-orm-0.45.1.tgz", subpath: "/expo-sqlite/migrator" }
 *
 * @example
 * findTarballSplitInPathname("/path/to/package.tar.gz")
 * // { tarballPath: "/path/to/package.tar.gz", subpath: "" }
 */
export function findTarballSplitInPathname(
  pathname: string,
): { tarballPath: string; subpath: string } | null {
  const segments = pathname.split("/");

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;

    const hint = detectArchiveFromPathHint(segment);
    if (hint.isTarballLike) {
      // Reconstruct the tarball path preserving leading slash and all segments up to here.
      const tarballPath = segments.slice(0, i + 1).join("/");
      const rest = segments.slice(i + 1).filter(Boolean);
      return {
        tarballPath,
        subpath: rest.length > 0 ? `/${rest.join("/")}` : "",
      };
    }
  }

  return null;
}

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
 * Check if a filesystem path (absolute or relative) looks like a tarball,
 * possibly with a subpath appended.
 *
 * Delegates to `findTarballSplitInPathname()`, which in turn delegates to
 * `detectArchiveFromPathHint()` from archive-detect.
 *
 * This is the path-based counterpart to `isTarballUrl()`. Use it when the
 * input is a VFS path or any non-URL string.
 *
 * @example
 * ```ts
 * isTarballPath("/packages/my-lib.tgz")                     // true
 * isTarballPath("/packages/my-lib.tgz/lib/index")           // true
 * isTarballPath("/src/index.ts")                             // false
 * ```
 */
export function isTarballPath(path: string): boolean {
  return findTarballSplitInPathname(path) !== null;
}

/**
 * Check if a URL points to a tarball source.
 *
 * Two categories:
 * 1. CDN-style tarball providers (e.g., pkg.pr.new)
 * 2. Direct tarball URLs (*.tgz, *.tar.gz) from any origin
 *    — npm registry, GitHub release assets, custom servers, etc.
 *
 * @example CDN-style
 * ```ts
 * isTarballUrl(new URL("https://pkg.pr.new/@tanstack/react-query@7988"))  // true
 * ```
 *
 * @example Registry tarball
 * ```ts
 * isTarballUrl(new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz"))  // true
 * ```
 *
 * @example With subpath (still a tarball)
 * ```ts
 * isTarballUrl(new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator"))  // true
 * ```
 */
export function isTarballUrl(url: URL): boolean {
  // CDN-style tarball providers (pkg.pr.new, etc.)
  if (getCDNStyle(url.origin) === "tarball") return true;

  // Direct tarball URLs: delegates to the path-based check.
  return isTarballPath(url.pathname);
}

/**
 * Generate a stable, content-addressed key for a tarball source.
 *
 * Accepts both HTTP URLs and VFS paths:
 * - HTTP URLs are normalized (sorted params, stripped hash) for stable keys
 * - VFS paths (e.g., `/packages/my-lib.tgz`) are hashed directly
 */
async function getTarballKey(source: string): Promise<string> {
  let keyInput: string;

  if (/^https?:\/\//.test(source)) {
    // HTTP URL: normalize for stable keys
    const normalized = new URL(source);
    normalized.hash = "";

    // Sort search params for consistency
    const params = Array.from(normalized.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    normalized.search = "";
    for (const [k, v] of params) {
      normalized.searchParams.append(k, v);
    }

    keyInput = normalized.toString();
  } else {
    // VFS path: use the absolute path directly as key material
    keyInput = resolvePath(source);
  }

  const bytes = new TextEncoder().encode(keyInput);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hashArray = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0"));
  return hashArray.join("").slice(0, 16);
}

// =============================================================================
// Generic tarball URL parsing (registry tarballs, GitHub releases, etc.)
// =============================================================================

export interface ParseGenericTarballUrlResult {
  /** The tarball URL (for fetching) — everything up to and including .tgz/.tar.gz */
  tarballUrl: URL;
  /** Any path segments after the archive extension, e.g. "/expo-sqlite/migrator" */
  subpath: string;
}

/**
 * Parse a generic tarball URL by splitting at the archive extension.
 *
 * Works for any URL with .tgz or .tar.gz in the pathname, including:
 * - npm registry: `https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz`
 * - With subpath:  `https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite`
 * - GitHub release: `https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz`
 * - Generic:       `https://example.com/path/to/package.tgz/lib/index.js`
 *
 * Algorithm:
 * 1. Find the first `.tgz` or `.tar.gz` in the pathname
 * 2. Everything up to (and including) that extension → tarball fetch URL
 * 3. Everything after → subpath for entry point resolution
 *
 * @example No subpath
 * ```ts
 * const r = parseGenericTarballUrl(new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz"));
 * // r.tarballUrl.href -> "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz"
 * // r.subpath         -> ""
 * ```
 *
 * @example With subpath
 * ```ts
 * const r = parseGenericTarballUrl(
 *   new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator")
 * );
 * // r.tarballUrl.href -> "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz"
 * // r.subpath         -> "/expo-sqlite/migrator"
 * ```
 */
export function parseGenericTarballUrl(url: URL): ParseGenericTarballUrlResult {
  // Delegate to findTarballSplitInPathname which walks path segments
  // and uses detectArchiveFromPathHint() per segment.
  const split = findTarballSplitInPathname(url.pathname);

  if (!split) {
    // Not a tarball URL by extension — return as-is with no subpath.
    // This shouldn't happen if callers check isTarballUrl() first.
    return {
      tarballUrl: new URL(url.toString()),
      subpath: "",
    };
  }

  const tarballUrl = new URL(url.toString());
  tarballUrl.pathname = split.tarballPath;
  tarballUrl.search = "";
  tarballUrl.hash = "";

  return { tarballUrl, subpath: split.subpath };
}

// =============================================================================
// pkg.pr.new URL parsing
// =============================================================================

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
 * Fetch (or read from VFS) and extract a tarball into the virtual filesystem.
 *
 * Accepts two kinds of source:
 * - **HTTP URL** (`https://...`) — fetched via the shared HTTP cache.
 * - **VFS path** (`/packages/my-lib.tgz`) — read from the in-memory filesystem.
 *
 * After obtaining bytes, both paths converge into the same detect → decompress → extract
 * pipeline via `detectArchiveFromResponse()`.
 */
export async function fetchAndExtractTarball<T>(
  source: string,
	packageRoot: string,
	StateContext: Context<LocalState<T>>
): Promise<PackageJson> {
	const FileSystem = fromContext("filesystem", StateContext)!;

  let response: Response;

  if (/^https?:\/\//.test(source)) {
    // HTTP: fetch from network / shared cache.
    dispatchEvent(LOGGER_INFO, `Fetching tarball candidate: ${source}`);
    const signal = fromContext("abortSignal", StateContext);
    const result = await fetchWithCache(source, { signal });
    response = result.response;
    
    // Build descriptive log message
    const flags = [
      result.fromCache && 'cached',
      result.redirected && 'redirected',
    ].filter(Boolean).join(', ');
    
    const flagStr = flags ? ` (${flags})` : '';
    const redirectStr = result.redirected ? ` → ${result.url}` : '';
    
    dispatchEvent(LOGGER_INFO, `Fetch${flagStr} ${source}${redirectStr}`);

    if (!response.ok) {
      throw new Error(`Failed to fetch tarball: ${response.status} ${response.statusText}`);
    }
  } else {
    // VFS: read bytes from the in-memory filesystem.
    dispatchEvent(LOGGER_INFO, `Reading VFS tarball: ${source}`);
    const bytes = await getFile(FileSystem, source, "buffer");

    if (!bytes) {
      throw new Error(`TarballPlugin: VFS file not found: ${source}`);
    }

    // Wrap in a Response so the detection pipeline works identically.
    // The cast is safe: VFS always stores ArrayBuffer-backed Uint8Arrays,
    // but the generic type widens to ArrayBufferLike for SharedArrayBuffer compat.
    response = new Response(bytes as Uint8Array<ArrayBuffer>);
  }

  const {
    detection,
    diagnostic,
    bodyForConsumption,
  } = await detectArchiveFromResponse(source, response, {
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
	
  // NOTE: The content-type check that was here has been removed.
  // The detectArchiveFromResponse() call above already validated that:
  //   1. detection.isTarballLike === true
  //   2. detection.container === "tar"
  // That's authoritative (magic-byte based). A content-type check was redundant
  // and blocked legitimate tarballs from registries that return
  // "application/octet-stream" instead of "application/tar+gzip".
	
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
 * Resolve the package entry point using the shared resolution algorithm.
 *
 * Delegates to `resolvePackageEntryShared` from `cdn-resolution.ts` which handles:
 * - Modern `exports` field (with ESM+CJS fallback)
 * - Legacy `main`/`module`/`browser` fields
 * - Path remappings (browser, react-native, electron)
 * - `./index.js` last-resort fallback
 *
 * Returns a VFS-relative path (starts with `/`).
 *
 * @param manifest  The tarball's package.json
 * @param subpath   URL subpath after the tarball (e.g., "/expo-sqlite/migrator")
 * @param conditions  Active resolver conditions
 * @param args      Optional esbuild args for computing legacy main fields
 */
export function resolvePackageEntry(
	manifest: PackageJson,
	subpath: string,
  conditions: ReturnType<typeof getResolverConditions>,
  args?: { kind: ESBUILD.ImportKind },
): { entryPath: string; pathRemappings: Record<string, string | false> | null; excluded: boolean; error?: Error } {
  // Compute legacy fields from the manifest + conditions
  const legacyFields = getLegacyMainFields(
    manifest,
    args ?? { kind: "import-statement" },
    { platform: conditions.browser ? "browser" : "neutral" },
  );

  // Normalize subpath: "/expo-sqlite/migrator" → "./expo-sqlite/migrator"
  const normalizedSubpath = subpath
    ? subpath.replace(/^\//, "./").replace(/^(?!\.)/, "./")
    : ".";

  const result = resolvePackageEntryShared({
    manifest,
    subpath: normalizedSubpath === "./" ? "." : normalizedSubpath,
    conditions,
    legacyFields,
    allowLiteralSubpath: normalizedSubpath !== "." && normalizedSubpath !== "./",
  });

  if (result.excluded) {
    return {
      entryPath: subpath || "/index.js",
      pathRemappings: result.pathRemappings,
      excluded: true,
      error: result.error,
    };
	}

  // Convert the resolved path to VFS-relative format (leading `/`)
  let entryPath = result.path
    ? normalizeResolvedPath(result.path)
    : (subpath && subpath !== "/" ? subpath : "/index.js");

  // Guard against directory-like root entries (".", "./", "/", "/.").
  // These are not loadable files in VFS and can cause esbuild to attempt
  // directory reads (e.g. "Cannot read directory '.': not implemented on js").
  if (entryPath === "/" || entryPath === "/.") {
    entryPath = "/index.js";
  }

  return {
    entryPath,
    pathRemappings: result.pathRemappings,
    excluded: false,
  };
}

/**
 * Resolve entry point and probe VFS for correct extension.
 *
 * After `resolvePackageEntry` determines the logical path, this function
 * verifies the file exists in VFS and handles extensionless imports
 * (e.g., `./Expo.fx` might need to become `./Expo.fx.js`).
 *
 * @param manifest      The tarball's package.json
 * @param subpath       URL subpath after the tarball
 * @param conditions    Active resolver conditions
 * @param packageRoot   VFS root for this tarball mount
 * @param FileSystem    VFS instance for probing
 * @param args          Optional esbuild args for legacy field computation
 */
export async function resolveAndProbeEntry<T>(
  manifest: PackageJson,
  subpath: string,
  conditions: ReturnType<typeof getResolverConditions>,
  packageRoot: string,
  FileSystem: import("../utils/filesystem.ts").IFileSystem<T>,
  args?: { kind: ESBUILD.ImportKind },
): Promise<{ resolvedPath: string; pathRemappings: Record<string, string | false> | null; excluded: boolean; error?: Error }> {
  const resolution = resolvePackageEntry(manifest, subpath, conditions, args);

  if (resolution.excluded) {
    return {
      resolvedPath: join(packageRoot, resolution.entryPath),
      pathRemappings: resolution.pathRemappings,
      excluded: true,
      error: resolution.error,
    };
	}

  const candidatePath = join(packageRoot, resolution.entryPath);

  // Probe VFS: exact match → extension probing → index.* fallback
  const probed = await resolveVfsPath(
    FileSystem,
    candidatePath,
    RESOLVE_EXTENSIONS,
    true, // enableIndexFallback
  );

  return {
    resolvedPath: probed ?? candidatePath,
    pathRemappings: resolution.pathRemappings,
    excluded: false,
  };
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
  const resolveOpts = LocalConfig.resolve ?? {};
  const effectiveResolveOpts = Object.assign({}, resolveOpts, esbuildOpts);
  const FileSystem = fromContext("filesystem", StateContext)!;

  return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
    // ─── Branch 1: HTTP tarball URLs ───────────────────────────────────────
    if (/^https?:\/\//.test(args.path)) {
      const url = URL.parse(args.path);
			if (!url) return;

      // Not a tarball URL → let HTTP/CDN plugins handle.
      if (!isTarballUrl(url)) return;

      // Route to the right parser based on tarball source.
      //
      // pkg.pr.new uses a custom URL scheme: /@scope/name@version/subpath
      // Registry/generic tarballs use file extensions: /path/to/pkg.tgz/subpath
      let subpath: string;
      let packageUrl: URL;

      if (getCDNStyle(url.origin) === "tarball") {
        // pkg.pr.new style — dedicated parser
        const parsed = parseTarballUrl(url);
        subpath = parsed.subpath;
        packageUrl = parsed.packageUrl;
      } else {
        // Generic tarball URL (.tgz / .tar.gz) — split at extension
        const parsed = parseGenericTarballUrl(url);
        subpath = parsed.subpath;
        packageUrl = parsed.tarballUrl;
      }

      const conditions = getResolverConditions(args, effectiveResolveOpts);

			try {
				const mount = await getOrCreateMount(packageUrl.toString(), StateContext);
        const { resolvedPath, pathRemappings, excluded, error } = await resolveAndProbeEntry(
          mount.manifest, subpath, conditions, mount.packageRoot, FileSystem, args,
        );

        if (excluded) {
          const packagePolicy = LocalConfig.remapFalse?.packageRemapFalse ?? "error";
          if (packagePolicy === "stub") {
            const warnOnStub = LocalConfig.remapFalse?.warnOnStubbedRemapFalse ?? true;
            return {
              path: `${mount.manifest.name ?? "unknown"}/${subpath || "."}`,
              namespace: EXCLUDED_MODULE_NAMESPACE,
              pluginData: Object.assign({}, args.pluginData, {
                excludedBy: "field-remapping",
                originalPath: subpath || ".",
                suppressWarning: !warnOnStub,
              }),
            };
          }
          return {
            errors: [{
              text: `Package "${mount.manifest.name}" is excluded for the current environment`,
              detail: error?.message ?? "Excluded by path remapping field",
            }],
          };
        }

				return {
					path: resolvedPath,
					namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
          pluginData: Object.assign({}, args.pluginData, {
						manifest: mount.manifest,
						packageRoot: mount.packageRoot,
						tarballUrl: packageUrl.toString(),
            pathRemappings,
					})
        };
			} catch (e) {
				dispatchEvent(LOGGER_ERROR, e as Error);
				throw e;
			}
		}

    // ─── Branch 2: VFS tarball paths ──────────────────────────────────────
    //
    // A tarball can live in the in-memory VFS just like any other file.
    // If someone writes:
    //   import { something } from "/packages/my-lib.tgz/lib/index";
    // or:
    //   await setFile(fs, "/vendor/pkg.tar.gz", bytes);
    //   import utils from "/vendor/pkg.tar.gz";
    //
    // The VFS plugin can't resolve the full path (the tarball is a single
    // blob, not extracted files), so it returns undefined and we get a chance.
    // We split at the tarball segment, extract to a mount, and resolve.
    {
      // For relative paths, resolve against the importer's directory first.
      const candidatePath = (args.path.startsWith("./") || args.path.startsWith("../"))
        ? resolvePath(args.resolveDir || "/", args.path)
        : args.path;

      // Only process absolute paths — bare specifiers ("react", "@scope/pkg")
      // must not enter this branch.
      if (candidatePath.startsWith("/")) {
        const split = findTarballSplitInPathname(candidatePath);

        if (split) {
          const conditions = getResolverConditions(args, effectiveResolveOpts);

          try {
            const mount = await getOrCreateMount(split.tarballPath, StateContext);
            const { resolvedPath, pathRemappings, excluded, error } = await resolveAndProbeEntry(
              mount.manifest, split.subpath, conditions, mount.packageRoot, FileSystem, args,
            );

            if (excluded) {
              const packagePolicy = LocalConfig.remapFalse?.packageRemapFalse ?? "error";
              if (packagePolicy === "stub") {
                const warnOnStub = LocalConfig.remapFalse?.warnOnStubbedRemapFalse ?? true;
                return {
                  path: `${mount.manifest.name ?? "unknown"}/${split.subpath || "."}`,
                  namespace: EXCLUDED_MODULE_NAMESPACE,
                  pluginData: Object.assign({}, args.pluginData, {
                    excludedBy: "field-remapping",
                    originalPath: split.subpath || ".",
                    suppressWarning: !warnOnStub,
                  }),
                };
              }
              return {
                errors: [{
                  text: `Package "${mount.manifest.name}" is excluded for the current environment`,
                  detail: error?.message ?? "Excluded by path remapping field",
                }],
              };
            }

            return {
              path: resolvedPath,
              namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
              pluginData: Object.assign({}, args.pluginData, {
                manifest: mount.manifest,
                packageRoot: mount.packageRoot,
                tarballUrl: split.tarballPath,
                pathRemappings,
              })
            };
          } catch (e) {
            dispatchEvent(LOGGER_ERROR, e as Error);
            throw e;
          }
        }
      }
    }

    // ─── Branch 3: Self-reference imports from within a tarball ─────────
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
					
          const conditions = getResolverConditions(args, effectiveResolveOpts);
          const { resolvedPath, pathRemappings, excluded, error } = await resolveAndProbeEntry(
            mount.manifest, subpath, conditions, mount.packageRoot, FileSystem, args,
          );

          if (excluded) {
            const packagePolicy = LocalConfig.remapFalse?.packageRemapFalse ?? "error";
            if (packagePolicy === "stub") {
              const warnOnStub = LocalConfig.remapFalse?.warnOnStubbedRemapFalse ?? true;
              return {
                path: `${mount.manifest.name}/${subpath || "."}`,
                namespace: EXCLUDED_MODULE_NAMESPACE,
                pluginData: Object.assign({}, args.pluginData, {
                  excludedBy: "field-remapping",
                  originalPath: subpath || ".",
                  suppressWarning: !warnOnStub,
                }),
              };
            }
            return {
              errors: [{
                text: `Self-reference "${importPath}" excluded for the current environment`,
                detail: error?.message ?? "Excluded by path remapping field",
              }],
            };
          }

					return {
						path: resolvedPath,
						namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
						pluginData: Object.assign({}, args.pluginData, {
							manifest: mount.manifest,
							packageRoot: mount.packageRoot,
							tarballUrl: mount.sourceUrl,
              pathRemappings,
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
 * 1. Intercepting tarball URLs and VFS tarball paths before HTTP/VFS plugins
 * 2. Extracting packages to VFS
 * 3. Resolving entry points and self-references
 * 
 * @example
 * ```ts
 * // Plugin order (tarball before VFS and HTTP):
 * plugins: [
 *   AliasPlugin(StateContext),
 *   ExternalPlugin(StateContext),
 *   TarballPlugin(StateContext),  // <-- Must be before VFS and HTTP
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