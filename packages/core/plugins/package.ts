/**
 * Package Features Plugin for esbuild
 *
 * Centralizes package-level enrichment — sideEffects computation and
 * manifest field remapping — for **both** the VFS (tarball-extracted)
 * and HTTP (CDN-fetched) resolution paths. This eliminates the
 * duplication that previously split these concerns across TarballPlugin,
 * VFSPlugin, HttpPlugin, and CdnPlugin.
 *
 * ## Problem
 *
 * esbuild's `onResolve` is first-match-wins: the first plugin that
 * returns a result determines the module's path, namespace, **and**
 * `sideEffects` hint. Before this plugin, sideEffects and manifest
 * field remapping (browser, react-native, electron) were:
 *
 * - Computed in CdnPlugin for entry-point resolution (CDN path)
 * - Applied in HttpPlugin for relative imports within CDN packages
 * - **Missing entirely** for relative imports within tarball-extracted
 *   packages (VFS path)
 *
 * That meant tree-shaking was degraded for registry-mode packages,
 * and browser/react-native field remappings silently used the wrong
 * file for tarball-resolved packages.
 *
 * ## Solution
 *
 * PackagePlugin intercepts imports in **both** namespaces
 * when package context exists (`pluginData.packageRoot` for VFS,
 * `pluginData.packageBaseUrl` for HTTP). It normalizes the resolved
 * path to a package-relative form, then applies the same enrichment:
 *
 * ```
 *   Relative/absolute/delegated import from within a package
 *      │
 *      ▼
 *   PackagePlugin.onResolve
 *      │
 *      ├── Compute package-relative path
 *      │     VFS:  resolved - packageRoot   → "./lib/stream.js"
 *      │     HTTP: resolved - packageBaseUrl → "./lib/stream.js"
 *      │
 *      ├── Apply manifest field remappings
 *      │     browser / react-native / electron
 *      │     (first matching field wins, priority order)
 *      │
 *      ├── Compute sideEffects for this specific file
 *      │     boolean false → side-effect-free
 *      │     array patterns → match against file path
 *      │
 *      └── Return enriched resolve result
 *            { path, namespace, sideEffects }
 * ```
 *
 * When no package context exists (user-authored VFS files, direct
 * URL imports without a manifest), the plugin returns `undefined`
 * and the downstream VFS/HTTP plugins handle it as before.
 *
 * ## Plugin ordering
 *
 * ```
 *   AliasPlugin          1. Rewrites
 *   ExternalPlugin       2. Builtins
 *   TarballPlugin        3. Tarball fetch/extract/mount, entry resolution
 *   PackagePlugin        4. Per-file enrichment (sideEffects + remapping)  ← this
 *   VFSPlugin            5. Dumb filesystem (no package awareness)
 *   HttpPlugin           6. URL resolution + content fetching
 *   CdnPlugin            7. Bare import → CDN
 * ```
 *
 * Registered **before** both VFS and HTTP so its enriched result takes
 * priority. When it returns `undefined`, the downstream plugin handles
 * the import normally.
 *
 * @module
 */
import type { ResolverConditionInputs } from '@bundle/utils/resolve-conditions';
import type { PackageJson, FullPackageVersion } from '@bundle/utils/types';
import type { SideEffectsMatchers } from '../utils/side-effects.ts';
import type { LocalState, ESBUILD } from '../types.ts';
import type { Context } from '../context/context.ts';

import { fromContext, toContext } from '../context/context.ts';

import { resolve, dirname, isAbsolute } from '@bundle/utils/path';
import { urlJoin, toURLPath } from '@bundle/utils/url';

import { getResolverConditions } from '@bundle/utils/resolve-conditions';
import { applyManifestRemappings } from '../utils/cdn-resolution.ts';
import { computeEsbuildSideEffects } from '../utils/side-effects.ts';

import { maybeStripFlow } from '../utils/flow-strip.ts';
import { getFile, setFile } from '../utils/filesystem.ts';

import { VIRTUAL_FILESYSTEM_NAMESPACE, resolveVfsPath } from './fs.ts';
import { HTTP_NAMESPACE, determineExtension, fetchAssets } from './http.ts';
import { EXCLUDED_MODULE_NAMESPACE } from './external.ts';
import { RESOLVE_EXTENSIONS, inferLoader } from '../utils/loader.ts';
import { dispatchEvent, LOGGER_INFO, LOGGER_WARN } from '../configs/events.ts';

/** Package Plugin namespace (for identification; the plugin itself resolves into VFS/HTTP namespaces). */
export const PACKAGE_NAMESPACE = 'package-features';

// =============================================================================
// Shared plugin initialization
// =============================================================================

/**
 * Common plugin context values extracted from StateContext.
 *
 * Eliminates the repeated initialization boilerplate:
 * ```ts
 * const effectiveResolveOpts = Object.assign({}, resolveOpts, esbuildOpts);
 * const sideEffectsMatchersCache = fromContext('sideEffectsMatchersCache', ...);
 * ```
 */
export interface PluginContext {
  config: LocalState['config'];
  effectiveResolveOpts: ResolverConditionInputs;
  sideEffectsMatchersCache: Map<string, SideEffectsMatchers>;
}

export function createPluginContext<T>(StateContext: Context<LocalState<T>>): PluginContext {
  const config = fromContext('config', StateContext)!;
  return {
    config,
    effectiveResolveOpts: Object.assign({}, config.resolve ?? {}, config.esbuild ?? {}) as ResolverConditionInputs,
    sideEffectsMatchersCache: fromContext('sideEffectsMatchersCache', StateContext)
      ?? new Map<string, SideEffectsMatchers>(),
  };
}

// =============================================================================
// Shared enrichment
// =============================================================================

/**
 * Compute the package-relative path from a resolved absolute path and
 * a base (package root for VFS, package base URL for HTTP).
 *
 * Always returns a `"./"` prefixed relative path suitable for
 * `applyManifestRemappings()`, which expects that form.
 *
 * @example VFS
 * ```ts
 * toPackageRelative('/__tarballs__/abc123/lib/stream.js', '/__tarballs__/abc123')
 * // → './lib/stream.js'
 * ```
 *
 * @example HTTP
 * ```ts
 * toPackageRelative(
 *   'https://unpkg.com/readable-stream@4.0.0/lib/stream.js',
 *   'https://unpkg.com/readable-stream@4.0.0/'
 * )
 * // → './lib/stream.js'
 * ```
 */
export function toPackageRelative(resolvedPath: string, base: string): string | null {
  // Ensure base ends with a separator (/ for both URLs and VFS paths).
  const normalizedBase = base.endsWith('/') ? base : base + '/';

  if (!resolvedPath.startsWith(normalizedBase)) return null;

  return './' + resolvedPath.slice(normalizedBase.length);
}

/**
 * Build the stable package ID used as a cache key for sideEffects
 * matchers and other per-package caches.
 */
export function packageIdFrom(manifest: Partial<PackageJson | FullPackageVersion>): string {
  return `${manifest.name ?? 'unknown'}@${manifest.version ?? '0.0.0'}`;
}

// =============================================================================
// Exclusion handling (shared across VFS + HTTP enrichment)
// =============================================================================

/**
 * Build the esbuild `onResolve` return for a per-module exclusion
 * (manifest field maps to `false`).
 *
 * Respects the `remapFalse.importRemapFalse` policy from build config:
 * - `"stub"` (default) → empty export, optional warning
 * - `"error"` → hard build failure
 * - `"external"` → preserve import verbatim in output
 */
export function buildExclusionResult(
  relativePath: string,
  matchedField: string | null,
  manifest: Partial<PackageJson | FullPackageVersion>,
  config: LocalState['config'],
  pluginData: Record<string, unknown>,
  originalSpecifier: string,
): ESBUILD.OnResolveResult {
  const importPolicy = config.remapFalse?.importRemapFalse ?? 'stub';
  const warnOnStub = config.remapFalse?.warnOnStubbedRemapFalse ?? true;
  const pkgName = manifest.name ?? 'unknown';

  if (importPolicy === 'error') {
    return {
      errors: [{
        text: `Module "${relativePath}" is excluded for the current environment`,
        detail: `Excluded by "${matchedField}" field in package.json for "${pkgName}".`,
      }],
    };
  }

  if (importPolicy === 'external') {
    dispatchEvent(LOGGER_INFO, `Marking excluded module "${relativePath}" (${matchedField} field) as external in "${pkgName}"`);
    return {
      path: originalSpecifier,
      external: true,
    };
  }

  // Default: "stub"
  dispatchEvent(LOGGER_INFO, `Stubbing excluded module "${relativePath}" (${matchedField} field) in "${pkgName}"`);
  return {
    path: `${pkgName}/${relativePath}`,
    namespace: EXCLUDED_MODULE_NAMESPACE,
    pluginData: Object.assign({}, pluginData, {
      excludedBy: matchedField,
      originalPath: relativePath,
      suppressWarning: !warnOnStub,
    }),
  };
}

// =============================================================================
// Plugin
// =============================================================================

/**
 * esbuild plugin that enriches relative imports within packages with
 * `sideEffects` hints and manifest field remappings.
 *
 * Handles both VFS (tarball-extracted) and HTTP (CDN-fetched) namespaces.
 * When no package context exists in `pluginData`, returns `undefined` so
 * downstream plugins (VFS, HTTP) handle the import normally.
 *
 * @example Plugin registration order
 * ```ts
 * plugins: [
 *   AliasPlugin(StateContext),
 *   ExternalPlugin(StateContext),
 *   TarballPlugin(StateContext),
 *   PackagePlugin(StateContext),       // ← enrichment for both VFS + HTTP
 *   VirtualFileSystemPlugin(StateContext),
 *   HttpPlugin(StateContext),
 *   CdnPlugin(StateContext),
 * ]
 * ```
 *
 * @example What changes for a tarball-resolved relative import
 * ```ts
 * // Before (VFS handled it — no sideEffects, no remapping):
 * { path: '/__tarballs__/abc/lib/stream.js', namespace: 'virtual-filesystem' }
 *
 * // After (PackagePlugin enriches it):
 * { path: '/__tarballs__/abc/lib/stream-browser.js',   // ← remapped
 *   namespace: 'virtual-filesystem',
 *   sideEffects: false }                                // ← computed
 * ```
 */
export function PackagePlugin<T>(StateContext: Context<LocalState<T>>): ESBUILD.Plugin {
  const { config: LocalConfig, effectiveResolveOpts, sideEffectsMatchersCache } =
    createPluginContext(StateContext);

  return {
    name: PACKAGE_NAMESPACE,
    setup(build) {
      const resolveExtensions = (
        build.initialOptions.resolveExtensions?.slice()
        ?? RESOLVE_EXTENSIONS.slice()
      );

      // Shared state used by both onResolve and onLoad handlers.
      const FileSystem = fromContext('filesystem', StateContext);
      const Assets = fromContext('assets', StateContext) ?? [];
      const enableSourceMaps = !!build.initialOptions.sourcemap;

      // ================================================================
      // VFS namespace: enrich imports within tarball packages
      //
      // Activates when pluginData.packageRoot exists (set by
      // TarballPlugin during entry resolution). Handles:
      //   • Relative imports (./foo, ../bar)
      //   • Absolute paths from build.resolve() delegation
      //
      // Uses resolveVfsPath for file probing, then layers on
      // manifest field remapping + sideEffects computation.
      // ================================================================
      build.onResolve(
        { filter: /^[.\/]/, namespace: VIRTUAL_FILESYSTEM_NAMESPACE },
        async (args): Promise<ESBUILD.OnResolveResult | undefined> => {
          const packageRoot: string | undefined = args.pluginData?.packageRoot;
          const manifest: Partial<PackageJson | FullPackageVersion> | undefined =
            args.pluginData?.manifest;

          // No package context → let VFSPlugin handle it.
          if (!packageRoot || !manifest) return;

          const conditions = getResolverConditions(args, effectiveResolveOpts);

          // Resolve the candidate path (same logic VFS would use).
          // For absolute VFS paths (entry delegation via build.resolve),
          // resolve() returns them unchanged.
          const baseDir = args.resolveDir && args.resolveDir.length > 0
            ? args.resolveDir
            : '/';
          const candidate = resolve(baseDir, args.path);

          // Only enrich imports that land within this package.
          // If the relative import escapes the package root (e.g. ../../),
          // fall through to VFS for normal resolution.
          if (!candidate.startsWith(packageRoot + '/') && candidate !== packageRoot) return;

          // Compute package-relative path for remapping lookup.
          const relativePath = toPackageRelative(candidate, packageRoot);
          if (!relativePath) return;

          // ── Manifest field remappings ─────────────────────────
          const { path: remappedRelPath, excluded, matchedField } =
            applyManifestRemappings(relativePath, manifest, conditions);

          if (excluded) {
            return buildExclusionResult(
              relativePath, matchedField, manifest, LocalConfig,
              args.pluginData ?? {}, args.path,
            );
          }

          // If remapped, compute the new absolute VFS path.
          let finalCandidate = candidate;
          if (remappedRelPath !== relativePath) {
            finalCandidate = resolve(packageRoot, remappedRelPath.replace(/^\.\//, ''));
          }

          // Probe VFS for the actual file (extension probing, index fallback).
          const resolved = await resolveVfsPath(
            FileSystem!, finalCandidate, resolveExtensions, true,
          );

          // File not found in VFS → fall through to VFSPlugin (it may
          // resolve differently, or produce a clean "not found" error).
          if (!resolved) return;

          // ── sideEffects computation ───────────────────────────
          const resolvedRelative = toPackageRelative(resolved, packageRoot) ?? relativePath;
          const packageId = packageIdFrom(manifest);
          const sideEffects = computeEsbuildSideEffects(
            manifest,
            // computeEsbuildSideEffects expects a path with leading "/"
            '/' + resolvedRelative.replace(/^\.\//, ''),
            { matcherCache: sideEffectsMatchersCache, packageId },
          );

          return {
            path: resolved,
            namespace: VIRTUAL_FILESYSTEM_NAMESPACE,
            sideEffects,
            pluginData: Object.assign({}, args.pluginData, {
              importer: args.path,
            }),
          };
        },
      );

      // ================================================================
      // HTTP namespace: enrich imports within CDN packages
      //
      // Activates when pluginData.packageBaseUrl exists (set by
      // CdnPlugin during entry resolution). Handles:
      //   • Full HTTP URLs from build.resolve() delegation
      //   • Relative imports (./foo, ../foo)
      //   • Absolute paths (/lib/foo)
      //
      // Resolves the URL, then layers on manifest field remapping
      // + sideEffects computation.
      // ================================================================
      build.onResolve(
        { filter: /^(https?:\/\/|[.\/])/, namespace: HTTP_NAMESPACE },
        (args): ESBUILD.OnResolveResult | undefined => {
          const packageBaseUrl: string | undefined = args.pluginData?.packageBaseUrl;
          const manifest: Partial<PackageJson | FullPackageVersion> | undefined =
            args.pluginData?.manifest;

          // No package context → let HttpPlugin handle it.
          if (!packageBaseUrl || !manifest) return;

          const conditions = getResolverConditions(args, effectiveResolveOpts);

          // Determine the resolved URL based on import shape:
          //   1. Full HTTP URL (entry delegation from CdnPlugin via build.resolve)
          //   2. Absolute path (/lib/foo) → resolve against parent URL origin
          //   3. Relative path (./foo, ../foo) → resolve against parent URL
          let resolvedUrl: string;
          if (/^https?:\/\//.test(args.path)) {
            // Full URL — use directly (entry delegation or cross-package link).
            resolvedUrl = args.path;
          } else if (isAbsolute(args.path)) {
            const parentUrl = new URL(args.pluginData?.url ?? packageBaseUrl);
            parentUrl.pathname = args.path;
            resolvedUrl = parentUrl.toString();
          } else {
            resolvedUrl = urlJoin(args.pluginData?.url ?? packageBaseUrl, '../', args.path);
          }

          // Only apply enrichment when the URL is within this package.
          if (!resolvedUrl.startsWith(packageBaseUrl)) return;

          // ── Normalize to package-relative path ────────────────
          const relativePath = toPackageRelative(resolvedUrl, packageBaseUrl);
          if (!relativePath) return;

          // ── Manifest field remappings ─────────────────────────
          const { path: remappedRelPath, excluded, matchedField } =
            applyManifestRemappings(relativePath, manifest, conditions);

          if (excluded) {
            return buildExclusionResult(
              relativePath, matchedField, manifest, LocalConfig,
              args.pluginData ?? {}, args.path,
            );
          }

          // If remapped, reconstruct the URL.
          let finalUrl = resolvedUrl;
          if (remappedRelPath !== relativePath) {
            finalUrl = packageBaseUrl + remappedRelPath.replace(/^\.\//, '');
          }

          // ── sideEffects computation ───────────────────────────
          const packageId = packageIdFrom(manifest);
          const effectiveRelPath = remappedRelPath || relativePath;
          const sideEffects = computeEsbuildSideEffects(
            manifest,
            '/' + effectiveRelPath.replace(/^\.\//, ''),
            { matcherCache: sideEffectsMatchersCache, packageId },
          );

          return {
            path: finalUrl,
            namespace: HTTP_NAMESPACE,
            sideEffects,
            pluginData: args.pluginData,
          };
        },
      );

      // ================================================================
      // VFS namespace: load and preprocess ALL virtual-filesystem content
      //
      // This is the sole content loader for the VFS namespace. Both
      // tarball-extracted package files and user-authored entry points
      // flow through here.
      //
      // Preprocessing:
      //   • Flow type stripping (React Native / Expo packages ship
      //     raw Flow annotations that esbuild can't parse)
      //   • Loader inference (file extension → esbuild loader)
      //
      // The resolveDir is set to the file's directory so that relative
      // imports within VFS work correctly with esbuild's resolution.
      // ================================================================
      build.onLoad(
        { filter: /.*/, namespace: VIRTUAL_FILESYSTEM_NAMESPACE },
        async (args) => {
          // args.path is canonical (set by onResolve).
          const content = await getFile(FileSystem!, args.path, "buffer");

          // `getFile` returns null when missing/invalid; empty files are OK.
          if (content === null) return;

          const { contents: processedContent, wasStripped } = maybeStripFlow(
            content as Uint8Array,
            { url: args.path, sourceMap: enableSourceMaps },
          );

          if (wasStripped) {
            dispatchEvent(LOGGER_INFO, `Stripped Flow types from ${args.path}`);
          }

          return {
            contents: processedContent,
            loader: inferLoader(args.path, undefined, content),
            resolveDir: dirname(args.path),
            pluginData: Object.assign({}, args.pluginData, {
              importer: args.path,
            }),
          };
        },
      );

      // ================================================================
      // HTTP namespace: load and preprocess ALL HTTP-fetched content
      //
      // This is the sole content loader for the HTTP namespace. Both
      // CDN package files and direct URL imports flow through here.
      //
      // Pipeline:
      //   1. Extension probing + content fetch (via determineExtension)
      //   2. Store in VFS for bundle analyzer / install-size reporting
      //   3. Asset discovery (WASM, Workers via `new URL(...)`)
      //   4. Flow type stripping
      //   5. Loader inference
      //
      // CRITICAL: The final URL (after redirects) is passed in
      // pluginData.url so that relative imports resolve correctly.
      // ================================================================
      build.onLoad(
        { filter: /.*/, namespace: HTTP_NAMESPACE },
        async (args) => {
          // Probe for correct extension and fetch content.
          const { url, content, contentType } = await determineExtension(args.path, {
            headersOnly: false,
            StateContext,
          });

          if (!content) return;

          // Store in virtual filesystem for bundle analyzer.
          if (FileSystem) {
            const filePath = toURLPath(url);
            await setFile(FileSystem, filePath, content);
          }

          // Discover and fetch assets (WASM, Workers, etc.)
          const assetResults = await fetchAssets(
            url, content as Uint8Array<ArrayBuffer>, StateContext,
          );

          const resolvedAssets = assetResults
            .filter((result): result is PromiseFulfilledResult<ESBUILD.OutputFile> => {
              if (result.status === "rejected") {
                dispatchEvent(LOGGER_WARN, `Asset fetch failed for '${url}':\n${result.reason}`);
                return false;
              }
              return true;
            })
            .map(result => result.value);

          toContext("assets", Assets.concat(resolvedAssets), StateContext);

          // Strip Flow type annotations from files that use Flow syntax.
          const { contents: processedContent, wasStripped } = maybeStripFlow(
            content as Uint8Array,
            { url, sourceMap: enableSourceMaps },
          );

          if (wasStripped) {
            dispatchEvent(LOGGER_INFO, `Stripped Flow types from ${url}`);
          }

          return {
            contents: processedContent,
            loader: inferLoader(url, contentType, content),
            // CRITICAL: Pass the final URL (after redirects) in pluginData.
            // This is used as the base for resolving relative imports.
            pluginData: Object.assign({}, args.pluginData, { url }),
          };
        },
      );
    },
  };
}
