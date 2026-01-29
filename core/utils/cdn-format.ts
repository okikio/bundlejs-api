/**
 * CDN Format Utilities
 *
 * Utilities for working with various JavaScript CDNs and registries.
 * Supports npm CDNs (unpkg, esm.sh, jsdelivr, skypack), JSR, GitHub, and Deno.
 *
 * This module provides the URL handling logic for bundlejs, enabling
 * cross-platform package resolution from multiple sources.
 *
 * @module
 *
 * @example CDN Style Detection
 * ```ts
 * import { getCDNStyle, getCDNOrigin, getCDNUrl } from "./cdn-format.ts";
 *
 * getCDNStyle("esm:react")
 * // "npm"
 *
 * getCDNStyle("jsr:@std/path")
 * // "jsr"
 *
 * getCDNStyle("https://jsr.io/@std/path/1.0.0/mod.ts")
 * // "jsr"
 *
 * getCDNStyle("github:user/repo")
 * // "github"
 * ```
 *
 * @example URL Generation
 * ```ts
 * getCDNUrl("jsr:@std/path@1.0.0")
 * // {
 * //   import: "jsr:@std/path@1.0.0",
 * //   path: "@std/path@1.0.0",
 * //   origin: "https://jsr.io/",
 * //   cdn: "https://jsr.io/",
 * //   url: URL { href: "https://jsr.io/@std/path@1.0.0" }
 * // }
 *
 * getCDNUrl("esm:react@18")
 * // {
 * //   import: "esm:react@18",
 * //   path: "react@18",
 * //   origin: "https://esm.sh/",
 * //   cdn: "https://esm.sh/",
 * //   url: URL { href: "https://esm.sh/react@18" }
 * // }
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * CDN style categories.
 *
 * Different CDNs have different URL patterns and capabilities:
 * - `npm`: Supports semver versions in URLs (unpkg, esm.sh, jsdelivr, skypack)
 * - `jsr`: JSR registry - TypeScript-first, direct module access
 * - `github`: Raw GitHub file access (jsdelivr.gh, raw.githubusercontent.com)
 * - `deno`: Deno's deno.land/x registry
 * - `tarball`: Tarball providers (pkg.pr.new for PR previews)
 * - `other`: Unknown CDN patterns
 */
export type CDNStyle = "npm" | "jsr" | "github" | "deno" | "tarball" | "other";

/**
 * URL scheme prefixes that indicate a specific CDN.
 */
export type CDNScheme =
  | "skypack"
  | "esm"
  | "esm.sh"
  | "unpkg"
  | "jsdelivr"
  | "esm.run"
  | "jsdelivr.gh"
  | "github"
  | "deno"
  | "jsr";

/**
 * Result from getCDNUrl.
 */
export interface CDNUrlResult {
  /** Original import string */
  import: string;
  /** Pure import path (without scheme/host) */
  path: string;
  /** CDN origin URL (with trailing /) */
  origin: string;
  /** Default CDN that was used */
  cdn: string;
  /** Full resolved URL */
  url: URL;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default CDN host for npm packages.
 */
export const DEFAULT_CDN_HOST = "https://unpkg.com";

/**
 * JSR registry base URL.
 */
export const JSR_REGISTRY = "https://jsr.io";

/**
 * Map of CDN schemes to their origin URLs.
 *
 * @example
 * ```ts
 * CDN_SCHEME_TO_ORIGIN["esm"]
 * // "https://esm.sh"
 *
 * CDN_SCHEME_TO_ORIGIN["jsr"]
 * // "https://jsr.io"
 * ```
 */
export const CDN_SCHEME_TO_ORIGIN: Record<CDNScheme, string> = {
  skypack: "https://cdn.skypack.dev",
  esm: "https://esm.sh",
  "esm.sh": "https://esm.sh",
  unpkg: "https://unpkg.com",
  jsdelivr: "https://cdn.jsdelivr.net/npm",
  "esm.run": "https://cdn.jsdelivr.net/npm",
  "jsdelivr.gh": "https://cdn.jsdelivr.net/gh",
  github: "https://raw.githubusercontent.com",
  deno: "https://deno.land/x",
  jsr: "https://jsr.io",
};

// =============================================================================
// CDN Style Detection
// =============================================================================

/**
 * Detect the CDN style from a URL or scheme.
 *
 * Returns the category of CDN, which determines how URLs should be handled:
 * - `npm`: Package + version in URL, npm registry compatible
 * - `jsr`: JSR registry, TypeScript-first
 * - `github`: Raw GitHub file access
 * - `deno`: Deno's deno.land/x
 * - `tarball`: Tarball providers like pkg.pr.new
 * - `other`: Unknown
 *
 * @param urlStr URL string or scheme prefix
 * @returns CDN style category
 *
 * @example Scheme detection
 * ```ts
 * getCDNStyle("esm:react")           // "npm"
 * getCDNStyle("esm.sh:react")        // "npm"
 * getCDNStyle("unpkg:lodash")        // "npm"
 * getCDNStyle("skypack:react")       // "npm"
 * getCDNStyle("jsdelivr:axios")      // "npm"
 * getCDNStyle("esm.run:vue")         // "npm"
 * ```
 *
 * @example JSR detection
 * ```ts
 * getCDNStyle("jsr:@std/path")                         // "jsr"
 * getCDNStyle("https://jsr.io/@std/path/1.0.0/mod.ts") // "jsr"
 * ```
 *
 * @example GitHub detection
 * ```ts
 * getCDNStyle("github:user/repo/file.js")                     // "github"
 * getCDNStyle("jsdelivr.gh:user/repo/file.js")                // "github"
 * getCDNStyle("https://raw.githubusercontent.com/user/repo")  // "github"
 * getCDNStyle("https://cdn.jsdelivr.net/gh/user/repo")        // "github"
 * ```
 *
 * @example Deno detection
 * ```ts
 * getCDNStyle("deno:oak")                        // "deno"
 * getCDNStyle("https://deno.land/x/oak/mod.ts")  // "deno"
 * ```
 *
 * @example Tarball detection
 * ```ts
 * getCDNStyle("https://pkg.pr.new/user/repo@commit")  // "tarball"
 * ```
 */
export function getCDNStyle(urlStr: string): CDNStyle {
  // JSR - check first as it's a distinct ecosystem
  if (
    /^jsr\:/.test(urlStr) ||
    /^https?:\/\/(jsr\.io)/.test(urlStr)
  ) {
    return "jsr";
  }

  // npm-style CDNs (unpkg, esm.sh, jsdelivr/npm, skypack)
  if (
    /^(skypack|esm|esm\.sh|unpkg|jsdelivr|esm\.run)\:?/.test(urlStr) ||
    /^https?:\/\/(cdn\.skypack\.dev|cdn\.esm\.sh|esm\.sh|cdn\.jsdelivr\.net\/npm|unpkg\.com)/.test(urlStr)
  ) {
    return "npm";
  }

  // GitHub-style (raw files)
  if (
    /^(jsdelivr\.gh|github)\:?/.test(urlStr) ||
    /^https?:\/\/(cdn\.jsdelivr\.net\/gh|raw\.githubusercontent\.com)/.test(urlStr)
  ) {
    return "github";
  }

  // Deno-style
  if (
    /^deno\:/.test(urlStr) ||
    /^https?:\/\/deno\.land\/x/.test(urlStr)
  ) {
    return "deno";
  }

  // Tarball providers (PR previews, etc.)
  if (/^https?:\/\/pkg\.pr\.new/.test(urlStr)) {
    return "tarball";
  }

  return "other";
}

/**
 * Check if a URL or scheme uses a specific CDN style.
 *
 * @param urlStr URL string or scheme prefix
 * @param style CDN style to check
 * @returns True if the URL matches the style
 *
 * @example
 * ```ts
 * isCDNStyle("esm:react", "npm")    // true
 * isCDNStyle("jsr:@std/path", "jsr") // true
 * isCDNStyle("jsr:@std/path", "npm") // false
 * ```
 */
export function isCDNStyle(urlStr: string, style: CDNStyle): boolean {
  return getCDNStyle(urlStr) === style;
}

// =============================================================================
// CDN Origin Resolution
// =============================================================================

/**
 * Get the CDN origin URL for an import string.
 *
 * Handles scheme prefixes (esm:, jsr:, etc.) and falls back to the
 * provided default CDN.
 *
 * @param importStr Import string (may include scheme prefix)
 * @param cdn Default CDN host to use if no scheme present
 * @returns CDN origin URL (always ends with /)
 *
 * @example Scheme prefixes
 * ```ts
 * getCDNOrigin("skypack:react")
 * // "https://cdn.skypack.dev/"
 *
 * getCDNOrigin("esm:react")
 * // "https://esm.sh/"
 *
 * getCDNOrigin("esm.sh:react")
 * // "https://esm.sh/"
 *
 * getCDNOrigin("unpkg:lodash")
 * // "https://unpkg.com/"
 *
 * getCDNOrigin("jsdelivr:axios")
 * // "https://cdn.jsdelivr.net/npm/"
 *
 * getCDNOrigin("esm.run:vue")
 * // "https://cdn.jsdelivr.net/npm/"
 * ```
 *
 * @example JSR
 * ```ts
 * getCDNOrigin("jsr:@std/path")
 * // "https://jsr.io/"
 * ```
 *
 * @example GitHub
 * ```ts
 * getCDNOrigin("jsdelivr.gh:user/repo")
 * // "https://cdn.jsdelivr.net/gh/"
 *
 * getCDNOrigin("github:user/repo")
 * // "https://raw.githubusercontent.com/"
 * ```
 *
 * @example Deno
 * ```ts
 * getCDNOrigin("deno:oak")
 * // "https://deno.land/x/"
 * ```
 *
 * @example Default fallback
 * ```ts
 * getCDNOrigin("react")
 * // "https://unpkg.com/" (default)
 *
 * getCDNOrigin("react", "https://cdn.esm.sh")
 * // "https://cdn.esm.sh/"
 * ```
 */
export function getCDNOrigin(importStr: string, cdn = DEFAULT_CDN_HOST): string {
  // Check for scheme prefixes
  if (/^skypack\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN.skypack;
  } else if (/^jsr\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN.jsr;
  } else if (/^(esm\.sh|esm)\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN.esm;
  } else if (/^unpkg\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN.unpkg;
  } else if (/^(jsdelivr|esm\.run)\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN.jsdelivr;
  } else if (/^jsdelivr\.gh\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN["jsdelivr.gh"];
  } else if (/^deno\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN.deno;
  } else if (/^github\:/.test(importStr)) {
    cdn = CDN_SCHEME_TO_ORIGIN.github;
  }

  // Ensure trailing slash
  return cdn.endsWith("/") ? cdn : `${cdn}/`;
}

// =============================================================================
// Path Extraction
// =============================================================================

/**
 * Remove CDN scheme prefixes and known CDN hosts from an import string.
 *
 * Returns just the package/file path portion.
 *
 * @param importStr Import string
 * @returns Pure import path
 *
 * @example Scheme removal
 * ```ts
 * getPureImportPath("esm:react@18")
 * // "react@18"
 *
 * getPureImportPath("jsr:@std/path@1.0.0")
 * // "@std/path@1.0.0"
 *
 * getPureImportPath("unpkg:lodash@4.17.0/get")
 * // "lodash@4.17.0/get"
 * ```
 *
 * @example URL host removal
 * ```ts
 * getPureImportPath("https://esm.sh/react@18")
 * // "react@18"
 *
 * getPureImportPath("https://jsr.io/@std/path/1.0.0/mod.ts")
 * // "@std/path/1.0.0/mod.ts"
 *
 * getPureImportPath("https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js")
 * // "lodash@4/lodash.min.js"
 * ```
 */
export function getPureImportPath(importStr: string): string {
  return importStr
    // Remove scheme prefixes
    .replace(/^(skypack|esm|esm\.sh|unpkg|jsdelivr|jsdelivr\.gh|esm\.run|deno|github|jsr)\:/, "")
    // Remove known CDN hosts
    .replace(
      /^(https?:\/\/)?(cdn\.skypack\.dev|(cdn\.)?esm\.sh|cdn\.jsdelivr\.net\/npm|unpkg\.com|cdn\.jsdelivr\.net\/gh|raw\.githubusercontent\.com|deno\.land\/x|jsr\.io)/,
      ""
    )
    // Remove leading slash
    .replace(/^\//, "");
}

// =============================================================================
// URL Generation
// =============================================================================

/**
 * Generate a full CDN URL for an import.
 *
 * Combines origin resolution and path extraction to produce
 * a complete URL object.
 *
 * @param importStr Import string (with optional scheme prefix)
 * @param cdn Default CDN host
 * @returns CDN URL result with all components
 *
 * @example npm packages
 * ```ts
 * getCDNUrl("react@18")
 * // {
 * //   import: "react@18",
 * //   path: "react@18",
 * //   origin: "https://unpkg.com/",
 * //   cdn: "https://unpkg.com",
 * //   url: URL { href: "https://unpkg.com/react@18" }
 * // }
 *
 * getCDNUrl("esm:react@18")
 * // {
 * //   import: "esm:react@18",
 * //   path: "react@18",
 * //   origin: "https://esm.sh/",
 * //   cdn: "https://unpkg.com",  // default unchanged
 * //   url: URL { href: "https://esm.sh/react@18" }
 * // }
 * ```
 *
 * @example JSR packages
 * ```ts
 * getCDNUrl("jsr:@std/path@1.0.0")
 * // {
 * //   import: "jsr:@std/path@1.0.0",
 * //   path: "@std/path@1.0.0",
 * //   origin: "https://jsr.io/",
 * //   cdn: "https://unpkg.com",
 * //   url: URL { href: "https://jsr.io/@std/path@1.0.0" }
 * // }
 * ```
 *
 * @example GitHub files
 * ```ts
 * getCDNUrl("github:user/repo/main/file.js")
 * // {
 * //   import: "github:user/repo/main/file.js",
 * //   path: "user/repo/main/file.js",
 * //   origin: "https://raw.githubusercontent.com/",
 * //   cdn: "https://unpkg.com",
 * //   url: URL { href: "https://raw.githubusercontent.com/user/repo/main/file.js" }
 * // }
 * ```
 */
export function getCDNUrl(importStr: string, cdn = DEFAULT_CDN_HOST): CDNUrlResult {
  const origin = getCDNOrigin(importStr, cdn);
  const path = getPureImportPath(importStr);
  const url = new URL(path, origin);

  return {
    import: importStr,
    path,
    origin,
    cdn,
    url,
  };
}

// =============================================================================
// JSR-Specific Utilities
// =============================================================================

/**
 * Parse a JSR specifier into its components.
 *
 * JSR specifiers have the format: jsr:@scope/name@version/subpath
 *
 * @param specifier JSR specifier string
 * @returns Parsed components or null if invalid
 *
 * @example
 * ```ts
 * parseJSRSpecifier("jsr:@std/path@1.0.0")
 * // { scope: "std", name: "path", version: "1.0.0", subpath: "" }
 *
 * parseJSRSpecifier("jsr:@std/path@1.0.0/posix")
 * // { scope: "std", name: "path", version: "1.0.0", subpath: "/posix" }
 *
 * parseJSRSpecifier("jsr:@std/path")
 * // { scope: "std", name: "path", version: null, subpath: "" }
 *
 * parseJSRSpecifier("npm:lodash")
 * // null (not a JSR specifier)
 * ```
 */
export function parseJSRSpecifier(specifier: string): {
  scope: string;
  name: string;
  version: string | null;
  subpath: string;
} | null {
  const match = /^jsr:@([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)(?:@([^\/]+))?(\/.*)?$/.exec(specifier);
  if (!match) return null;

  const [, scope, name, version, subpath] = match;
  return {
    scope,
    name,
    version: version ?? null,
    subpath: subpath ?? "",
  };
}

/**
 * Generate a direct JSR module URL.
 *
 * Creates a URL that can be used directly in import statements
 * without needing a CDN proxy like esm.sh.
 *
 * @param scope Package scope (without @)
 * @param name Package name
 * @param version Version string
 * @param path File path (default: /mod.ts)
 * @returns Direct JSR URL
 *
 * @example
 * ```ts
 * getJSRDirectUrl("std", "path", "1.0.0")
 * // "https://jsr.io/@std/path/1.0.0/mod.ts"
 *
 * getJSRDirectUrl("std", "path", "1.0.0", "/posix.ts")
 * // "https://jsr.io/@std/path/1.0.0/posix.ts"
 *
 * // Can be used directly in Deno:
 * // import { join } from "https://jsr.io/@std/path/1.0.0/mod.ts";
 * ```
 */
export function getJSRDirectUrl(
  scope: string,
  name: string,
  version: string,
  path = "/mod.ts"
): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${JSR_REGISTRY}/@${scope}/${name}/${version}${cleanPath}`;
}

/**
 * Generate a JSR URL via esm.sh proxy.
 *
 * Useful for environments that can't use jsr.io directly.
 *
 * @param scope Package scope (without @)
 * @param name Package name
 * @param version Version string (optional)
 * @param subpath Subpath (optional)
 * @returns esm.sh proxy URL
 *
 * @example
 * ```ts
 * getJSRProxyUrl("std", "path", "1.0.0")
 * // "https://esm.sh/jsr/@std/path@1.0.0"
 *
 * getJSRProxyUrl("std", "path", "1.0.0", "/posix")
 * // "https://esm.sh/jsr/@std/path@1.0.0/posix"
 *
 * getJSRProxyUrl("std", "path")
 * // "https://esm.sh/jsr/@std/path"
 * ```
 */
export function getJSRProxyUrl(
  scope: string,
  name: string,
  version?: string,
  subpath = ""
): string {
  const versionPart = version ? `@${version}` : "";
  return `https://esm.sh/jsr/@${scope}/${name}${versionPart}${subpath}`;
}

// =============================================================================
// Utility Checks
// =============================================================================

/**
 * Check if a string is a JSR specifier.
 *
 * @param str String to check
 * @returns True if it's a jsr: specifier
 *
 * @example
 * ```ts
 * isJSRSpecifier("jsr:@std/path")   // true
 * isJSRSpecifier("npm:lodash")      // false
 * isJSRSpecifier("@std/path")       // false
 * ```
 */
export function isJSRSpecifier(str: string): boolean {
  return str.startsWith("jsr:");
}

/**
 * Check if a string is an npm CDN URL or scheme.
 *
 * @param str String to check
 * @returns True if it's an npm CDN URL/scheme
 *
 * @example
 * ```ts
 * isNpmCDN("esm:react")                        // true
 * isNpmCDN("https://unpkg.com/react")          // true
 * isNpmCDN("https://esm.sh/lodash")            // true
 * isNpmCDN("jsr:@std/path")                    // false
 * isNpmCDN("https://raw.githubusercontent.com") // false
 * ```
 */
export function isNpmCDN(str: string): boolean {
  return getCDNStyle(str) === "npm";
}

/**
 * Check if a string is a GitHub raw URL or scheme.
 *
 * @param str String to check
 * @returns True if it's a GitHub URL/scheme
 *
 * @example
 * ```ts
 * isGitHubRaw("github:user/repo")                   // true
 * isGitHubRaw("https://raw.githubusercontent.com")  // true
 * isGitHubRaw("https://github.com/user/repo")       // false (not raw)
 * ```
 */
export function isGitHubRaw(str: string): boolean {
  return getCDNStyle(str) === "github";
}