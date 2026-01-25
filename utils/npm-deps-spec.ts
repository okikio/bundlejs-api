/**
 * Parse npm dependency specifiers found in package.json dependencies.
 *
 * Supported classifications:
 * - semver ranges / exact versions (e.g. "^1.2.3", "1.2.3", "~2")
 * - dist-tags (e.g. "latest", "next")
 * - npm alias (e.g. "npm:react@^18")
 * - URLs (e.g. "https://pkg.pr.new/@tanstack/react-query@7988")
 * - explicit unsupported placeholders (git/file/workspace/link)
 *
 * Why this exists:
 * - package.json dependencies can have many formats beyond simple semver
 * - The CDN plugin needs to route URL-based versions through TarballPlugin
 * - npm aliases need to be unwrapped before resolution
 * - git/file/workspace/link specs need clear error messages
 *
 * @example
 * parseNpmDependencySpec("npm:react@^18")
 * // => { kind: "alias", target: { name:"react", version:"^18", path:"" } }
 *
 * @example
 * parseNpmDependencySpec("https://pkg.pr.new/@tanstack/react-query@7988")
 * // => { kind: "url", url: "https://..." }
 *
 * @example
 * parseNpmDependencySpec("^1.2.3")
 * // => { kind: "semver", raw: "^1.2.3" }
 */

import { parsePackageName } from "./parse-package-name.ts";
import { parseRange } from "./semver.ts";

/**
 * Classification of an npm dependency specifier.
 *
 * The union covers:
 * - semver: Standard version ranges ("^1.0.0", "~2.3", "1.x", ">=1.0.0 <2.0.0")
 * - tag: Dist tags ("latest", "next", "canary", "beta")
 * - alias: npm protocol aliases ("npm:lodash@^4", "npm:@scope/pkg@1.0.0")
 * - url: HTTP/HTTPS URLs to tarballs or package endpoints
 * - git: Git protocol specs (git+https://, github:, etc.)
 * - file: Local file references (file:../local-pkg)
 * - workspace: Workspace protocol (workspace:*)
 * - link: Link protocol (link:../shared)
 * - unknown: Couldn't classify
 */
export type NpmDependencySpec =
  | { kind: "semver"; raw: string }
  | { kind: "tag"; raw: string }
  | { kind: "alias"; raw: string; target: { name: string; version: string; path: string } }
  | { kind: "url"; raw: string; url: string }
  | { kind: "git"; raw: string }
  | { kind: "file"; raw: string }
  | { kind: "workspace"; raw: string }
  | { kind: "link"; raw: string }
  | { kind: "unknown"; raw: string };

/**
 * Pattern for git-based dependency specs.
 *
 * Covers:
 * - git+https://github.com/user/repo.git
 * - git://github.com/user/repo.git
 * - github:user/repo
 * - gitlab:user/repo
 * - bitbucket:user/repo
 * - gist:hash
 * - ssh://git@github.com/user/repo.git
 * - git@github.com:user/repo.git
 */
const GIT_PREFIX_RE = /^(git\+|git:\/\/|github:|gitlab:|bitbucket:|gist:|ssh:\/\/|git@)/i;

/**
 * Pattern for valid dist-tag identifiers.
 *
 * Dist tags are simple identifiers that can contain:
 * - alphanumeric characters
 * - dots, dashes, underscores
 * - must start with alphanumeric
 *
 * Examples: latest, next, canary, beta, rc-1, v2.0-preview
 */
const DIST_TAG_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/**
 * Parse an npm dependency specifier into its classification.
 *
 * @param raw The raw specifier string from package.json dependencies
 * @returns Classified spec with kind and relevant data
 *
 * @example
 * ```ts
 * // Semver range
 * parseNpmDependencySpec("^1.2.3")
 * // { kind: "semver", raw: "^1.2.3" }
 *
 * // npm alias
 * parseNpmDependencySpec("npm:react@^18")
 * // { kind: "alias", raw: "npm:react@^18", target: { name: "react", version: "^18", path: "" } }
 *
 * // URL (tarball)
 * parseNpmDependencySpec("https://pkg.pr.new/@tanstack/react-query@7988")
 * // { kind: "url", raw: "...", url: "https://..." }
 *
 * // Git reference
 * parseNpmDependencySpec("github:user/repo#branch")
 * // { kind: "git", raw: "github:user/repo#branch" }
 * ```
 */
export function parseNpmDependencySpec(raw: string): NpmDependencySpec {
  const spec = (raw ?? "").trim();
  if (!spec) return { kind: "unknown", raw };

  // npm: alias - unwrap and parse inner spec
  if (spec.startsWith("npm:")) {
    const inner = spec.slice(4);
    const parsed = parsePackageName(inner);
    return {
      kind: "alias",
      raw,
      target: {
        name: parsed.name,
        version: parsed.version ?? "latest",
        path: parsed.path ?? "",
      },
    };
  }

  // workspace: protocol
  if (spec.startsWith("workspace:")) {
    return { kind: "workspace", raw };
  }

  // link: protocol
  if (spec.startsWith("link:")) {
    return { kind: "link", raw };
  }

  // file: protocol
  if (spec.startsWith("file:")) {
    return { kind: "file", raw };
  }

  // Git-based specs (various protocols and shorthands)
  if (GIT_PREFIX_RE.test(spec)) {
    return { kind: "git", raw };
  }

  // HTTP/HTTPS URLs
  if (/^https?:\/\//i.test(spec)) {
    return { kind: "url", raw, url: spec };
  }

  // Try parsing as semver range
  try {
    parseRange(spec);
    return { kind: "semver", raw };
  } catch {
    // Not a valid semver range, check if it's a dist-tag
    if (DIST_TAG_RE.test(spec)) {
      return { kind: "tag", raw };
    }
    return { kind: "unknown", raw };
  }
}

/**
 * Check if a dependency spec is a URL that should be handled by TarballPlugin.
 */
export function isUrlSpec(spec: NpmDependencySpec): spec is { kind: "url"; raw: string; url: string } {
  return spec.kind === "url";
}

/**
 * Check if a dependency spec is an npm alias that needs unwrapping.
 */
export function isAliasSpec(spec: NpmDependencySpec): spec is {
  kind: "alias";
  raw: string;
  target: { name: string; version: string; path: string };
} {
  return spec.kind === "alias";
}

/**
 * Check if a dependency spec is unsupported (git/file/workspace/link).
 */
export function isUnsupportedSpec(spec: NpmDependencySpec): boolean {
  return (
    spec.kind === "git" ||
    spec.kind === "file" ||
    spec.kind === "workspace" ||
    spec.kind === "link"
  );
}

/**
 * Check if a dependency spec resolves to a standard npm version (semver or tag).
 */
export function isNpmVersionSpec(spec: NpmDependencySpec): boolean {
  return spec.kind === "semver" || spec.kind === "tag";
}

/**
 * Join two subpaths, handling leading/trailing slashes.
 *
 * @example
 * joinSubpath("/build", "modern") // "/build/modern"
 * joinSubpath("", "/dist/index.js") // "/dist/index.js"
 * joinSubpath("/", "") // "/"
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

/**
 * Generate a user-friendly error message for unsupported spec types.
 */
export function getUnsupportedSpecError(spec: NpmDependencySpec, packageName: string): string {
  switch (spec.kind) {
    case "git":
      return (
        `Package "${packageName}" uses a git dependency: "${spec.raw}". ` +
        `Git-based dependencies are not yet supported. ` +
        `Consider using an npm-published version or a tarball URL instead.`
      );
    case "file":
      return (
        `Package "${packageName}" uses a file dependency: "${spec.raw}". ` +
        `Local file dependencies cannot be resolved in a browser-based bundler. ` +
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
    default:
      return (
        `Package "${packageName}" uses an unsupported dependency format: "${spec.raw}". ` +
        `Please use a semver version, dist-tag, npm alias, or tarball URL.`
      );
  }
}