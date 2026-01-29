/**
 * npm dependency specifier parser.
 *
 * Parses package.json dependency specifiers following npm-package-arg behavior.
 * Used by the CDN plugin to classify and route dependencies correctly.
 *
 * Key features:
 * - GitHub shorthand detection (user/repo → git)
 * - Git fragment parsing (#semver:^1.0.0, #path:/packages/foo)
 * - npm alias validation (no nested, registry-only targets)
 * - Dist-tag validation using npm's encodeURIComponent rule
 * - File vs directory classification by extension
 *
 * @module
 *
 * @example Basic usage
 * ```ts
 * import { parseNpmSpec, isRegistrySpec, isUrlSpec } from "./npm-spec.ts";
 *
 * const spec = parseNpmSpec("^1.2.3");
 * if (isRegistrySpec(spec)) {
 *   // Resolve via npm registry
 * }
 *
 * const urlSpec = parseNpmSpec("https://pkg.pr.new/@tanstack/react-query@7988");
 * if (isUrlSpec(urlSpec)) {
 *   // Route to TarballPlugin
 * }
 * ```
 */

import { parsePackageName } from "./parse-package-name.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed git fragment data.
 *
 * npm supports these fragment formats separated by `::`:
 * - Plain committish: #v1.0.0, #main, #abc123
 * - Semver range: #semver:^1.0.0
 * - Subdir path: #path:/packages/foo
 * - Combined: #main::semver:^1.0.0::path:/packages/foo
 */
export interface GitFragment {
  /** Git ref (branch, tag, commit SHA) */
  committish: string | null;
  /** Semver range to match against git tags */
  semverRange: string | null;
  /** Subdirectory within the repo */
  subdir: string | null;
}

/**
 * Hosted git service info.
 */
export interface HostedGitInfo {
  type: "github" | "gitlab" | "bitbucket" | "gist";
  user: string | null;
  project: string | null;
}

/**
 * Base fields for all spec types.
 */
interface BaseSpec {
  /** Original raw specifier string */
  raw: string;
}

/**
 * Registry-resolvable spec (semver range, exact version, or dist-tag).
 */
export interface RegistrySpec extends BaseSpec {
  kind: "semver" | "version" | "tag";
  /** The spec to use for registry lookup */
  fetchSpec: string;
}

/**
 * npm alias spec (npm:package@version).
 */
export interface AliasSpec extends BaseSpec {
  kind: "alias";
  /** The inner registry spec */
  subSpec: RegistrySpec;
  /** Parsed target package info */
  target: {
    name: string;
    version: string;
    path: string;
  };
}

/**
 * HTTP/HTTPS URL spec (remote tarball).
 */
export interface UrlSpec extends BaseSpec {
  kind: "url";
  /** The URL to fetch */
  url: string;
}

/**
 * Git-based spec with parsed fragment.
 */
export interface GitSpec extends BaseSpec {
  kind: "git";
  /** Git committish (branch, tag, SHA) */
  gitCommittish: string | null;
  /** Semver range from fragment (#semver:^1.0.0) */
  gitRange: string | null;
  /** Subdirectory from fragment (#path:/packages/foo) */
  gitSubdir: string | null;
  /** Hosted service info if recognized */
  hosted: HostedGitInfo | null;
}

/**
 * Local file spec (tarball).
 */
export interface FileSpec extends BaseSpec {
  kind: "file";
  /** Path to the file */
  fetchSpec: string;
}

/**
 * Local directory spec.
 */
export interface DirectorySpec extends BaseSpec {
  kind: "directory";
  /** Path to the directory */
  fetchSpec: string;
}

/**
 * Workspace protocol spec (workspace:*).
 */
export interface WorkspaceSpec extends BaseSpec {
  kind: "workspace";
  /** The workspace selector (*, ^, ~, or version) */
  workspaceSpec: string;
}

/**
 * Link protocol spec (link:../path).
 */
export interface LinkSpec extends BaseSpec {
  kind: "link";
  /** The link target path */
  fetchSpec: string;
}

/**
 * Unknown or invalid spec.
 */
export interface UnknownSpec extends BaseSpec {
  kind: "unknown";
  /** Error message describing why parsing failed */
  error?: string;
}

/**
 * Union of all spec types.
 */
export type NpmDependencySpec =
  | RegistrySpec
  | AliasSpec
  | UrlSpec
  | GitSpec
  | FileSpec
  | DirectorySpec
  | WorkspaceSpec
  | LinkSpec
  | UnknownSpec;

// =============================================================================
// Detection Patterns
// =============================================================================

/**
 * Explicit git protocol prefixes.
 *
 * Matches:
 * - git+https://, git+ssh://, git+file://, git://
 * - github:, gitlab:, bitbucket:, gist:
 * - ssh://
 * - git@ (SCP-style)
 */
const GIT_PREFIX_RE = /^(git\+|git:\/\/|github:|gitlab:|bitbucket:|gist:|ssh:\/\/|git@)/i;

/**
 * Tarball file extensions.
 * Used to distinguish file: specs from directory: specs.
 */
const TARBALL_EXT_RE = /[.](?:tgz|tar\.gz|tar)$/i;

/**
 * Port number pattern (used to distinguish SCP from URL with port).
 */
const PORT_RE = /:[0-9]+(\/|$)/;

/**
 * File-like path pattern (POSIX).
 */
const FILE_PATH_RE = /^(?:[.]|~[/]|[/]|[a-zA-Z]:)/;

// =============================================================================
// GitHub Shorthand Detection
// =============================================================================

/**
 * Detect GitHub shorthand format: user/repo or user/repo#ref
 *
 * Based on hosted-git-info's isGitHubShorthand() function.
 * See: https://github.com/npm/hosted-git-info/blob/main/lib/from-url.js
 *
 * Must NOT match:
 * - Scoped packages (@scope/pkg) - @ before first /
 * - Relative paths (./foo, ../foo) - starts with .
 * - URLs (has ://)
 * - SCP URLs (git@host:path) - @ before first /
 * - Multi-level paths (a/b/c) - second / before #
 *
 * @param arg The string to test
 * @returns True if this looks like user/repo shorthand
 *
 * @example
 * isGitHubShorthand("facebook/react") // true
 * isGitHubShorthand("facebook/react#main") // true
 * isGitHubShorthand("@types/node") // false (scoped package)
 * isGitHubShorthand("./local") // false (relative path)
 * isGitHubShorthand("git@github.com:user/repo") // false (SCP)
 */
export function isGitHubShorthand(arg: string): boolean {
  const firstHash = arg.indexOf("#");
  const firstSlash = arg.indexOf("/");
  const secondSlash = arg.indexOf("/", firstSlash + 1);
  const firstColon = arg.indexOf(":");
  const firstSpace = arg.search(/\s/);
  const firstAt = arg.indexOf("@");

  // Must have exactly one slash (before #)
  const hasSlash = firstSlash > 0;
  const secondSlashOnlyAfterHash =
    secondSlash === -1 || (firstHash > -1 && secondSlash > firstHash);

  // No colons before # (protocols, SCP)
  const colonOnlyAfterHash =
    firstColon === -1 || (firstHash > -1 && firstColon > firstHash);

  // No @ before first slash (scoped packages, SCP)
  const atOnlyAfterHash =
    firstAt === -1 || (firstHash > -1 && firstAt > firstHash);

  // No whitespace before #
  const spaceOnlyAfterHash =
    firstSpace === -1 || (firstHash > -1 && firstSpace > firstHash);

  // Doesn't start with . (relative path)
  const doesNotStartWithDot = !arg.startsWith(".");

  // Doesn't end with / right before # (malformed)
  const doesNotEndWithSlash =
    firstHash > -1 ? arg[firstHash - 1] !== "/" : !arg.endsWith("/");

  return (
    hasSlash &&
    secondSlashOnlyAfterHash &&
    colonOnlyAfterHash &&
    atOnlyAfterHash &&
    spaceOnlyAfterHash &&
    doesNotStartWithDot &&
    doesNotEndWithSlash
  );
}

// =============================================================================
// Git Fragment Parsing
// =============================================================================

/**
 * Parse git fragment (part after #) into structured data.
 *
 * Based on npm-package-arg's setGitAttrs() function.
 * See: https://github.com/npm/npm-package-arg/blob/main/lib/npa.js
 *
 * Fragment formats separated by `::`:
 * - Plain committish: v1.0.0, main, abc123
 * - Semver range: semver:^1.0.0
 * - Subdir path: path:/packages/foo
 * - Combined: main::path:/packages/foo
 *
 * @param fragment The fragment string (without leading #)
 * @returns Parsed fragment data
 * @throws Error if fragment has conflicting parts
 *
 * @example
 * parseGitFragment("main")
 * // => { committish: "main", semverRange: null, subdir: null }
 *
 * parseGitFragment("semver:^1.0.0")
 * // => { committish: null, semverRange: "^1.0.0", subdir: null }
 *
 * parseGitFragment("v1.0.0::path:/packages/core")
 * // => { committish: "v1.0.0", semverRange: null, subdir: "/packages/core" }
 */
export function parseGitFragment(fragment: string): GitFragment {
  if (!fragment) {
    return { committish: null, semverRange: null, subdir: null };
  }

  let committish: string | null = null;
  let semverRange: string | null = null;
  let subdir: string | null = null;

  // Split on :: (npm's separator)
  for (const part of fragment.split("::")) {
    const colonIdx = part.indexOf(":");

    // No colon = plain committish
    if (colonIdx === -1) {
      if (!committish && !semverRange) {
        committish = part;
      }
      continue;
    }

    const key = part.slice(0, colonIdx);
    const value = part.slice(colonIdx + 1);

    if (key === "semver") {
      if (committish) {
        throw new Error("Cannot use semver range with explicit committish");
      }
      if (semverRange) {
        throw new Error("Multiple semver ranges not allowed");
      }
      semverRange = decodeURIComponent(value);
    } else if (key === "path") {
      if (subdir) {
        throw new Error("Multiple path specifiers not allowed");
      }
      subdir = value.startsWith("/") ? value : `/${value}`;
    }
    // Unknown keys silently ignored (matches npm behavior)
  }

  return { committish, semverRange, subdir };
}

// =============================================================================
// Hosted Git Parsing
// =============================================================================

/**
 * Extract hosted git service info from a spec.
 *
 * @param spec The spec string
 * @returns Hosted info or null if not a recognized host
 */
function parseHostedGit(spec: string): HostedGitInfo | null {
  // Explicit shortcuts: github:user/repo, gitlab:user/repo, etc.
  const shortcutMatch = spec.match(/^(github|gitlab|bitbucket|gist):/i);
  if (shortcutMatch) {
    const type = shortcutMatch[1].toLowerCase() as HostedGitInfo["type"];
    const rest = spec.slice(shortcutMatch[0].length);
    const hashIdx = rest.indexOf("#");
    const pathPart = hashIdx > -1 ? rest.slice(0, hashIdx) : rest;

    const slashIdx = pathPart.indexOf("/");
    if (slashIdx > 0) {
      const user = pathPart.slice(0, slashIdx);
      let project = pathPart.slice(slashIdx + 1);
      if (project.endsWith(".git")) project = project.slice(0, -4);
      return { type, user, project };
    }

    // Gist can be just a hash
    if (type === "gist" && pathPart) {
      return { type, user: null, project: pathPart };
    }
  }

  // GitHub shorthand: user/repo
  if (isGitHubShorthand(spec)) {
    const hashIdx = spec.indexOf("#");
    const pathPart = hashIdx > -1 ? spec.slice(0, hashIdx) : spec;
    const slashIdx = pathPart.indexOf("/");

    if (slashIdx > 0) {
      const user = pathPart.slice(0, slashIdx);
      let project = pathPart.slice(slashIdx + 1);
      if (project.endsWith(".git")) project = project.slice(0, -4);
      return { type: "github", user, project };
    }
  }

  // Full URLs to known hosts
  try {
    const url = new URL(spec.replace(/^git\+/, ""));
    const hostname = url.hostname.replace(/^www\./, "");

    const hostMap: Record<string, HostedGitInfo["type"]> = {
      "github.com": "github",
      "gitlab.com": "gitlab",
      "bitbucket.org": "bitbucket",
      "gist.github.com": "gist",
    };

    const type = hostMap[hostname];
    if (type) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const user = parts[0];
        let project = parts[1];
        if (project.endsWith(".git")) project = project.slice(0, -4);
        return { type, user, project };
      }
    }
  } catch {
    // Not a valid URL
  }

  return null;
}

// =============================================================================
// Spec Type Detection
// =============================================================================

/**
 * Check if spec looks like a file path.
 */
function isFilePath(spec: string): boolean {
  if (spec.toLowerCase().startsWith("file:")) return true;
  return FILE_PATH_RE.test(spec);
}

/**
 * Check if spec is a git URL or shorthand.
 */
function isGitUrl(spec: string): boolean {
  // Explicit git prefixes
  if (GIT_PREFIX_RE.test(spec)) return true;

  // SCP-style URLs, but not URLs with port numbers
  // git@github.com:user/repo vs ssh://git@host:1234/repo
  if (/^[^@]+@[^:]+:.+/.test(spec) && !PORT_RE.test(spec)) return true;

  // GitHub shorthand
  if (isGitHubShorthand(spec)) return true;

  return false;
}

/**
 * Validate dist-tag name using npm's rule.
 *
 * npm uses: encodeURIComponent(tag) !== tag
 * This catches any character that needs URL encoding.
 */
function isValidDistTag(tag: string): boolean {
  return encodeURIComponent(tag) === tag;
}

/**
 * Check if a string is a valid semver version.
 *
 * Simplified check - full validation happens in semver module.
 */
function looksLikeSemver(spec: string): boolean {
  // Simple heuristic: contains digits and common semver chars
  // The parseRange call in main parser does the real validation
  return /^[0-9vV*xX~^<>=|&\s.-]+$/.test(spec) || spec === "*" || spec === "";
}

// =============================================================================
// Main Parser
// =============================================================================

/**
 * Parse an npm dependency specifier into a classified spec.
 *
 * Follows npm-package-arg's parsing order:
 * 1. npm: alias prefix
 * 2. workspace:/link: protocols
 * 3. file: or path-like specs
 * 4. Git URLs and shorthands
 * 5. HTTP/HTTPS URLs
 * 6. Semver ranges
 * 7. Dist-tags
 *
 * @param raw The raw specifier from package.json dependencies
 * @returns Classified spec with kind and relevant data
 *
 * @example Registry specs
 * ```ts
 * parseNpmSpec("^1.2.3")
 * // => { kind: "semver", raw: "^1.2.3", fetchSpec: "^1.2.3" }
 *
 * parseNpmSpec("1.2.3")
 * // => { kind: "version", raw: "1.2.3", fetchSpec: "1.2.3" }
 *
 * parseNpmSpec("latest")
 * // => { kind: "tag", raw: "latest", fetchSpec: "latest" }
 * ```
 *
 * @example Alias specs
 * ```ts
 * parseNpmSpec("npm:react@^18")
 * // => { kind: "alias", subSpec: { kind: "semver", ... },
 * //      target: { name: "react", version: "^18", path: "" } }
 * ```
 *
 * @example Git specs
 * ```ts
 * parseNpmSpec("github:user/repo#semver:^1.0.0")
 * // => { kind: "git", gitRange: "^1.0.0", hosted: { type: "github", ... } }
 *
 * parseNpmSpec("user/repo")
 * // => { kind: "git", hosted: { type: "github", user: "user", project: "repo" } }
 * ```
 */
export function parseNpmSpec(raw: string): NpmDependencySpec {
  const spec = (raw ?? "").trim();
  if (!spec) {
    return { kind: "unknown", raw, error: "Empty specifier" };
  }

  // =========================================================================
  // npm: alias
  // =========================================================================
  if (spec.toLowerCase().startsWith("npm:")) {
    const inner = spec.slice(4);

    // No nested aliases
    if (inner.toLowerCase().startsWith("npm:")) {
      return {
        kind: "unknown",
        raw,
        error: "Nested aliases not supported",
      };
    }

    // Parse inner as package name
    const parsed = parsePackageName(inner, { ignoreError: true });

    // Must have a name
    if (!parsed.name) {
      return {
        kind: "unknown",
        raw,
        error: "Alias must specify package name",
      };
    }

    // Target must be registry-resolvable (not path or URL)
    if (
      parsed.name.startsWith(".") ||
      parsed.name.startsWith("/") ||
      parsed.name.includes("://") ||
      (parsed.name.includes(":") && !parsed.name.startsWith("@"))
    ) {
      return {
        kind: "unknown",
        raw,
        error: "Alias targets must be registry packages",
      };
    }

    // Parse version as registry spec
    // npm defaults to * not latest when no version specified
    const versionSpec = parsed.version ?? "*";
    const subSpec = parseRegistrySpec(versionSpec);

    if (subSpec.kind === "unknown") {
      return {
        kind: "unknown",
        raw,
        error: `Invalid alias version: ${versionSpec}`,
      };
    }

    return {
      kind: "alias",
      raw,
      subSpec: subSpec as RegistrySpec,
      target: {
        name: parsed.name,
        version: versionSpec,
        path: parsed.path ?? "",
      },
    };
  }

  // =========================================================================
  // workspace: protocol
  // =========================================================================
  if (spec.toLowerCase().startsWith("workspace:")) {
    return {
      kind: "workspace",
      raw,
      workspaceSpec: spec.slice(10) || "*",
    };
  }

  // =========================================================================
  // link: protocol
  // =========================================================================
  if (spec.toLowerCase().startsWith("link:")) {
    return {
      kind: "link",
      raw,
      fetchSpec: spec.slice(5),
    };
  }

  // =========================================================================
  // file: or path-like
  // =========================================================================
  if (isFilePath(spec)) {
    const path = spec.toLowerCase().startsWith("file:") ? spec.slice(5) : spec;

    // Distinguish file (tarball) from directory by extension
    if (TARBALL_EXT_RE.test(path)) {
      return { kind: "file", raw, fetchSpec: path };
    }
    return { kind: "directory", raw, fetchSpec: path };
  }

  // =========================================================================
  // Git specs
  // =========================================================================
  if (isGitUrl(spec)) {
    const hashIdx = spec.indexOf("#");
    const fragment = hashIdx > -1 ? spec.slice(hashIdx + 1) : "";

    let fragmentData: GitFragment;
    try {
      fragmentData = parseGitFragment(fragment);
    } catch (e) {
      return {
        kind: "unknown",
        raw,
        error: e instanceof Error ? e.message : "Invalid git fragment",
      };
    }

    const hosted = parseHostedGit(spec);

    return {
      kind: "git",
      raw,
      gitCommittish: fragmentData.committish,
      gitRange: fragmentData.semverRange,
      gitSubdir: fragmentData.subdir,
      hosted,
    };
  }

  // =========================================================================
  // HTTP/HTTPS URLs
  // =========================================================================
  if (/^https?:\/\//i.test(spec)) {
    return { kind: "url", raw, url: spec };
  }

  // =========================================================================
  // Registry specs (semver, version, tag)
  // =========================================================================
  return parseRegistrySpec(spec);
}

/**
 * Parse a registry spec (semver range, exact version, or tag).
 */
function parseRegistrySpec(spec: string): RegistrySpec | UnknownSpec {
  const trimmed = spec.trim();

  // Empty or wildcard = valid semver range
  if (trimmed === "" || trimmed === "*") {
    return { kind: "semver", raw: spec, fetchSpec: trimmed || "*" };
  }

  // Check for semver range characters
  if (looksLikeSemver(trimmed)) {
    // Further validation would use parseRange() but that throws
    // For now, if it looks like semver, treat it as semver
    // The exact vs range distinction is less important for routing
    if (/^\d+\.\d+\.\d+/.test(trimmed) && !/[~^<>=|]/.test(trimmed)) {
      return { kind: "version", raw: spec, fetchSpec: trimmed };
    }
    return { kind: "semver", raw: spec, fetchSpec: trimmed };
  }

  // Check if valid dist-tag
  if (isValidDistTag(trimmed)) {
    return { kind: "tag", raw: spec, fetchSpec: trimmed };
  }

  return {
    kind: "unknown",
    raw: spec,
    error: "Not a valid semver range or dist-tag",
  };
}

// =============================================================================
// Backwards Compatibility
// =============================================================================

/**
 * @deprecated Use parseNpmSpec instead
 */
export const parseNpmDependencySpec = parseNpmSpec;

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if spec is a URL to be handled by TarballPlugin.
 */
export function isUrlSpec(spec: NpmDependencySpec): spec is UrlSpec {
  return spec.kind === "url";
}

/**
 * Check if spec is an npm alias.
 */
export function isAliasSpec(
  spec: NpmDependencySpec
): spec is AliasSpec {
  return spec.kind === "alias";
}

/**
 * Check if spec is a git reference.
 */
export function isGitSpec(spec: NpmDependencySpec): spec is GitSpec {
  return spec.kind === "git";
}

/**
 * Check if spec resolves via npm registry.
 */
export function isRegistrySpec(
  spec: NpmDependencySpec
): spec is RegistrySpec | AliasSpec {
  return (
    spec.kind === "semver" ||
    spec.kind === "version" ||
    spec.kind === "tag" ||
    spec.kind === "alias"
  );
}

/**
 * Check if spec is unsupported in browser context.
 */
export function isUnsupportedSpec(spec: NpmDependencySpec): boolean {
  return (
    spec.kind === "git" ||
    spec.kind === "file" ||
    spec.kind === "directory" ||
    spec.kind === "workspace" ||
    spec.kind === "link"
  );
}

/**
 * Check if spec is a standard npm version (semver or tag).
 * @deprecated Use isRegistrySpec instead
 */
export function isNpmVersionSpec(spec: NpmDependencySpec): boolean {
  return spec.kind === "semver" || spec.kind === "version" || spec.kind === "tag";
}

// =============================================================================
// Path Utilities
// =============================================================================

/**
 * Join two subpaths, handling slashes.
 *
 * @example
 * joinSubpath("/build", "modern") // "/build/modern"
 * joinSubpath("", "/dist/index.js") // "/dist/index.js"
 */
export function joinSubpath(a: string, b: string): string {
  const left = (a ?? "").replace(/\/+$/, "");
  const right = (b ?? "").replace(/^\/+/, "");
  if (!left && !right) return "";
  if (!left) return "/" + right;
  if (!right) return left.startsWith("/") ? left : "/" + left;
  return (left.startsWith("/") ? left : "/" + left) + "/" + right;
}

/**
 * Append a subpath to a URL's pathname.
 *
 * @example
 * appendUrlSubpath("https://pkg.pr.new/@tanstack/react-query@7988", "/build/modern")
 * // "https://pkg.pr.new/@tanstack/react-query@7988/build/modern"
 */
export function appendUrlSubpath(baseUrl: string, subpath: string): string {
  if (!subpath) return baseUrl;
  const u = new URL(baseUrl);
  u.pathname = joinSubpath(u.pathname, subpath);
  return u.toString();
}

// =============================================================================
// Error Messages
// =============================================================================

/**
 * Generate user-friendly error for unsupported spec types.
 */
export function getUnsupportedSpecError(
  spec: NpmDependencySpec,
  packageName: string
): string {
  switch (spec.kind) {
    case "git": {
      const gitSpec = spec as GitSpec;
      const hostedInfo = gitSpec.hosted
        ? ` (${gitSpec.hosted.type}: ${gitSpec.hosted.user}/${gitSpec.hosted.project})`
        : "";
      return (
        `Package "${packageName}" uses a git dependency${hostedInfo}: "${spec.raw}". ` +
        `Git dependencies are not supported in browser bundlers. ` +
        `Consider using an npm-published version or a tarball URL instead.`
      );
    }
    case "file":
      return (
        `Package "${packageName}" uses a file dependency: "${spec.raw}". ` +
        `Local file dependencies cannot be resolved in a browser bundler. ` +
        `Upload the package to npm or use a tarball URL instead.`
      );
    case "directory":
      return (
        `Package "${packageName}" uses a directory dependency: "${spec.raw}". ` +
        `Local directory dependencies cannot be resolved in a browser bundler. ` +
        `Upload the package to npm or use a tarball URL instead.`
      );
    case "workspace":
      return (
        `Package "${packageName}" uses a workspace dependency: "${spec.raw}". ` +
        `Workspace protocols require a monorepo context. ` +
        `Use an explicit version or publish the package to npm.`
      );
    case "link":
      return (
        `Package "${packageName}" uses a link dependency: "${spec.raw}". ` +
        `Link protocols require filesystem access. ` +
        `Use an explicit version or publish the package to npm.`
      );
    case "unknown": {
      const error = (spec as UnknownSpec).error;
      return (
        `Package "${packageName}" has an invalid dependency: "${spec.raw}". ` +
        (error ? `${error}. ` : "") +
        `Use a semver version, dist-tag, npm alias, or tarball URL.`
      );
    }
    default:
      return (
        `Package "${packageName}" uses an unsupported format: "${spec.raw}". ` +
        `Use a semver version, dist-tag, npm alias, or tarball URL.`
      );
  }
}