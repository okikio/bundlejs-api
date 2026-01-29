/**
 * Package name validation following npm's validate-npm-package-name rules.
 *
 * npm package names must:
 * - Be 214 characters or less (including scope)
 * - Not start with . or _
 * - Not have uppercase letters
 * - Not contain URL-unsafe characters
 * - Not be a Node.js core module name
 *
 * @module
 *
 * @example
 * ```ts
 * import { validatePackageName, isValidPackageName } from "./validate-package-name.ts";
 *
 * const result = validatePackageName("my-package");
 * // { valid: true, errors: [], warnings: [] }
 *
 * const invalid = validatePackageName("My-Package");
 * // { valid: false, errors: ["name must be lowercase"], warnings: [] }
 *
 * if (isValidPackageName("lodash")) {
 *   // Safe to use
 * }
 * ```
 *
 * @see https://github.com/npm/validate-npm-package-name
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Result of package name validation.
 */
export interface ValidateResult {
  /** Whether the name is valid for npm */
  valid: boolean;
  /** Errors that make the name invalid */
  errors: string[];
  /** Warnings that don't invalidate but are discouraged */
  warnings: string[];
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Node.js built-in module names.
 * These cannot be used as package names.
 */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/**
 * "Blacklisted" names that npm reserves.
 */
const BLACKLIST = new Set([
  "node_modules",
  "favicon.ico",
]);

/**
 * Characters that must not appear in package names.
 * These make URLs problematic.
 */
const SPECIAL_CHARS = /[~'!()*]/;

/**
 * URL-unsafe characters that would need encoding.
 * We check this separately from SPECIAL_CHARS for more specific errors.
 */
const URL_UNSAFE = /[^a-z0-9\-._@/]/;

// =============================================================================
// Main Validation
// =============================================================================

/**
 * Validate an npm package name.
 *
 * @param name Package name to validate
 * @returns Validation result with errors and warnings
 *
 * @example Valid names
 * ```ts
 * validatePackageName("lodash")
 * // { valid: true, errors: [], warnings: [] }
 *
 * validatePackageName("@scope/package")
 * // { valid: true, errors: [], warnings: [] }
 *
 * validatePackageName("my-package-123")
 * // { valid: true, errors: [], warnings: [] }
 * ```
 *
 * @example Invalid names
 * ```ts
 * validatePackageName("My-Package")
 * // { valid: false, errors: ["name must be lowercase"], ... }
 *
 * validatePackageName(".hidden")
 * // { valid: false, errors: ["name cannot start with a period"], ... }
 *
 * validatePackageName("http")
 * // { valid: false, errors: ["http is a core Node.js module"], ... }
 * ```
 */
export function validatePackageName(name: string): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Null/undefined check
  if (name == null) {
    errors.push("name cannot be null or undefined");
    return { valid: false, errors, warnings };
  }

  // Must be a string
  if (typeof name !== "string") {
    errors.push("name must be a string");
    return { valid: false, errors, warnings };
  }

  // Cannot be empty
  if (name.length === 0) {
    errors.push("name cannot be empty");
    return { valid: false, errors, warnings };
  }

  // Length limit (214 characters including scope)
  if (name.length > 214) {
    errors.push("name cannot be longer than 214 characters");
  }

  // Cannot start with . or _
  if (name.startsWith(".")) {
    errors.push("name cannot start with a period");
  }
  if (name.startsWith("_")) {
    errors.push("name cannot start with an underscore");
  }

  // Cannot have leading or trailing spaces
  if (name !== name.trim()) {
    errors.push("name cannot have leading or trailing spaces");
  }

  // Must be lowercase
  if (name !== name.toLowerCase()) {
    errors.push("name must be lowercase");
  }

  // Cannot contain special characters
  if (SPECIAL_CHARS.test(name)) {
    errors.push("name cannot contain special characters: ~ ' ! ( ) *");
  }

  // Check for URL-unsafe characters (scoped packages handled separately)
  const nameWithoutScope = name.startsWith("@")
    ? name.slice(name.indexOf("/") + 1)
    : name;

  if (URL_UNSAFE.test(nameWithoutScope)) {
    // More specific error for common issues
    if (/\s/.test(nameWithoutScope)) {
      errors.push("name cannot contain spaces");
    } else {
      errors.push("name contains URL-unsafe characters");
    }
  }

  // Scoped package validation
  if (name.startsWith("@")) {
    const slashIndex = name.indexOf("/");
    if (slashIndex === -1) {
      errors.push("scoped package name must include a slash");
    } else {
      const scope = name.slice(1, slashIndex);
      const pkg = name.slice(slashIndex + 1);

      if (scope.length === 0) {
        errors.push("scope cannot be empty");
      }
      if (pkg.length === 0) {
        errors.push("package name cannot be empty after scope");
      }

      // Validate scope characters
      if (URL_UNSAFE.test(scope)) {
        errors.push("scope contains URL-unsafe characters");
      }
    }
  }

  // Cannot be a Node.js core module
  const baseName = name.startsWith("@")
    ? name.slice(name.indexOf("/") + 1)
    : name;

  if (NODE_BUILTINS.has(baseName)) {
    errors.push(`"${baseName}" is a Node.js core module name`);
  }

  // Cannot be blacklisted
  if (BLACKLIST.has(baseName)) {
    errors.push(`"${baseName}" is a reserved name`);
  }

  // Warnings (not errors but discouraged)
  if (/^node-/.test(baseName) || /^nodejs-/.test(baseName)) {
    warnings.push("name starting with 'node-' or 'nodejs-' is discouraged");
  }
  if (/-js$/.test(baseName) || /\.js$/.test(baseName)) {
    warnings.push("name ending with '-js' or '.js' is discouraged");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Quick check if a package name is valid.
 *
 * @param name Package name to check
 * @returns True if valid
 *
 * @example
 * ```ts
 * if (isValidPackageName(userInput)) {
 *   // Safe to use
 * }
 * ```
 */
export function isValidPackageName(name: string): boolean {
  return validatePackageName(name).valid;
}

/**
 * Check if a name is a Node.js built-in module.
 *
 * @param name Module name to check
 * @returns True if it's a built-in
 *
 * @example
 * ```ts
 * isNodeBuiltin("fs") // true
 * isNodeBuiltin("lodash") // false
 * ```
 */
export function isNodeBuiltin(name: string): boolean {
  // Handle node: prefix
  const baseName = name.startsWith("node:") ? name.slice(5) : name;
  // Handle subpaths like "fs/promises"
  const moduleName = baseName.split("/")[0];
  return NODE_BUILTINS.has(moduleName);
}

/**
 * Get a list of all Node.js built-in module names.
 *
 * @returns Array of built-in module names
 */
export function getNodeBuiltins(): string[] {
  return Array.from(NODE_BUILTINS);
}

// =============================================================================
// Exports for testing
// =============================================================================

export { NODE_BUILTINS, BLACKLIST };