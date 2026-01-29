/**
 * JSR (jsr.io) Registry Utilities
 *
 * Complete utilities for working with the JSR (JavaScript Registry):
 * - Package specifier parsing with validation
 * - Direct registry API access (no esm.sh proxy needed)
 * - Package metadata and version resolution
 * - Search functionality
 * - npm compatibility layer support
 *
 * JSR is a modern TypeScript-first registry that works with Deno, Node.js,
 * Bun, browsers, and more. Unlike npm, JSR packages are always scoped.
 *
 * ## API Summary
 *
 * JSR has three distinct APIs:
 * 1. **Registry API** (jsr.io) - For downloading modules and package metadata
 *    - Module: `https://jsr.io/@<scope>/<name>/<version>/<path>`
 *    - Package meta: `https://jsr.io/@<scope>/<name>/meta.json`
 *    - Version meta: `https://jsr.io/@<scope>/<name>/<version>_meta.json`
 *
 * 2. **npm Compatibility API** (npm.jsr.io) - For npm-compatible package managers
 *    - Package: `https://npm.jsr.io/@jsr/<scope>__<name>`
 *
 * 3. **Management API** (api.jsr.io) - For publishing and search (NOT for registry operations)
 *    - Search: `https://api.jsr.io/packages?query=...`
 *
 * @module
 *
 * @example Basic usage
 * ```ts
 * import {
 *   parseJSRSpec,
 *   isJSRSpec,
 *   getJSRModuleUrl,
 *   resolveJSRVersion,
 * } from "./jsr.ts";
 *
 * // Parse a JSR specifier
 * const spec = parseJSRSpec("jsr:@std/path@^1.0.0/posix");
 * // { kind: "jsr", scope: "std", name: "path", version: "^1.0.0", subpath: "/posix" }
 *
 * // Check if a string is a JSR specifier
 * isJSRSpec("jsr:@std/path")  // true
 * isJSRSpec("npm:lodash")     // false
 *
 * // Get direct module URL (no proxy needed!)
 * getJSRModuleUrl("std", "path", "1.0.0", "/mod.ts")
 * // "https://jsr.io/@std/path/1.0.0/mod.ts"
 *
 * // Resolve version ranges
 * await resolveJSRVersion({ scope: "std", name: "path", version: "^1.0.0" })
 * // "1.0.8" (or whatever the latest matching version is)
 * ```
 *
 * @see https://jsr.io/docs/api
 * @see https://jsr.io/docs/packages
 */

import { fetchWithCache } from "./fetch-and-cache.ts";
import { maxSatisfying, parse, parseRange, format } from "./semver.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed JSR package specifier.
 *
 * @example
 * ```ts
 * const spec: JSRSpec = {
 *   kind: "jsr",
 *   raw: "jsr:@std/path@1.0.0/posix",
 *   scope: "std",           // WITHOUT @ prefix (matches registry API)
 *   name: "path",
 *   fullName: "@std/path",  // WITH @ prefix for display/import maps
 *   version: "1.0.0",
 *   subpath: "/posix"
 * };
 * ```
 */
export interface JSRSpec {
  /** Always "jsr" for JSR specifiers */
  kind: "jsr";
  /** Original raw specifier string */
  raw: string;
  /** Package scope WITHOUT @ prefix (e.g., "std" from "@std/path") */
  scope: string;
  /** Package name without scope (e.g., "path" from "@std/path") */
  name: string;
  /** Full package name with scope (e.g., "@std/path") */
  fullName: string;
  /** Version or version range, null if not specified */
  version: string | null;
  /** Subpath import (e.g., "/posix"), empty string if none */
  subpath: string;
}

/**
 * JSR package metadata from the registry API.
 *
 * Fetched from: `https://jsr.io/@<scope>/<name>/meta.json`
 *
 * @example API Response
 * ```json
 * {
 *   "scope": "std",
 *   "name": "path",
 *   "versions": {
 *     "1.0.0": {},
 *     "1.0.1": { "yanked": true },
 *     "1.0.2": {}
 *   }
 * }
 * ```
 */
export interface JSRPackageMeta {
  /** Scope name without @ */
  scope: string;
  /** Package name */
  name: string;
  /** Map of version strings to version metadata */
  versions: Record<string, JSRVersionSummary>;
}

/**
 * Version summary in package metadata.
 */
export interface JSRVersionSummary {
  /** Whether this version has been yanked */
  yanked?: boolean;
}

/**
 * JSR version metadata from the registry API.
 *
 * Fetched from: `https://jsr.io/@<scope>/<name>/<version>_meta.json`
 *
 * @example API Response
 * ```json
 * {
 *   "manifest": {
 *     "/mod.ts": {
 *       "size": 2989,
 *       "checksum": "sha256-a41796ceb..."
 *     }
 *   },
 *   "exports": { ".": "./mod.ts" },
 *   "moduleGraph1": { "/mod.ts": {} }
 * }
 * ```
 */
export interface JSRVersionMeta {
  /** File manifest with sizes and checksums */
  manifest: Record<string, JSRFileInfo>;
  /** Module graph for preloading (version 1 format) */
  moduleGraph1?: Record<string, Record<string, unknown>>;
  /** Module graph for preloading (version 2 format) */
  moduleGraph2?: Record<string, Record<string, unknown>>;
  /** Package exports mapping */
  exports: Record<string, string>;
}

/**
 * File information in version manifest.
 */
export interface JSRFileInfo {
  /** File size in bytes */
  size: number;
  /** SHA-256 checksum with algorithm prefix */
  checksum: string;
}

/**
 * npm compatibility metadata from npm.jsr.io.
 *
 * Fetched from: `https://npm.jsr.io/@jsr/<scope>__<name>`
 */
export interface JSRNpmMeta {
  /** npm compatibility name (@jsr/scope__name) */
  name: string;
  /** Package description */
  description?: string;
  /** Distribution tags (e.g., latest) */
  "dist-tags": Record<string, string>;
  /** Version metadata map */
  versions: Record<string, JSRNpmVersionMeta>;
  /** Publication timestamps */
  time: Record<string, string>;
}

/**
 * npm compatibility version metadata.
 */
export interface JSRNpmVersionMeta {
  /** npm compatibility name */
  name: string;
  /** Version string */
  version: string;
  /** Package description */
  description?: string;
  /** Distribution info */
  dist: {
    tarball: string;
    integrity?: string;
    shasum?: string;
  };
  /** Dependencies */
  dependencies?: Record<string, string>;
}

/**
 * Package name validation result.
 */
export interface JSRNameValidation {
  /** Whether the name is valid */
  valid: boolean;
  /** Validation errors (name cannot be used) */
  errors: string[];
  /** Validation warnings (name works but has issues) */
  warnings: string[];
}

/**
 * Search result from JSR management API.
 *
 * Note: Search uses api.jsr.io, which is separate from the registry API.
 */
export interface JSRSearchResult {
  /** Search result items */
  items: JSRPackageInfo[];
  /** Total number of matching packages */
  total: number;
}

/**
 * Package info from search results.
 */
export interface JSRPackageInfo {
  /** Scope name (without @) */
  scope: string;
  /** Package name */
  name: string;
  /** Package description */
  description?: string;
  /** Latest version */
  latestVersion?: string;
  /** Runtime compatibility flags */
  runtimeCompat?: {
    deno?: boolean;
    node?: boolean;
    browsers?: boolean;
    bun?: boolean;
    workerd?: boolean;
  };
  /** JSR score (0-100) */
  score?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** JSR registry base URL for direct module access */
export const JSR_REGISTRY = "https://jsr.io";

/** JSR management API base URL (for search, NOT for registry operations) */
export const JSR_API = "https://api.jsr.io";

/** JSR npm compatibility registry URL */
export const JSR_NPM_REGISTRY = "https://npm.jsr.io";

/**
 * JSR scope naming constraints.
 *
 * From https://jsr.io/docs/scopes:
 * - 2-20 characters
 * - Lowercase letters, numbers, hyphens
 * - Cannot start with a hyphen
 */
export const JSR_SCOPE_RULES = {
  minLength: 2,
  maxLength: 20,
  pattern: /^[a-z][a-z0-9-]*$/,
} as const;

/**
 * JSR package naming constraints.
 *
 * From https://jsr.io/docs/packages:
 * - 2-58 characters
 * - Lowercase letters, numbers, hyphens
 * - Cannot start with a hyphen
 */
export const JSR_PACKAGE_RULES = {
  minLength: 2,
  maxLength: 58,
  pattern: /^[a-z][a-z0-9-]*$/,
} as const;

/**
 * Pattern for parsing JSR specifiers.
 *
 * Matches: `jsr:@scope/name@version/subpath`
 * - Scope is required (starts with @)
 * - Version is optional
 * - Subpath is optional
 *
 * Uses strict lowercase validation for scope and name.
 */
const JSR_SPEC_PATTERN = /^jsr:@([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)(?:@([^\/]+))?(\/.*)?$/;

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse a JSR specifier string.
 *
 * JSR specifiers follow the format: `jsr:@scope/name@version/subpath`
 *
 * @param input The specifier string
 * @returns Parsed spec or null if invalid
 *
 * @example Valid specifiers
 * ```ts
 * parseJSRSpec("jsr:@std/path")
 * // {
 * //   kind: "jsr",
 * //   raw: "jsr:@std/path",
 * //   scope: "std",        // Note: WITHOUT @ prefix
 * //   name: "path",
 * //   fullName: "@std/path",
 * //   version: null,
 * //   subpath: ""
 * // }
 *
 * parseJSRSpec("jsr:@std/path@1.0.0")
 * // { ..., version: "1.0.0", subpath: "" }
 *
 * parseJSRSpec("jsr:@std/path@^1.0.0/posix")
 * // { ..., version: "^1.0.0", subpath: "/posix" }
 * ```
 *
 * @example Invalid specifiers
 * ```ts
 * parseJSRSpec("npm:lodash")     // null (wrong protocol)
 * parseJSRSpec("jsr:lodash")     // null (missing scope)
 * parseJSRSpec("@std/path")      // null (missing jsr: prefix)
 * parseJSRSpec("jsr:@STD/path")  // null (uppercase not allowed)
 * ```
 */
export function parseJSRSpec(input: string): JSRSpec | null {
  if (!input || typeof input !== "string") {
    return null;
  }

  const trimmed = input.trim();

  // Must start with jsr:
  if (!trimmed.startsWith("jsr:")) {
    return null;
  }

  const match = JSR_SPEC_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, scope, name, version, subpath] = match;

  return {
    kind: "jsr",
    raw: input,
    scope,
    name,
    fullName: `@${scope}/${name}`,
    version: version ?? null,
    subpath: subpath ?? "",
  };
}

/**
 * Check if a string is a JSR specifier.
 *
 * @param input String to check
 * @returns True if it's a valid jsr: specifier
 *
 * @example
 * ```ts
 * isJSRSpec("jsr:@std/path")  // true
 * isJSRSpec("npm:lodash")     // false
 * isJSRSpec("@std/path")      // false (missing prefix)
 * ```
 */
export function isJSRSpec(input: string): boolean {
  return parseJSRSpec(input) !== null;
}

/**
 * Check if a string looks like a JSR specifier (quick check).
 *
 * Faster than parseJSRSpec for filtering.
 */
export function looksLikeJSRSpec(input: string): boolean {
  return typeof input === "string" && input.startsWith("jsr:");
}

// =============================================================================
// Name Validation
// =============================================================================

/**
 * Validate a JSR scope name.
 *
 * @param scope Scope name (with or without @ prefix)
 * @returns Validation result
 *
 * @example
 * ```ts
 * validateJSRScope("std")
 * // { valid: true, errors: [], warnings: [] }
 *
 * validateJSRScope("a")
 * // { valid: false, errors: ["Scope must be 2-20 characters (got 1)"], warnings: [] }
 * ```
 */
export function validateJSRScope(scope: string): JSRNameValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = scope.startsWith("@") ? scope.slice(1) : scope;

  if (name.length < JSR_SCOPE_RULES.minLength || name.length > JSR_SCOPE_RULES.maxLength) {
    errors.push(`Scope must be ${JSR_SCOPE_RULES.minLength}-${JSR_SCOPE_RULES.maxLength} characters (got ${name.length})`);
  }

  if (name.startsWith("-")) {
    errors.push("Scope cannot start with a hyphen");
  }

  if (!JSR_SCOPE_RULES.pattern.test(name)) {
    errors.push("Scope must contain only lowercase letters, numbers, and hyphens");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a JSR package name.
 *
 * @param name Package name (without scope)
 * @returns Validation result
 */
export function validateJSRPackageName(name: string): JSRNameValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (name.length < JSR_PACKAGE_RULES.minLength || name.length > JSR_PACKAGE_RULES.maxLength) {
    errors.push(`Package name must be ${JSR_PACKAGE_RULES.minLength}-${JSR_PACKAGE_RULES.maxLength} characters (got ${name.length})`);
  }

  if (name.startsWith("-")) {
    errors.push("Package name cannot start with a hyphen");
  }

  if (!JSR_PACKAGE_RULES.pattern.test(name)) {
    errors.push("Package name must contain only lowercase letters, numbers, and hyphens");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a full JSR package identifier.
 *
 * @param fullName Full package name (e.g., "@std/path")
 * @returns Validation result combining scope and name checks
 */
export function validateJSRFullName(fullName: string): JSRNameValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!fullName.startsWith("@")) {
    errors.push("JSR package names must start with @ (all packages are scoped)");
    return { valid: false, errors, warnings };
  }

  const slashCount = (fullName.match(/\//g) || []).length;
  if (slashCount !== 1) {
    errors.push("JSR package names must be in format @scope/name");
    return { valid: false, errors, warnings };
  }

  const [scope, name] = fullName.slice(1).split("/");

  const scopeResult = validateJSRScope(scope);
  errors.push(...scopeResult.errors.map(e => `Scope: ${e}`));
  warnings.push(...scopeResult.warnings.map(w => `Scope: ${w}`));

  const nameResult = validateJSRPackageName(name);
  errors.push(...nameResult.errors.map(e => `Name: ${e}`));
  warnings.push(...nameResult.warnings.map(w => `Name: ${w}`));

  return { valid: errors.length === 0, errors, warnings };
}

// =============================================================================
// URL Generation
// =============================================================================

/**
 * Get the package metadata URL.
 *
 * @param scope Package scope (with or without @)
 * @param name Package name
 * @returns Metadata URL
 *
 * @example
 * ```ts
 * getJSRPackageMetaUrl("std", "path")
 * // "https://jsr.io/@std/path/meta.json"
 * ```
 */
export function getJSRPackageMetaUrl(scope: string, name: string): string {
  const cleanScope = scope.startsWith("@") ? scope : `@${scope}`;
  return `${JSR_REGISTRY}/${cleanScope}/${name}/meta.json`;
}

/**
 * Get the version metadata URL.
 *
 * @param scope Package scope
 * @param name Package name
 * @param version Version string
 * @returns Version metadata URL
 *
 * @example
 * ```ts
 * getJSRVersionMetaUrl("std", "path", "1.0.0")
 * // "https://jsr.io/@std/path/1.0.0_meta.json"
 * ```
 */
export function getJSRVersionMetaUrl(scope: string, name: string, version: string): string {
  const cleanScope = scope.startsWith("@") ? scope : `@${scope}`;
  return `${JSR_REGISTRY}/${cleanScope}/${name}/${version}_meta.json`;
}

/**
 * Get the direct module URL for ESM import.
 *
 * This URL can be used directly in import statements - no esm.sh needed!
 *
 * @param scope Package scope
 * @param name Package name
 * @param version Version string
 * @param path File path within the package
 * @returns Direct module URL
 *
 * @example
 * ```ts
 * getJSRModuleUrl("std", "path", "1.0.0", "/mod.ts")
 * // "https://jsr.io/@std/path/1.0.0/mod.ts"
 *
 * // Can be used directly in Deno:
 * import { join } from "https://jsr.io/@std/path/1.0.0/mod.ts";
 * ```
 */
export function getJSRModuleUrl(
  scope: string,
  name: string,
  version: string,
  path: string = "/mod.ts"
): string {
  const cleanScope = scope.startsWith("@") ? scope : `@${scope}`;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${JSR_REGISTRY}/${cleanScope}/${name}/${version}${cleanPath}`;
}

/**
 * Get the npm compatibility package URL.
 *
 * @param scope Package scope
 * @param name Package name
 * @returns npm registry URL
 *
 * @example
 * ```ts
 * getJSRNpmUrl("std", "path")
 * // "https://npm.jsr.io/@jsr/std__path"
 * ```
 */
export function getJSRNpmUrl(scope: string, name: string): string {
  const cleanScope = scope.startsWith("@") ? scope.slice(1) : scope;
  return `${JSR_NPM_REGISTRY}/@jsr/${cleanScope}__${name}`;
}

/**
 * Get the tarball URL for npm compatibility.
 */
export function getJSRTarballUrl(scope: string, name: string, version: string): string {
  const cleanScope = scope.startsWith("@") ? scope.slice(1) : scope;
  return `${JSR_NPM_REGISTRY}/@jsr/${cleanScope}__${name}/${version}.tgz`;
}

/**
 * Get URLs from a parsed JSR spec.
 *
 * @param spec Parsed JSR spec
 * @returns Object with various URL formats
 */
export function getJSRUrls(spec: JSRSpec): {
  module: string | null;
  meta: string;
  versionMeta: string | null;
  npm: string;
} {
  const { scope, name, version, subpath } = spec;

  return {
    module: version
      ? getJSRModuleUrl(scope, name, version, subpath || "/mod.ts")
      : null,
    meta: getJSRPackageMetaUrl(scope, name),
    versionMeta: version
      ? getJSRVersionMetaUrl(scope, name, version)
      : null,
    npm: getJSRNpmUrl(scope, name),
  };
}

// =============================================================================
// npm Compatibility
// =============================================================================

/**
 * Convert JSR package name to npm compatibility name.
 *
 * JSR uses `@jsr/scope__name` format for npm compatibility.
 *
 * @example
 * ```ts
 * toNpmCompatName("std", "path")
 * // "@jsr/std__path"
 * ```
 */
export function toNpmCompatName(scope: string, name: string): string {
  const cleanScope = scope.startsWith("@") ? scope.slice(1) : scope;
  return `@jsr/${cleanScope}__${name}`;
}

/**
 * Parse an npm compatibility name back to JSR components.
 *
 * @param npmName npm compatibility name (e.g., "@jsr/std__path")
 * @returns Parsed components or null if invalid
 *
 * @example
 * ```ts
 * fromNpmCompatName("@jsr/std__path")
 * // { scope: "std", name: "path", fullName: "@std/path" }
 *
 * fromNpmCompatName("lodash")
 * // null (not a JSR package)
 * ```
 */
export function fromNpmCompatName(npmName: string): { scope: string; name: string; fullName: string } | null {
  const match = /^@jsr\/([a-z][a-z0-9-]*)__([a-z][a-z0-9-]*)$/.exec(npmName);
  if (!match) return null;

  const [, scope, name] = match;
  return { scope, name, fullName: `@${scope}/${name}` };
}

// =============================================================================
// CDN/Proxy URLs
// =============================================================================

/**
 * Convert a JSR spec to an esm.sh proxy URL.
 *
 * Use this when you need npm-compatible URLs in bundlers or environments
 * that don't support direct jsr.io imports.
 *
 * @example
 * ```ts
 * const spec = parseJSRSpec("jsr:@std/path@1.0.0");
 * jsrToEsmSh(spec)
 * // "https://esm.sh/jsr/@std/path@1.0.0"
 * ```
 */
export function jsrToEsmSh(spec: JSRSpec): string {
  const { scope, name, version, subpath } = spec;
  const versionPart = version ? `@${version}` : "";
  return `https://esm.sh/jsr/@${scope}/${name}${versionPart}${subpath}`;
}

/**
 * Convert a raw JSR specifier to esm.sh URL.
 *
 * @param input Raw jsr: specifier
 * @returns esm.sh URL or null if invalid
 */
export function jsrSpecToEsmSh(input: string): string | null {
  const spec = parseJSRSpec(input);
  return spec ? jsrToEsmSh(spec) : null;
}

// =============================================================================
// Registry API - Fetch Metadata
// =============================================================================

/**
 * Fetch package metadata from the JSR registry.
 *
 * @param scope Package scope (without @)
 * @param name Package name
 * @returns Package metadata
 *
 * @example
 * ```ts
 * const meta = await getJSRPackage("std", "path");
 * console.log(Object.keys(meta.versions));
 * // ["1.0.0", "1.0.1", "1.0.2", ...]
 * ```
 */
export async function getJSRPackage(scope: string, name: string): Promise<JSRPackageMeta> {
  const url = getJSRPackageMetaUrl(scope, name);

  const { response } = await fetchWithCache(url, {
    cacheMode: "reload",
    init: {
      headers: {
        // Important: JSR returns HTML if Accept includes text/html
        "Accept": "application/json",
      },
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`JSR package not found: @${scope}/${name}`);
    }
    throw new Error(`JSR registry error: ${response.status} ${response.statusText}`);
  }

  return await response.json() as JSRPackageMeta;
}

/**
 * Fetch version metadata from the JSR registry.
 *
 * @param scope Package scope
 * @param name Package name
 * @param version Exact version string
 * @returns Version metadata with file manifest and exports
 */
export async function getJSRVersionMeta(
  scope: string,
  name: string,
  version: string
): Promise<JSRVersionMeta> {
  const url = getJSRVersionMetaUrl(scope, name, version);

  const { response } = await fetchWithCache(url, {
    init: { headers: { "Accept": "application/json" }, }
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`JSR version not found: @${scope}/${name}@${version}`);
    }
    throw new Error(`JSR registry error: ${response.status} ${response.statusText}`);
  }

  return await response.json() as JSRVersionMeta;
}

/**
 * Get list of available versions for a package.
 *
 * @param scope Package scope
 * @param name Package name
 * @param includeYanked Whether to include yanked versions
 * @returns Array of version strings
 */
export async function getJSRVersions(
  scope: string,
  name: string,
  includeYanked = false
): Promise<string[]> {
  const meta = await getJSRPackage(scope, name);

return Object.entries(meta.versions)
    .filter(([_, info]) => includeYanked || !info.yanked)
    .map(([version]) => version);
}

// =============================================================================
// Version Resolution
// =============================================================================

/**
 * Resolve a version range to an exact version.
 *
 * Resolution order:
 * 1. If version is an exact match, return it
 * 2. Find the maximum version satisfying the semver range
 *
 * Note: JSR doesn't have dist-tags like npm, so "latest" is resolved
 * as the highest non-yanked version.
 *
 * @param spec Object with scope, name, and version
 * @returns Resolved version or null if no match
 *
 * @example
 * ```ts
 * // Resolve a caret range
 * await resolveJSRVersion({ scope: "std", name: "path", version: "^1.0.0" })
 * // "1.0.8" (highest 1.x.x)
 *
 * // Resolve exact version
 * await resolveJSRVersion({ scope: "std", name: "path", version: "1.0.0" })
 * // "1.0.0"
 *
 * // Resolve "latest" (highest non-yanked)
 * await resolveJSRVersion({ scope: "std", name: "path", version: "latest" })
 * // "1.0.8"
 * ```
 */
export async function resolveJSRVersion(
  spec: { scope: string; name: string; version: string | null }
): Promise<string | null> {
  const { scope, name, version: range } = spec;

  // If no version specified, get latest
  if (!range || range === "latest") {
    const versions = await getJSRVersions(scope, name, false);
    if (versions.length === 0) return null;

    // Find highest version
    const parsed = versions
      .map(v => {
        try {
          return { original: v, semver: parse(v) };
        } catch {
          return null;
        }
      })
      .filter((v): v is { original: string; semver: NonNullable<ReturnType<typeof parse>> } =>
        v !== null && v.semver !== null
      );

    if (parsed.length === 0) return versions[0] ?? null;

    parsed.sort((a, b) => {
      const aStr = format(a.semver);
      const bStr = format(b.semver);
      return bStr.localeCompare(aStr, undefined, { numeric: true });
    });

    return parsed[0]?.original ?? null;
  }

  const versions = await getJSRVersions(scope, name, false);

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

  console.warn(`[jsr] No version matches @${scope}/${name}@${range}`);
  return null;
}

/**
 * Resolve a JSR spec to one with an exact version.
 *
 * @param spec Parsed JSR spec (potentially with range)
 * @returns Spec with resolved version, or original if resolution fails
 */
export async function resolveJSRSpec(spec: JSRSpec): Promise<JSRSpec> {
  if (!spec.version) {
    const resolved = await resolveJSRVersion({
      scope: spec.scope,
      name: spec.name,
      version: "latest",
    });

    return resolved
      ? { ...spec, version: resolved }
      : spec;
  }

  const resolved = await resolveJSRVersion({
    scope: spec.scope,
    name: spec.name,
    version: spec.version,
  });

  return resolved
    ? { ...spec, version: resolved }
    : spec;
}

// =============================================================================
// Search API
// =============================================================================

/**
 * Search for packages on JSR.
 *
 * Note: This uses the management API (api.jsr.io) which is designed for
 * search operations, not registry operations.
 *
 * @param query Search query
 * @param options Search options
 * @returns Search results
 *
 * @example
 * ```ts
 * const results = await searchJSR("http server");
 * for (const pkg of results.items) {
 *   console.log(`@${pkg.scope}/${pkg.name}: ${pkg.description}`);
 * }
 * ```
 */
export async function searchJSR(
  query: string,
  options: { limit?: number; page?: number } = {}
): Promise<JSRSearchResult> {
  const { limit = 20, page = 1 } = options;

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    page: String(page),
  });

  const url = `${JSR_API}/packages?${params}`;

  const { response } = await fetchWithCache(url, {
    cacheMode: "reload",
    init: {
      headers: { "Accept": "application/json" },
    }
  });

  if (!response.ok) {
    throw new Error(`JSR search error: ${response.status} ${response.statusText}`);
  }

  return await response.json() as JSRSearchResult;
}

// =============================================================================
// Import Map Generation
// =============================================================================

/**
 * Generate import map entries for JSR packages.
 *
 * @param specs Array of JSR specs
 * @param options Generation options
 * @returns Import map entries
 *
 * @example Direct URLs
 * ```ts
 * const specs = [
 *   parseJSRSpec("jsr:@std/path@1.0.0"),
 *   parseJSRSpec("jsr:@std/fs@1.0.0"),
 * ];
 *
 * generateImportMapEntries(specs)
 * // {
 * //   "@std/path": "https://jsr.io/@std/path/1.0.0/mod.ts",
 * //   "@std/fs": "https://jsr.io/@std/fs/1.0.0/mod.ts"
 * // }
 * ```
 *
 * @example Using esm.sh proxy
 * ```ts
 * generateImportMapEntries(specs, { useEsmSh: true })
 * // {
 * //   "@std/path": "https://esm.sh/jsr/@std/path@1.0.0",
 * //   "@std/fs": "https://esm.sh/jsr/@std/fs@1.0.0"
 * // }
 * ```
 */
export function generateImportMapEntries(
  specs: JSRSpec[],
  options: { useEsmSh?: boolean; defaultPath?: string } = {}
): Record<string, string> {
  const { useEsmSh = false, defaultPath = "/mod.ts" } = options;
  const entries: Record<string, string> = {};

  for (const spec of specs) {
    const key = spec.fullName;
    if (useEsmSh) {
      entries[key] = jsrToEsmSh(spec);
    } else if (spec.version) {
      entries[key] = getJSRModuleUrl(spec.scope, spec.name, spec.version, defaultPath);
    }
  }

  return entries;
}