/**
 * .npmrc Parser & Registry Resolution
 *
 * Parses `.npmrc` configuration files to extract registry URLs, supporting:
 * - Default registry override (`registry=https://...`)
 * - Scoped registries (`@scope:registry=https://...`)
 * - Comment stripping (`#` and `;` line comments)
 * - Environment variable interpolation (`${VAR}`)
 *
 * This is intentionally minimal — it only extracts registry configuration,
 * not auth tokens, proxy settings, or other npm config. Auth tokens are
 * security-sensitive and should not be exposed in a web-facing bundler.
 *
 * ## .npmrc format reference
 *
 * ```ini
 * # Default registry (applies to all unscoped packages)
 * registry=https://registry.npmjs.org/
 *
 * # Scoped registry (applies to packages under @scope)
 * @jsr:registry=https://npm.jsr.io
 * @mycompany:registry=https://npm.mycompany.com/
 *
 * # Auth tokens (parsed but NOT exposed — security boundary)
 * //registry.npmjs.org/:_authToken=${NPM_TOKEN}
 * ```
 *
 * @module
 *
 * @example Parse .npmrc content
 * ```ts
 * const config = parseNpmrc(`
 *   registry=https://registry.npmjs.org/
 *   @jsr:registry=https://npm.jsr.io
 * `);
 * // {
 * //   registry: "https://registry.npmjs.org/",
 * //   scopedRegistries: { "@jsr": "https://npm.jsr.io" }
 * // }
 * ```
 *
 * @example Resolve registry for a package
 * ```ts
 * getRegistryForPackage("@jsr/std__path", config)
 * // "https://npm.jsr.io"
 *
 * getRegistryForPackage("react", config)
 * // "https://registry.npmjs.org/"
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed registry configuration from .npmrc.
 *
 * Only registry-related settings are extracted. Auth tokens and other
 * npm config are intentionally excluded for security.
 */
export interface RegistryConfig {
  /**
   * Default registry URL for unscoped packages.
   *
   * Corresponds to `registry=<url>` in .npmrc.
   * Falls back to npm public registry if not set.
   */
  registry?: string;

  /**
   * Scoped registry overrides.
   *
   * Keys are scopes WITH the `@` prefix (e.g., `"@jsr"`, `"@mycompany"`).
   * Values are registry URLs.
   *
   * Corresponds to `@scope:registry=<url>` in .npmrc.
   *
   * @example
   * ```ts
   * {
   *   "@jsr": "https://npm.jsr.io",
   *   "@mycompany": "https://npm.mycompany.com/"
   * }
   * ```
   */
  scopedRegistries?: Record<string, string>;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * The official npm public registry URL.
 *
 * Used as the fallback when no registry is configured.
 */
export const NPM_PUBLIC_REGISTRY = "https://registry.npmjs.org";

// =============================================================================
// Parser
// =============================================================================

/**
 * Parse raw `.npmrc` content into a structured registry config.
 *
 * Handles:
 * - `registry=<url>` — default registry
 * - `@scope:registry=<url>` — scoped registry overrides
 * - `#` and `;` line comments
 * - Leading/trailing whitespace
 * - Environment variable interpolation (`${VAR}`) — replaced with empty
 *   string since we don't have access to the user's env vars
 *
 * Ignores all other .npmrc directives (auth tokens, proxy settings, etc.)
 * for security and simplicity.
 *
 * @param content Raw .npmrc file content
 * @returns Parsed registry configuration
 *
 * @example Basic usage
 * ```ts
 * parseNpmrc("registry=https://registry.npmjs.org/")
 * // { registry: "https://registry.npmjs.org/" }
 * ```
 *
 * @example Scoped registries
 * ```ts
 * parseNpmrc(`
 *   @jsr:registry=https://npm.jsr.io
 *   @company:registry=https://npm.company.com/
 * `)
 * // {
 * //   scopedRegistries: {
 * //     "@jsr": "https://npm.jsr.io",
 * //     "@company": "https://npm.company.com/"
 * //   }
 * // }
 * ```
 *
 * @example With comments and env vars
 * ```ts
 * parseNpmrc(`
 *   # Use custom registry
 *   registry=https://my-registry.com/
 *   ; Scoped to our org
 *   @myorg:registry=https://npm.myorg.com/
 *   //npm.myorg.com/:_authToken=${NPM_TOKEN}
 * `)
 * // { registry: "https://my-registry.com/", scopedRegistries: { "@myorg": "https://npm.myorg.com/" } }
 * ```
 */
export function parseNpmrc(content: string): RegistryConfig {
  const config: RegistryConfig = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    // Strip comments (# or ; at start of line, after optional whitespace)
    const line = rawLine.replace(/^\s*[#;].*$/, "").trim();
    if (!line) continue;

    // Skip auth/token lines (security boundary — never expose these)
    // Format: //registry.example.com/:_authToken=...
    if (line.startsWith("//")) continue;

    // ── Default registry ──────────────────────────────────────────────
    // Format: registry=<url>
    const defaultMatch = /^registry\s*=\s*(.+)$/.exec(line);
    if (defaultMatch) {
      config.registry = interpolateEnvVars(defaultMatch[1].trim());
      continue;
    }

    // ── Scoped registry ───────────────────────────────────────────────
    // Format: @scope:registry=<url>
    const scopedMatch = /^(@[a-z][a-z0-9._-]*):registry\s*=\s*(.+)$/i.exec(line);
    if (scopedMatch) {
      const scope = scopedMatch[1].toLowerCase();
      const url = interpolateEnvVars(scopedMatch[2].trim());

      if (!config.scopedRegistries) config.scopedRegistries = {};
      config.scopedRegistries[scope] = url;
      continue;
    }

    // All other directives are ignored (proxy, cache, strict-ssl, etc.)
  }

  return config;
}

/**
 * Replace `${VAR}` patterns with empty strings.
 *
 * In a web/edge context we don't have access to the user's environment
 * variables, so interpolation tokens are stripped. This prevents URLs
 * with unresolved `${...}` from causing fetch failures.
 *
 * @param value String potentially containing `${VAR}` patterns
 * @returns String with env var references removed
 */
function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{[^}]*\}/g, "");
}

// =============================================================================
// Registry Lookup
// =============================================================================

/**
 * Get the appropriate registry URL for a given package name.
 *
 * Resolution order:
 * 1. Scoped override — checks if the package scope has a custom registry
 * 2. Default registry — uses the config's `registry` field
 * 3. Fallback — returns the provided fallback URL (or npm public registry)
 *
 * @param name Full package name (e.g., "@jsr/std__path" or "react")
 * @param config Parsed registry configuration
 * @param fallback Fallback registry URL when no config match
 * @returns Registry URL for the package
 *
 * @example Scoped match
 * ```ts
 * const config = { scopedRegistries: { "@jsr": "https://npm.jsr.io" } };
 * getRegistryForPackage("@jsr/std__path", config)
 * // "https://npm.jsr.io"
 * ```
 *
 * @example Default match
 * ```ts
 * const config = { registry: "https://my-registry.com/" };
 * getRegistryForPackage("react", config)
 * // "https://my-registry.com/"
 * ```
 *
 * @example No match
 * ```ts
 * getRegistryForPackage("react", {})
 * // "https://registry.npmjs.org" (fallback)
 * ```
 */
export function getRegistryForPackage(
  name: string,
  config: RegistryConfig | null | undefined,
  fallback: string = NPM_PUBLIC_REGISTRY,
): string {
  if (!config) return fallback;

  // Check scoped registries first
  if (config.scopedRegistries && name.startsWith("@")) {
    const slashIdx = name.indexOf("/");
    if (slashIdx > 0) {
      const scope = name.slice(0, slashIdx); // e.g., "@jsr"
      if (scope in config.scopedRegistries) {
        return config.scopedRegistries[scope];
      }
    }
  }

  // Fall back to default registry, then to provided fallback
  return config.registry ?? fallback;
}

// =============================================================================
// Config Normalization
// =============================================================================

/**
 * Normalize registry configuration from various input formats.
 *
 * Accepts:
 * - `undefined/null` — returns undefined (use defaults)
 * - `string` — could be a registry URL or raw .npmrc content
 *   - If it contains `=` or newlines, treated as .npmrc content
 *   - Otherwise, treated as a default registry URL
 * - `RegistryConfig` object — returned as-is
 *
 * @param input Registry configuration input
 * @returns Normalized registry config, or undefined if no config
 *
 * @example Registry URL string
 * ```ts
 * normalizeRegistryConfig("https://npm.jsr.io")
 * // { registry: "https://npm.jsr.io" }
 * ```
 *
 * @example Raw .npmrc content
 * ```ts
 * normalizeRegistryConfig("@jsr:registry=https://npm.jsr.io\nregistry=https://my-reg.com")
 * // { registry: "https://my-reg.com", scopedRegistries: { "@jsr": "https://npm.jsr.io" } }
 * ```
 *
 * @example Structured config
 * ```ts
 * normalizeRegistryConfig({ registry: "https://npm.jsr.io" })
 * // { registry: "https://npm.jsr.io" }
 * ```
 */
export function normalizeRegistryConfig(
  input: string | RegistryConfig | null | undefined,
): RegistryConfig | undefined {
  if (input == null) return undefined;

  if (typeof input === "string") {
    // Heuristic: if it contains `=` or newlines, it's probably .npmrc content
    if (input.includes("=") || input.includes("\n")) {
      return parseNpmrc(input);
    }

    // Otherwise treat as a plain registry URL
    return { registry: input };
  }

  // Already a RegistryConfig object
  return input;
}
