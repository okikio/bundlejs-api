/**
 * Import Map Utilities (HTML Spec Compliant)
 *
 * Utilities for working with import maps as defined in the HTML Standard.
 * Supports browser native import maps and Deno/Bun configurations.
 *
 * This implementation follows the WHATWG HTML specification for import maps:
 * https://html.spec.whatwg.org/multipage/webappapis.html#import-maps
 *
 * @module
 *
 * @example Basic usage
 * ```ts
 * import {
 *   createImportMap,
 *   resolveImportMap,
 *   validateImportMap,
 * } from "./import-map.ts";
 *
 * const map = createImportMap({
 *   imports: {
 *     "react": "https://esm.sh/react@18",
 *     "lodash/": "https://esm.sh/lodash-es/"
 *   }
 * });
 *
 * resolveImportMap(map, "react")      // "https://esm.sh/react@18"
 * resolveImportMap(map, "lodash/get") // "https://esm.sh/lodash-es/get"
 * ```
 *
 * @see https://html.spec.whatwg.org/multipage/webappapis.html#import-maps
 * @see https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap
 * @see https://docs.deno.com/runtime/fundamentals/modules/#import-maps
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Import map structure as defined by the HTML spec.
 *
 * @example Basic import map
 * ```json
 * {
 *   "imports": {
 *     "react": "https://esm.sh/react@18",
 *     "lodash/": "https://esm.sh/lodash-es/"
 *   }
 * }
 * ```
 *
 * @example With scopes
 * ```json
 * {
 *   "imports": {
 *     "react": "https://esm.sh/react@18"
 *   },
 *   "scopes": {
 *     "/vendor/": {
 *       "react": "https://esm.sh/react@17"
 *     }
 *   }
 * }
 * ```
 *
 * @example With integrity (browser extension)
 * ```json
 * {
 *   "imports": {
 *     "lodash": "https://esm.sh/lodash-es@4"
 *   },
 *   "integrity": {
 *     "https://esm.sh/lodash-es@4": "sha384-..."
 *   }
 * }
 * ```
 */
export interface ImportMap {
  /** Top-level import mappings (specifier → URL/path) */
  imports?: Record<string, string>;
  /**
   * Scoped import mappings.
   * Keys are URL prefixes, values are mappings that apply when
   * importing from scripts whose URL starts with that prefix.
   */
  scopes?: Record<string, Record<string, string>>;
  /**
   * Integrity metadata (optional browser extension).
   * Maps URLs to subresource integrity hashes.
   */
  integrity?: Record<string, string>;
}

/**
 * Import map generation options.
 */
export interface GenerateImportMapOptions {
  /** Base URL for relative resolutions */
  baseUrl?: string;
  /** CDN to use for npm packages */
  cdn?: "esm.sh" | "unpkg" | "jsdelivr" | "skypack" | "jsr";
  /** Include dev dependencies */
  includeDevDeps?: boolean;
  /** Include peer dependencies */
  includePeerDeps?: boolean;
  /** Custom URL generator */
  urlGenerator?: (name: string, version: string) => string;
}

/**
 * Package.json dependencies subset.
 */
interface PackageDeps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Validation result for import maps.
 */
export interface ImportMapValidation {
  /** Whether the import map is valid (no errors) */
  valid: boolean;
  /** Errors that prevent the import map from working */
  errors: string[];
  /** Warnings about potential issues */
  warnings: string[];
}

// =============================================================================
// Constants
// =============================================================================

/**
 * CDN URL templates for package resolution.
 *
 * @example
 * ```ts
 * CDN_TEMPLATES["esm.sh"]("react", "^18.2.0")
 * // "https://esm.sh/react@^18.2.0"
 *
 * CDN_TEMPLATES["jsr"]("@std/path", "1.0.0")
 * // "https://jsr.io/@std/path/1.0.0/mod.ts"
 * ```
 */
export const CDN_TEMPLATES: Record<string, (name: string, version: string) => string> = {
  "esm.sh": (name, version) => `https://esm.sh/${name}@${version}`,
  unpkg: (name, version) => `https://unpkg.com/${name}@${version}`,
  jsdelivr: (name, version) => `https://cdn.jsdelivr.net/npm/${name}@${version}`,
  skypack: (name, version) => `https://cdn.skypack.dev/${name}@${version}`,
  jsr: (name, version) => {
    // JSR packages are always scoped
    if (name.startsWith("@")) {
      const [scope, pkg] = name.slice(1).split("/");
      return `https://jsr.io/@${scope}/${pkg}/${version}/mod.ts`;
    }
    // Non-scoped name can't be a JSR package
    return `https://esm.sh/${name}@${version}`;
  },
};

// =============================================================================
// Import Map Creation
// =============================================================================

/**
 * Create an import map from configuration.
 *
 * Creates a copy to avoid mutations to the original.
 *
 * @param config Import map configuration
 * @returns Validated import map
 *
 * @example
 * ```ts
 * const map = createImportMap({
 *   imports: {
 *     "react": "https://esm.sh/react@18",
 *     "react-dom": "https://esm.sh/react-dom@18"
 *   },
 *   scopes: {
 *     "/vendor/": {
 *       "react": "https://esm.sh/react@17"
 *     }
 *   }
 * });
 * ```
 */
export function createImportMap(config: ImportMap): ImportMap {
  const map: ImportMap = {};

  if (config.imports) {
    map.imports = { ...config.imports };
  }

  if (config.scopes) {
    map.scopes = {};
    for (const [scope, mappings] of Object.entries(config.scopes)) {
      map.scopes[scope] = { ...mappings };
    }
  }

  if (config.integrity) {
    map.integrity = { ...config.integrity };
  }

  return map;
}

/**
 * Generate an import map from package.json dependencies.
 *
 * @param pkg Package.json contents
 * @param options Generation options
 * @returns Generated import map
 *
 * @example Basic usage
 * ```ts
 * const pkg = {
 *   dependencies: {
 *     "react": "^18.2.0",
 *     "lodash": "^4.17.0"
 *   }
 * };
 *
 * generateImportMap(pkg, { cdn: "esm.sh" });
 * // {
 * //   imports: {
 * //     "react": "https://esm.sh/react@^18.2.0",
 * //     "lodash": "https://esm.sh/lodash@^4.17.0"
 * //   }
 * // }
 * ```
 */
export function generateImportMap(
  pkg: PackageDeps,
  options: GenerateImportMapOptions = {}
): ImportMap {
  const {
    cdn = "esm.sh",
    includeDevDeps = false,
    includePeerDeps = false,
    urlGenerator = CDN_TEMPLATES[cdn],
  } = options;

  const imports: Record<string, string> = {};

  // Add dependencies
  if (pkg.dependencies) {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      imports[name] = urlGenerator(name, cleanVersion(version));
    }
  }

  // Add dev dependencies (don't override regular deps)
  if (includeDevDeps && pkg.devDependencies) {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      if (!(name in imports)) {
        imports[name] = urlGenerator(name, cleanVersion(version));
      }
    }
  }

  // Add peer dependencies (don't override)
  if (includePeerDeps && pkg.peerDependencies) {
    for (const [name, version] of Object.entries(pkg.peerDependencies)) {
      if (!(name in imports)) {
        imports[name] = urlGenerator(name, cleanVersion(version));
      }
    }
  }

  return { imports };
}

/**
 * Clean version string for URL usage.
 */
function cleanVersion(version: string): string {
  // Remove npm: alias prefix
  if (version.startsWith("npm:")) {
    version = version.slice(4);
  }

  // Remove workspace: prefix
  if (version.startsWith("workspace:")) {
    return "latest";
  }

  // Remove jsr: prefix
  if (version.startsWith("jsr:")) {
    version = version.slice(4);
  }

  return version;
}

// =============================================================================
// Import Map Merging
// =============================================================================

/**
 * Merge multiple import maps.
 *
 * Per the HTML spec, later maps take precedence over earlier ones.
 *
 * @param maps Import maps to merge (later takes precedence)
 * @returns Merged import map
 *
 * @example
 * ```ts
 * const base = {
 *   imports: { "react": "https://esm.sh/react@17" }
 * };
 * const override = {
 *   imports: { "react": "https://esm.sh/react@18" }
 * };
 *
 * mergeImportMaps(base, override);
 * // { imports: { "react": "https://esm.sh/react@18" } }
 * ```
 */
export function mergeImportMaps(...maps: ImportMap[]): ImportMap {
  const result: ImportMap = {};

  for (const map of maps) {
    // Merge imports
    if (map.imports) {
      result.imports = { ...result.imports, ...map.imports };
    }

    // Merge scopes (deep merge)
    if (map.scopes) {
      result.scopes = result.scopes || {};
      for (const [scope, mappings] of Object.entries(map.scopes)) {
        result.scopes[scope] = { ...result.scopes[scope], ...mappings };
      }
    }

    // Merge integrity
    if (map.integrity) {
      result.integrity = { ...result.integrity, ...map.integrity };
    }
  }

  return result;
}

/**
 * Add entries to an import map.
 *
 * @param map Base import map
 * @param imports Entries to add
 * @param scope Optional scope for scoped imports
 * @returns New import map with additions
 */
export function addToImportMap(
  map: ImportMap,
  imports: Record<string, string>,
  scope?: string
): ImportMap {
  const result: ImportMap = {
    imports: map.imports ? { ...map.imports } : undefined,
    scopes: map.scopes ? { ...map.scopes } : undefined,
    integrity: map.integrity ? { ...map.integrity } : undefined,
  };

  if (scope) {
    result.scopes = result.scopes || {};
    result.scopes[scope] = { ...result.scopes[scope], ...imports };
  } else {
    result.imports = { ...result.imports, ...imports };
  }

  return result;
}

// =============================================================================
// Import Map Resolution (HTML Spec Compliant)
// =============================================================================

/**
 * Resolve a specifier against mappings.
 *
 * Implements the resolution algorithm from the HTML spec:
 * 1. Check for exact match
 * 2. Check for package prefix match (keys ending with /)
 */
function resolveFromMappings(
  mappings: Record<string, string>,
  specifier: string
): string | null {
  // 1. Exact match
  if (specifier in mappings) {
    return mappings[specifier];
  }

  // 2. Package prefix match - sorted by length (longest first) per spec
  const prefixKeys = Object.keys(mappings)
    .filter((k) => k.endsWith("/"))
    .sort((a, b) => b.length - a.length);

  for (const key of prefixKeys) {
    if (specifier.startsWith(key)) {
      const suffix = specifier.slice(key.length);
      const value = mappings[key];
      // Value should also end with / for proper subpath handling
      return value.endsWith("/") ? value + suffix : value + "/" + suffix;
    }
  }

  return null;
}

/**
 * Resolve a specifier using an import map.
 *
 * Implements the WHATWG HTML import map resolution algorithm:
 * 1. If referrer provided, check scopes (longest match first)
 * 2. Check top-level imports
 * 3. Return null if not mapped
 *
 * @param map Import map
 * @param specifier Module specifier to resolve
 * @param referrer Optional referrer URL for scoped resolution
 * @returns Resolved URL or null if not mapped
 *
 * @example Basic resolution
 * ```ts
 * const map = {
 *   imports: {
 *     "react": "https://esm.sh/react@18",
 *     "lodash/": "https://esm.sh/lodash-es/"
 *   }
 * };
 *
 * resolveImportMap(map, "react");
 * // "https://esm.sh/react@18"
 *
 * resolveImportMap(map, "lodash/get");
 * // "https://esm.sh/lodash-es/get"
 *
 * resolveImportMap(map, "unknown");
 * // null
 * ```
 *
 * @example Scoped resolution
 * ```ts
 * const map = {
 *   imports: { "react": "https://esm.sh/react@18" },
 *   scopes: {
 *     "/vendor/legacy/": { "react": "https://esm.sh/react@16" },
 *     "/vendor/": { "react": "https://esm.sh/react@17" }
 *   }
 * };
 *
 * // From a script at /vendor/legacy/old.js
 * resolveImportMap(map, "react", "/vendor/legacy/old.js");
 * // "https://esm.sh/react@16" (longest scope match)
 * ```
 */
export function resolveImportMap(
  map: ImportMap,
  specifier: string,
  referrer?: string
): string | null {
  // Check scoped mappings first (if referrer provided)
  if (referrer && map.scopes) {
    // Sort scopes by length (longest first) per spec
    const sortedScopes = Object.keys(map.scopes).sort(
      (a, b) => b.length - a.length
    );

    for (const scope of sortedScopes) {
      if (referrer.startsWith(scope)) {
        const resolved = resolveFromMappings(map.scopes[scope], specifier);
        if (resolved !== null) return resolved;
      }
    }
  }

  // Check top-level imports
  if (map.imports) {
    return resolveFromMappings(map.imports, specifier);
  }

  return null;
}

/**
 * Get the integrity hash for a URL if specified.
 *
 * @param map Import map
 * @param url URL to look up
 * @returns Integrity hash or null
 */
export function getIntegrity(map: ImportMap, url: string): string | null {
  return map.integrity?.[url] ?? null;
}

// =============================================================================
// Import Map Validation
// =============================================================================

/**
 * Validate an import map.
 *
 * Checks for common errors and issues per the HTML spec.
 *
 * @param map Import map to validate
 * @returns Validation result
 *
 * @example
 * ```ts
 * validateImportMap({
 *   imports: {
 *     "": "https://example.com",      // Empty key - error
 *     "foo": "not-a-valid-url",       // Invalid URL - error
 *     "bar/": "https://example.com"   // Missing trailing / - warning
 *   }
 * });
 * // {
 * //   valid: false,
 * //   errors: ["Empty key in imports", "Invalid mapping value..."],
 * //   warnings: ["Key \"bar/\" ends with /..."]
 * // }
 * ```
 */
export function validateImportMap(map: ImportMap): ImportMapValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate imports
  if (map.imports) {
    for (const [key, value] of Object.entries(map.imports)) {
      if (!key) {
        errors.push("Empty key in imports");
        continue;
      }

      if (!isValidMappingValue(value)) {
        errors.push(`Invalid mapping value for "${key}": ${value}`);
      }

      if (key.endsWith("/") && !value.endsWith("/")) {
        warnings.push(
          `Key "${key}" ends with / but value doesn't - subpath imports may fail`
        );
      }
    }
  }

  // Validate scopes
  if (map.scopes) {
    for (const [scope, mappings] of Object.entries(map.scopes)) {
      if (!isValidScopeKey(scope)) {
        warnings.push(`Scope "${scope}" should start with / or be a URL`);
      }

      for (const [key, value] of Object.entries(mappings)) {
        if (!key) {
          errors.push(`Empty key in scope "${scope}"`);
          continue;
        }

        if (!isValidMappingValue(value)) {
          errors.push(
            `Invalid mapping value for "${key}" in scope "${scope}": ${value}`
          );
        }

        if (key.endsWith("/") && !value.endsWith("/")) {
          warnings.push(
            `Key "${key}" in scope "${scope}" ends with / but value doesn't`
          );
        }
      }
    }
  }

  // Validate integrity
  if (map.integrity) {
    for (const [url, hash] of Object.entries(map.integrity)) {
      if (!isValidIntegrityHash(hash)) {
        warnings.push(`Invalid integrity hash for "${url}": ${hash}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function isValidMappingValue(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("data:") ||
    value.startsWith("blob:")
  );
}

function isValidScopeKey(scope: string): boolean {
  return (
    scope.startsWith("/") ||
    scope.startsWith("http://") ||
    scope.startsWith("https://") ||
    scope.startsWith("./") ||
    scope.startsWith("../")
  );
}

function isValidIntegrityHash(hash: string): boolean {
  return /^(sha256|sha384|sha512)-[A-Za-z0-9+/]+=*$/.test(hash);
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize an import map to JSON.
 *
 * @param map Import map
 * @param pretty Whether to pretty-print (default: false)
 * @returns JSON string
 */
export function serializeImportMap(map: ImportMap, pretty = false): string {
  const output: ImportMap = {};
  if (map.imports && Object.keys(map.imports).length > 0) {
    output.imports = map.imports;
  }
  if (map.scopes && Object.keys(map.scopes).length > 0) {
    output.scopes = map.scopes;
  }
  if (map.integrity && Object.keys(map.integrity).length > 0) {
    output.integrity = map.integrity;
  }

  return JSON.stringify(output, null, pretty ? 2 : undefined);
}

/**
 * Parse an import map from JSON.
 *
 * @param json JSON string
 * @returns Parsed import map
 * @throws Error if JSON is invalid or doesn't match import map structure
 */
export function parseImportMap(json: string): ImportMap {
  const parsed = JSON.parse(json);

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Import map must be an object");
  }

  if (parsed.imports !== undefined && typeof parsed.imports !== "object") {
    throw new Error("imports must be an object");
  }

  if (parsed.scopes !== undefined && typeof parsed.scopes !== "object") {
    throw new Error("scopes must be an object");
  }

  if (parsed.integrity !== undefined && typeof parsed.integrity !== "object") {
    throw new Error("integrity must be an object");
  }

  return parsed as ImportMap;
}

/**
 * Generate an HTML script tag for an import map.
 *
 * @param map Import map
 * @returns HTML script element string
 */
export function toScriptTag(map: ImportMap): string {
  const json = serializeImportMap(map, true);
  return `<script type="importmap">\n${json}\n</script>`;
}

// =============================================================================
// Deno/Bun Integration
// =============================================================================

/**
 * Convert an import map to Deno's deno.json format.
 *
 * @param map Import map
 * @returns deno.json compatible object
 */
export function toDenoConfig(map: ImportMap): {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
} {
  return {
    imports: map.imports,
    scopes: map.scopes,
  };
}

/**
 * Create an import map from Deno's deno.json format.
 *
 * @param config deno.json contents
 * @returns Import map
 */
export function fromDenoConfig(config: {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
}): ImportMap {
  return {
    imports: config.imports,
    scopes: config.scopes,
  };
}