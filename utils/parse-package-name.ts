/**
 * Enhanced npm package name parser.
 *
 * Parses package specifiers in various formats:
 * - Simple: react, lodash
 * - Versioned: react@18.2.0, lodash@^4.17.0
 * - Scoped: @types/node, @tanstack/react-query@5.0.0
 * - With subpath: lodash/get, @emotion/react@11/jsx-runtime
 *
 * Enhancements over basic parser:
 * - Integrates package name validation
 * - Provides URL-escaped name for registry calls
 * - Extracts scope separately
 * - Includes structured validation result
 *
 * @module
 *
 * @example Basic usage
 * ```ts
 * import { parsePackageName, parsePackageSpec } from "./parse-package-name.ts";
 *
 * const result = parsePackageName("@tanstack/react-query@5.0.0/build");
 * // {
 * //   name: "@tanstack/react-query",
 * //   version: "5.0.0",
 * //   path: "/build",
 * //   scope: "@tanstack",
 * //   escapedName: "@tanstack%2freact-query",
 * //   isScoped: true
 * // }
 * ```
 */

import { validatePackageName, type ValidateResult } from "./validate-package-name.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for parsing package names.
 */
export interface ParsePackageOptions {
  /**
   * If true, return partial result instead of throwing on parse errors.
   * @default false
   */
  ignoreError?: boolean;

  /**
   * Default version when none is specified.
   * Set to null to indicate no version.
   * @default "latest"
   */
  defaultVersion?: string | null;

  /**
   * Whether to validate the package name.
   * @default false
   */
  validate?: boolean;
}

/**
 * Result of parsing a package specifier.
 */
export interface ParsedPackage {
  /** Full package name (e.g., "@types/node") */
  name: string;
  /** Version or version range (e.g., "^18.0.0") */
  version: string | null;
  /** Subpath within package (e.g., "/get") */
  path: string;
  /** Package scope if scoped (e.g., "@types") */
  scope: string | null;
  /** URL-escaped name for registry API calls */
  escapedName: string;
  /** Whether this is a scoped package */
  isScoped: boolean;
  /** Validation result if validate=true was passed */
  validation?: ValidateResult;
}

/**
 * Extended result including the original input.
 */
export interface ParsedPackageSpec extends ParsedPackage {
  /** Original input string */
  raw: string;
  /** Whether the input contained an explicit version */
  hasExplicitVersion: boolean;
}

// =============================================================================
// Regex Patterns
// =============================================================================

/**
 * Pattern for scoped packages: @scope/name@version/path
 *
 * Groups:
 * 1. Full scoped name (@scope/name)
 * 2. Version (optional)
 * 3. Path (optional)
 */
export const RE_SCOPED = /^(@[^/]+\/[^@/]+)(?:@([^/]+))?(\/.*)?$/;

/**
 * Pattern for non-scoped packages: name@version/path
 *
 * Groups:
 * 1. Package name
 * 2. Version (optional)
 * 3. Path (optional)
 */
export const RE_NON_SCOPED = /^([^@/]+)(?:@([^/]+))?(\/.*)?$/;

// =============================================================================
// Core Parsing
// =============================================================================

/**
 * Parse a package name string into components.
 *
 * @param input Package specifier string
 * @param options Parsing options
 * @returns Parsed components
 * @throws Error if parse fails and ignoreError is false
 *
 * @example Scoped package
 * ```ts
 * parsePackageName("@tanstack/react-query@5.0.0/build")
 * // {
 * //   name: "@tanstack/react-query",
 * //   version: "5.0.0",
 * //   path: "/build",
 * //   scope: "@tanstack",
 * //   escapedName: "@tanstack%2freact-query",
 * //   isScoped: true
 * // }
 * ```
 *
 * @example Non-scoped package
 * ```ts
 * parsePackageName("lodash@^4.17.0/get")
 * // {
 * //   name: "lodash",
 * //   version: "^4.17.0",
 * //   path: "/get",
 * //   scope: null,
 * //   escapedName: "lodash",
 * //   isScoped: false
 * // }
 * ```
 */
export function parsePackageName(
  input: string,
  options: ParsePackageOptions = {}
): ParsedPackage {
  const {
    ignoreError = false,
    defaultVersion = "latest",
    validate = false,
  } = options;

  // Try scoped pattern first, then non-scoped
  const match = RE_SCOPED.exec(input) || RE_NON_SCOPED.exec(input);

  if (!match) {
    if (!ignoreError) {
      throw new Error(`[parse-package-name] invalid package name: ${input}`);
    }
    return {
      name: "",
      version: defaultVersion,
      path: "",
      scope: null,
      escapedName: "",
      isScoped: false,
      ...(validate ? { validation: { valid: false, errors: ["Invalid format"], warnings: [] } } : {}),
    };
  }

  const name = match[1] || "";
  const version = match[2] ?? defaultVersion;
  const path = match[3] || "";

  // Extract scope from scoped packages
  const isScoped = name.startsWith("@");
  const scope = isScoped ? name.slice(0, name.indexOf("/")) : null;

  // Escape name for registry URLs (/ -> %2f)
  const escapedName = name.replace("/", "%2f");

  // Optionally validate
  const validation = validate ? validatePackageName(name) : undefined;

  return {
    name,
    version,
    path,
    scope,
    escapedName,
    isScoped,
    ...(validation ? { validation } : {}),
  };
}

/**
 * Parse a package specifier with additional metadata.
 *
 * @param input Package specifier string
 * @param options Parsing options
 * @returns Extended parsed result
 */
export function parsePackageSpec(
  input: string,
  options: ParsePackageOptions = {}
): ParsedPackageSpec {
  const parsed = parsePackageName(input, options);

  return {
    ...parsed,
    raw: input,
    hasExplicitVersion: Boolean(
      RE_SCOPED.exec(input)?.[2] || RE_NON_SCOPED.exec(input)?.[2]
    ),
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a string looks like a package name (not a path, URL, etc).
 *
 * @param input String to check
 * @returns True if it looks like a package name
 *
 * @example
 * ```ts
 * isPackageName("react")           // true
 * isPackageName("@types/node")     // true
 * isPackageName("./local")         // false
 * isPackageName("https://...")     // false
 * ```
 */
export function isPackageName(input: string): boolean {
  if (!input || typeof input !== "string") return false;

  // Not a path
  if (input.startsWith(".") || input.startsWith("/") || input.startsWith("~")) {
    return false;
  }

  // Not a URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    return false;
  }

  // Try to parse
  const match = RE_SCOPED.exec(input) || RE_NON_SCOPED.exec(input);
  return match !== null;
}

/**
 * Build a package specifier string from components.
 *
 * @param name Package name
 * @param version Optional version
 * @param path Optional subpath
 * @returns Package specifier string
 *
 * @example
 * ```ts
 * buildPackageSpec("react", "18.2.0")
 * // "react@18.2.0"
 *
 * buildPackageSpec("@types/node", "^20", "/fs")
 * // "@types/node@^20/fs"
 * ```
 */
export function buildPackageSpec(
  name: string,
  version?: string | null,
  path?: string
): string {
  let result = name;

  if (version) {
    result += `@${version}`;
  }

  if (path) {
    // Ensure path starts with /
    result += path.startsWith("/") ? path : `/${path}`;
  }

  return result;
}

/**
 * Normalize a subpath (ensure leading slash, remove trailing slash).
 *
 * @param path Subpath to normalize
 * @returns Normalized path
 */
export function normalizeSubpath(path: string): string {
  if (!path) return "";

  let normalized = path;

  // Ensure leading slash
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }

  // Remove trailing slash (unless it's just "/")
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Join multiple subpaths.
 *
 * @param paths Paths to join
 * @returns Joined path
 */
export function joinSubpaths(...paths: (string | undefined | null)[]): string {
  const parts = paths
    .filter((p): p is string => Boolean(p))
    .flatMap((p) => p.split("/").filter(Boolean));

  if (parts.length === 0) return "";
  return "/" + parts.join("/");
}

// =============================================================================
// Scope Utilities
// =============================================================================

/**
 * Extract scope from a package name.
 *
 * @param name Package name
 * @returns Scope with @ prefix, or null
 */
export function getScope(name: string): string | null {
  if (!name.startsWith("@")) return null;
  const slashIdx = name.indexOf("/");
  return slashIdx > 0 ? name.slice(0, slashIdx) : null;
}

/**
 * Get the unscoped name from a package name.
 *
 * @param name Package name
 * @returns Name without scope
 *
 * @example
 * getUnscopedName("@types/node")  // "node"
 * getUnscopedName("react")        // "react"
 */
export function getUnscopedName(name: string): string {
  if (!name.startsWith("@")) return name;
  const slashIdx = name.indexOf("/");
  return slashIdx > 0 ? name.slice(slashIdx + 1) : name;
}

// =============================================================================
// Default Export (for backwards compatibility)
// =============================================================================

export default parsePackageName;