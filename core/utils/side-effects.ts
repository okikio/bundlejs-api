// core/utils/side-effects.ts
import type { PackageJson, FullPackageVersion } from "@bundle/utils/types";

import { extname, globToRegExp } from "@bundle/utils/path";

/**
 * Normalizes a package-relative path so it can be matched against package.json sideEffects patterns.
 *
 * - Strips leading "/" or "./"
 * - Strips query/hash
 * - Keeps POSIX separators (which is what npm package paths use)
 */
export function normalizePkgRelPath(input: string): string {
  let s = input;

  // Drop query/hash (CDNs often append ?module etc.)
  s = s.replace(/[?#].*$/, "");

  // Convert "/x/y" -> "x/y" and "./x/y" -> "x/y"
  s = s.replace(/^\/+/, "");
  s = s.replace(/^\.\//, "");

  return s;
}

/**
 * Web bundlers typically only apply sideEffects pruning to JS modules.
 * In CDN environments, marking CSS/assets as side-effect-free is a common footgun.
 */
export function isJsLikePath(input: string): boolean {
  const e = extname(normalizePkgRelPath(input)).toLowerCase();

  // No extension could still be a directory entry resolved later; treat as JS-like.
  if (e.length === 0) return true;

  return (
    e === ".js" ||
    e === ".mjs" ||
    e === ".cjs" ||
    e === ".ts" ||
    e === ".mts" ||
    e === ".cts" ||
    e === ".jsx" ||
    e === ".tsx"
  );
}

export interface SideEffectsMatchers {
  raw: readonly string[];
  matchers: ReadonlyArray<RegExp>;
}

/**
 * Expands a webpack-style "match anywhere" convenience:
 * - If the pattern has no "/" it is assumed to match in any folder (=> "*\* /<pattern>")
 * - Strips leading "./" for consistency
 */
export function normalizeSideEffectsPattern(pattern: string): string {
  let p = pattern.trim();

  // Remove leading "./" (common in manifests)
  p = p.replace(/^\.\//, "");

  // If no slash is present, treat it like "match anywhere"
  // e.g. "*.css" -> "**/*.css"
  if (!p.includes("/")) p = `**/${p}`;

  return p;
}

export function compileSideEffectsMatchers(sideEffects: readonly string[]): SideEffectsMatchers {
  const matchers: RegExp[] = [];

  for (const raw of sideEffects) {
    if (typeof raw !== "string") continue;

    const pattern = normalizeSideEffectsPattern(raw);

    // globstar=true enables "**" semantics, extended=true enables richer glob syntax
    matchers.push(globToRegExp(pattern, { globstar: true, extended: true }));
  }

  return { raw: sideEffects, matchers };
}

/**
 * Computes the `OnResolveResult.sideEffects` value from a resolved manifest + resolved package subpath.
 *
 * Returns:
 * - `false` when we are confident the resolved module is side-effect-free
 * - `undefined` when we should not assert side-effect-freedom (default: has side effects)
 */
export function computeEsbuildSideEffects(
  manifest: Partial<PackageJson | FullPackageVersion> | null | undefined,
  resolvedPkgSubpath: string,
  opts?: {
    /**
     * Cache of compiled matchers keyed by a stable package id like `${name}@${version}`.
     * (Optional but recommended.)
     */
    matcherCache?: Map<string, SideEffectsMatchers>;
    packageId?: string;
  }
): boolean | undefined {
  if (!manifest) return undefined;

  // Only apply the hint to JS-like modules; avoid breaking CSS/assets in CDN mode.
  if (!isJsLikePath(resolvedPkgSubpath)) return undefined;

  const sideEffects = (manifest as { sideEffects?: unknown }).sideEffects;

  // sideEffects: true (or missing) => do nothing (default is "has side effects")
  if (sideEffects === true || sideEffects == null) return undefined;

  // sideEffects: false => the whole package is side-effect-free
  if (sideEffects === false) return false;

  // sideEffects: string[] => only matches are side-effectful; everything else is side-effect-free
  if (Array.isArray(sideEffects)) {
    const pkgRel = normalizePkgRelPath(resolvedPkgSubpath);

    let compiled: SideEffectsMatchers | undefined;
    const cache = opts?.matcherCache;
    const id = opts?.packageId;

    if (cache && id) {
      compiled = cache.get(id);
      if (!compiled) {
        compiled = compileSideEffectsMatchers(sideEffects);
        cache.set(id, compiled);
      }
    } else {
      compiled = compileSideEffectsMatchers(sideEffects);
    }

    for (const re of compiled.matchers) {
      if (re.test(pkgRel)) return undefined; // keep as side-effectful
    }

    return false; // not in list => side-effect-free
  }

  // Unknown shape => be conservative
  return undefined;
}
