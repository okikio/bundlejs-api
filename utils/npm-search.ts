/**
 * npm Registry API utilities.
 *
 * Provides functions for searching, fetching metadata, and resolving versions
 * from the npm registry. Handles scoped packages correctly by URL-encoding
 * the `/` character as required by the registry.
 *
 * @module
 *
 * @example Basic usage
 * ```ts
 * // Get URLs for a scoped package (note the escaped /)
 * const urls = getRegistryURL("@tanstack/react-query@5.0.0");
 * // urls.packageURL = "https://registry.npmjs.com/@tanstack%2freact-query"
 *
 * // Resolve a version range
 * const version = await resolveVersion("@types/node@^20");
 *
 * // Get full package metadata
 * const pkg = await getResolvedPackage("react@^18");
 * ```
 */

import type {
  FullPackage,
  FullPackageVersion,
  PackageInfo,
  PackageSearchResult,
  RegistryURLs,
  SearchInfo,
} from "./types.ts";

import { fetchWithCache } from "./fetch-and-cache.ts";
import { parsePackageName } from "./parse-package-name.ts";
import { maxSatisfying, parse, parseRange, format } from "./semver.ts";

// =============================================================================
// Constants
// =============================================================================

/** Default npm registry URL. */
export const DEFAULT_REGISTRY = "https://registry.npmjs.com";

// =============================================================================
// URL Utilities
// =============================================================================

/**
 * Escape a package name for use in registry URLs.
 *
 * The npm registry requires scoped package names to have `/` encoded as `%2f`.
 *
 * This follows npm-package-arg's escapedName:
 * ```js
 * this.escapedName = name.replace('/', '%2f')
 * ```
 *
 * See: https://github.com/npm/npm-package-arg/blob/main/lib/npa.js#L224
 *
 * @param name Package name (potentially scoped)
 * @returns URL-safe package name
 *
 * @example
 * escapePackageName("react") // "react"
 * escapePackageName("@types/node") // "@types%2fnode"
 * escapePackageName("@tanstack/react-query") // "@tanstack%2freact-query"
 * 
 * @example
 * escapePackageName("@mdx-js/mdx") -> "@mdx-js%2fmdx"
 *
 * @example
 * escapePackageName("#minpath") -> "%23minpath"
 */
export function escapePackageName(name: string): string {
  return name.replace("/", "%2f");
}

/**
 * Check if a package name is scoped.
 *
 * @param name Package name
 * @returns True if name starts with @
 */
export function isScopedPackage(name: string): boolean {
  return name.startsWith("@");
}

/**
 * Extract scope from a scoped package name.
 *
 * @param name Package name
 * @returns Scope including @ or undefined
 *
 * @example
 * getPackageScope("@types/node") // "@types"
 * getPackageScope("react") // undefined
 */
export function getPackageScope(name: string): string | undefined {
  if (!isScopedPackage(name)) return undefined;
  const slashIdx = name.indexOf("/");
  return slashIdx > 0 ? name.slice(0, slashIdx) : undefined;
}

/**
 * Generate registry URLs for an npm package.
 *
 * **Important**: Scoped package names have `/` encoded as `%2f` in URL paths.
 * This is required by the npm registry.
 *
 * @param input Package name with optional version (e.g., "@okikio/animate@1.0")
 * @param registry Custom registry URL (defaults to npm)
 * @returns URLs and parsed package info
 *
 * @example
 * const urls = getRegistryURL("@okikio/animate@1.0");
 * // {
 * //   searchURL: "https://registry.npmjs.com/-/v1/search?text=@okikio/animate&...",
 * //   packageURL: "https://registry.npmjs.com/@okikio%2fanimate",
 * //   packageVersionURL: "https://registry.npmjs.com/@okikio%2fanimate/1.0",
 * //   version: "1.0",
 * //   name: "@okikio/animate",
 * //   path: ""
 * // }
 */
export function getRegistryURL(
  input: string,
  registry: string = DEFAULT_REGISTRY
): RegistryURLs {
  const host = registry.replace(/\/+$/, "");
  const { name, version, path } = parsePackageName(input);

  // CRITICAL: Scoped packages must have / encoded as %2f
  // See: https://github.com/npm/npm-package-arg/blob/main/lib/npa.js#L224
  const escapedName = escapePackageName(name);

  // Search uses unescaped name in query param (encodeURIComponent handles it)
  const searchURL = `${host}/-/v1/search?text=${encodeURIComponent(name)}&popularity=0.5&size=30`;

  // Package URLs use escaped name in path
  const packageURL = `${host}/${escapedName}`;
  const packageVersionURL = version
    ? `${host}/${escapedName}/${version}`
    : packageURL;

  return {
    searchURL,
    packageURL,
    packageVersionURL,
    version,
    name,
    path,
  };
}

// =============================================================================
// Search API
// =============================================================================

/**
 * Search the npm registry for packages.
 *
 * @param input Package name to search for
 * @param registry Custom registry URL
 * @returns Search results with package metadata
 *
 * @example
 * const result = await getPackages("@okikio/animate");
 * console.log(result.packages.map(p => p.package.name));
 */
export async function getPackages(
  input: string,
  registry?: string
): Promise<PackageSearchResult> {
  const { searchURL } = getRegistryURL(input, registry);
  let result: SearchInfo;

  try {
    const { response } = await fetchWithCache(searchURL, { cacheMode: "reload" });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status} ${response.statusText}`);
    }

    result = await response.json();
  } catch (e) {
    console.warn(`[npm-search] Search failed for "${input}":`, e);
    throw e;
  }

  const packages = result?.objects ?? [];
  return { packages, info: result };
}

// =============================================================================
// Package Metadata API
// =============================================================================

/**
 * Fetch full package metadata (packument) from registry.
 *
 * Returns the complete package document including all versions.
 * For large packages, consider using getPackageOfVersion() instead.
 *
 * @param input Package name (version ignored)
 * @param registry Custom registry URL
 * @returns Full package metadata
 *
 * @example
 * const pkg = await getPackage("@okikio/animate");
 * console.log(Object.keys(pkg.versions));
 * console.log(pkg["dist-tags"]);
 */
export async function getPackage(
  input: string,
  registry?: string
): Promise<FullPackage> {
  const { packageURL, name } = getRegistryURL(input, registry);

  try {
    const { response } = await fetchWithCache(packageURL, { cacheMode: "reload" });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Package not found: ${name}`);
      }
      throw new Error(`Registry error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as FullPackage;
  } catch (e) {
    console.warn(`[npm-search] Failed to fetch "${name}":`, e);
    throw e;
  }
}

/**
 * Fetch metadata for a specific package version.
 *
 * More efficient than getPackage() when you only need one version.
 *
 * @param input Package name with version (e.g., "@okikio/animate@1.0.0")
 * @param registry Custom registry URL
 * @returns Version-specific metadata
 *
 * @example
 * const pkg = await getPackageOfVersion("@okikio/animate@1.0.0");
 * console.log(pkg.dist.tarball);
 */
export async function getPackageOfVersion(
  input: string,
  registry?: string
): Promise<FullPackageVersion> {
  const { packageVersionURL, name, version } = getRegistryURL(input, registry);

  try {
    const { response } = await fetchWithCache(packageVersionURL);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Version not found: ${name}@${version}`);
      }
      throw new Error(`Registry error: ${response.status} ${response.statusText}`);
    }

    return await response.json() as FullPackageVersion;
  } catch (e) {
    console.warn(`[npm-search] Failed to fetch "${name}@${version}":`, e);
    throw e;
  }
}

/**
 * Fetch all versions and dist-tags for a package.
 *
 * @param input Package name (version ignored)
 * @param registry Custom registry URL
 * @returns Versions array and dist-tags object
 *
 * @example
 * const info = await getPackageVersions("@okikio/animate");
 * console.log(info.versions); // ["0.0.3", "0.0.4", ...]
 * console.log(info.tags); // { latest: "2.3.1", beta: "2.4.0" }
 */
export async function getPackageVersions(
  input: string,
  registry?: string
): Promise<PackageInfo> {
  try {
    const pkg = await getPackage(input, registry);
    const versions = Object.keys(pkg.versions);
    const tags = pkg["dist-tags"];
    return { versions, tags };
  } catch (e) {
    console.warn(`[npm-search] Failed to get versions for "${input}":`, e);
    throw e;
  }
}

// =============================================================================
// Version Resolution
// =============================================================================

/**
 * Resolve the best version matching a range.
 *
 * Resolution order:
 * 1. If range matches a dist-tag, return that tag's version
 * 2. If range is an exact version that exists, return it
 * 3. Find the maximum version satisfying the range
 *
 * @param input Package with version range (e.g., "@okikio/animate@^1.0.0")
 * @param registry Custom registry URL
 * @returns Resolved version or null if no match
 *
 * @example
 * const v = await resolveVersion("@okikio/animate@^1.0.0");
 * // Returns highest 1.x.x version
 *
 * const v2 = await resolveVersion("@okikio/animate@latest");
 * // Returns version that 'latest' tag points to
 */
export async function resolveVersion(
  input: string,
  registry?: string
): Promise<string | null> {
  const { version: range, name } = getRegistryURL(input, registry);

  if (!range) {
    console.warn(`[npm-search] No version specified for "${name}"`);
    return null;
  }

  try {
    const { versions, tags } = await getPackageVersions(input, registry);

    // Check if range is a dist-tag
    if (range in tags) {
      return tags[range];
    }

    // Check if exact version exists
    if (versions.includes(range)) {
      return range;
    }

    // Try parsing as semver range
    try {
      const parsedVersions = versions
        .map(v => {
          try {
            return parse(v);
          } catch {
            return null;
          }
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      const semverRange = parseRange(range);
      const maxVersion = maxSatisfying(parsedVersions, semverRange);

      if (maxVersion) {
        return format(maxVersion);
      }
    } catch {
      // Not a valid semver range
    }

    console.warn(`[npm-search] No match for "${name}@${range}"`);
    return null;
  } catch (e) {
    console.warn(`[npm-search] Version resolution failed for "${input}":`, e);
    throw e;
  }
}

/**
 * Fetch metadata for a package with resolved version.
 *
 * Combines resolveVersion() and getPackageOfVersion() for convenience.
 *
 * @param input Package with version range
 * @param registry Custom registry URL
 * @returns Metadata for the resolved version
 *
 * @example
 * const pkg = await getResolvedPackage("@okikio/animate@^1.0.0");
 * console.log(pkg.version); // Resolved from ^1.0.0
 */
export async function getResolvedPackage(
  input: string,
  registry?: string
): Promise<FullPackageVersion> {
  const { name } = getRegistryURL(input, registry);
  const version = await resolveVersion(input, registry);

  if (!version) {
    throw new Error(`Could not resolve version for "${input}"`);
  }

  return getPackageOfVersion(`${name}@${version}`, registry);
}