/**
 * CDN Plugin for esbuild
 *
 * Resolves bare imports to CDN URLs using various resolution strategies:
 * - Modern exports/imports resolution from package.json
 * - Legacy main/module/browser field resolution
 * - npm alias unwrapping (npm:package@version)
 * - JSR specifiers (jsr:@scope/name@version)
 * - URL-based version routing (https://pkg.pr.new/...)
 *
 * @module
 *
 * @example Standard bare import
 * ```ts
 * // In user code:
 * import { useState } from "react";
 *
 * // Resolved to:
 * // https://unpkg.com/react@18.2.0/index.js
 * ```
 *
 * @example JSR import
 * ```ts
 * // In user code:
 * import { join } from "jsr:@std/path@^1.0.0";
 *
 * // Resolved directly to JSR registry:
 * // https://jsr.io/@std/path/1.0.8/mod.ts
 * ```
 *
 * @example npm alias in package.json
 * ```json
 * {
 *   "dependencies": {
 *     "rq": "npm:@tanstack/react-query@^5"
 *   }
 * }
 * ```
 * ```ts
 * // In user code:
 * import { useQuery } from "rq";
 *
 * // Plugin unwraps alias, resolves to:
 * // https://unpkg.com/@tanstack/react-query@5.0.0/build/modern/index.js
 * ```
 *
 * @example URL version in package.json (PR preview builds)
 * ```json
 * {
 *   "dependencies": {
 *     "@tanstack/react-query": "https://pkg.pr.new/@tanstack/react-query@7988"
 *   }
 * }
 * ```
 * ```ts
 * // In user code:
 * import { useQuery } from "@tanstack/react-query";
 *
 * // Plugin routes to TarballPlugin via build.resolve()
 * // TarballPlugin extracts tarball to VFS
 * // Returns: vfs:/pkg.pr.new/@tanstack/react-query@7988/build/modern/index.js
 * ```
 */
import type { PackageJson, FullPackageVersion } from "@bundle/utils/types";
import type { LocalState, ESBUILD } from "@bundle/core/types";

import { Context, fromContext, withContext } from "../context/context.ts";

import { parsePackageName } from "@bundle/utils/parse-package-name";
import { getPackageOfVersion, getPackageTarballUrl, getRegistryURL, resolveVersion } from "@bundle/utils/npm-search";
import { normalizeRegistryConfig, getRegistryForPackage } from "@bundle/utils/npmrc";

import {
  isUrlSpec,
  isAliasSpec,
  isUnsupportedSpec,
  joinSubpath,
  appendUrlSubpath,
  getUnsupportedSpecError,
  parseNpmSpec,
} from "@bundle/utils/npm-spec";

import { extname, isBareImport, join } from "@bundle/utils/path";
import { fetchWithCache } from "@bundle/utils/fetch-and-cache";
import { deepMerge } from "@bundle/utils/deep-object";

import { determineExtension, HTTP_NAMESPACE } from "./http.ts";
import { EXCLUDED_MODULE_NAMESPACE } from "./external.ts";
import { dispatchEvent, LOGGER_WARN } from "../configs/events.ts";

import { getCDNUrl, getCDNStyle, DEFAULT_CDN_HOST } from "../utils/cdn-format.ts";
import { getLegacyMainFields, getResolverConditions } from "@bundle/utils/resolve-conditions";

// JSR (jsr.io) support
import {
  parseJSRSpec,
  looksLikeJSRSpec,
  getJSRModuleUrl,
  resolveJSRVersion,
  getJSRVersionMeta,
  jsrToEsmSh,
} from "../../utils/jsr-spec.ts";
import { computePeerDependencies, normalizeResolvedPath, resolveModern, resolvePackageEntry } from "../utils/cdn-resolution.ts";

/** CDN Plugin Namespace */
export const CDN_NAMESPACE = "cdn-url";

export interface CdnResolutionState<T> extends LocalState<T> {
  origin: string;
  build: ESBUILD.PluginBuild
}

/**
 * Resolution algorithm for the esbuild CDN plugin
 *
 * Handles the full resolution flow:
 * 1. Check for subpath imports (#internal/...)
 * 2. Parse bare imports and look up version from manifest
 * 3. Parse dependency spec to classify version format
 * 4. Route based on spec type:
 *    - URL specs → build.resolve() (TarballPlugin handles)
 *    - Alias specs → unwrap and continue resolution
 *    - Unsupported specs → return error
 *    - Semver/tag specs → normal CDN resolution
 *
 * @param StateContext Context containing origin, config, caches
 * @param build esbuild PluginBuild for calling build.resolve() on URL specs
 */
export function CdnResolution<T>(StateContext: Context<CdnResolutionState<T>>) {
  const LocalConfig = fromContext("config", StateContext)!;
  const manifest: Partial<PackageJson | FullPackageVersion> = LocalConfig["package.json"] ?? {};

  const esbuildOpts = LocalConfig.esbuild ?? {};
  const resolveOpts = LocalConfig.resolve ?? {};

  const effectiveResolveOpts = Object.assign({}, resolveOpts, esbuildOpts);

  // The configured CDN origin. Can be overridden per-resolve by
  // pluginData.cdnOrigin (set by HttpPlugin for CDN-follows-parent).
  const configuredCdn = fromContext("origin", StateContext)! ?? DEFAULT_CDN_HOST;
  const build = fromContext("build", StateContext)!;

  const failedManifestUrls = fromContext("failedManifestUrls", StateContext) ?? new Set<string>();
  const packageManifestsMap = fromContext("packageManifests", StateContext)
    ?? new Map<string, PackageJson | FullPackageVersion>();

  // ── Registry configuration (for scoped registries / .npmrc support) ────
  // Normalize the registry config once at plugin init time.
  // This enables routing different scopes to different registries, e.g.:
  //   @jsr → https://npm.jsr.io
  //   @mycompany → https://npm.mycompany.com
  const registryConfig = normalizeRegistryConfig(LocalConfig.registry);

  return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
    // CDN-follows-parent: when bare imports originate from within an HTTP
    // namespace file, HttpPlugin passes the parent's CDN origin so that
    // transitive deps resolve through the same CDN. This overrides the
    // configured CDN for this specific resolve call.
    const cdn = args.pluginData?.cdnOrigin ?? configuredCdn;

    const conditions = getResolverConditions(args, effectiveResolveOpts);
    let argPath = args.path;

    // ========================================================================
    // Build initial manifest from config + inherited pluginData
    // ========================================================================

    // Conceptually package.json = manifest, but for naming reasons we'll just call it manifest
    const _inheritedManifest = args.pluginData?.manifest ?? {};

    // Object.assign & deepMerge essentially do the same thing for flat objects, 
    // except there are some instances where Object.assign is faster
    const initialManifest: PackageJson | FullPackageVersion = deepMerge(
      structuredClone(manifest),

      // If we've manually set the version of the dependency in the config, 
      // then force all occurances of that dependency to use the version specified in the config
      Object.assign(
        structuredClone(_inheritedManifest),
        manifest.devDependencies ? { devDependencies: manifest.devDependencies } : null,
        manifest.peerDependencies ? { peerDependencies: manifest.peerDependencies } : null,
        manifest.dependencies ? { dependencies: manifest.dependencies } : null,
      )
    );

    const initialDeps = Object.assign(
      {},
      initialManifest.devDependencies,
      initialManifest.peerDependencies,
      initialManifest.dependencies,
    );

    // ========================================================================
    // Handle subpath imports (#internal/...)
    // https://nodejs.org/api/packages.html#subpath-imports
    //
    // IMPORTANT: Private imports MUST be resolved against the IMPORTER's manifest,
    // not the root manifest. The vfile package imports #minpath, so we need
    // vfile's package.json (passed via pluginData.manifest), not the entry point's.
    // ========================================================================

    if (/^#/.test(argPath)) {
      // Use importer's manifest if available, fall back to initial manifest
      const importerManifest: Partial<PackageJson | FullPackageVersion> = 
        args.pluginData?.manifest ?? initialManifest;
      
      const manifestName = importerManifest.name ?? initialManifest.name ?? "unknown";
      const manifestVersion = importerManifest.version ?? initialManifest.version ?? "latest";
      
      // Try to resolve the subpath import
      const result = resolveModern(importerManifest, argPath, conditions);
      
      if (result.success && result.path) {
        argPath = join(`${manifestName}@${manifestVersion}`, result.path);
      } else if (!result.success && !conditions.require) {
        // Compatibility fallback: try require conditions
        const fallback = resolveModern(importerManifest, argPath, {
          ...conditions,
          require: true,
          conditions: ["require", ...conditions.conditions],
        });

        if (fallback.success && fallback.path) {
          argPath = join(initialManifest.name + "@" + initialManifest.version, fallback.path);
        } else {
          // CRITICAL: Private import resolution failed
          // Return error immediately - do NOT fall through to bare import handling
          // as this would incorrectly try to resolve #minpath as an npm package
          return {
            errors: [{
              text: `Failed to resolve private import "${argPath}"`,
              detail: `The package "${manifestName}" does not define this import in its "imports" field, or the import conditions [${conditions.conditions.join(", ")}] don't match. This is a Node.js subpath import that must be defined in package.json.`,
            }],
          };
        }
      }
    }

    // ========================================================================
    // Handle JSR specifiers (jsr:@scope/name@version/subpath)
    // ========================================================================

    if (looksLikeJSRSpec(argPath)) {
      const jsrSpec = parseJSRSpec(argPath);

      if (jsrSpec) {
        try {
          // Resolve version range to exact version if needed
          let resolvedVersion = jsrSpec.version;
          if (!resolvedVersion || resolvedVersion.includes("^") || resolvedVersion.includes("~") || resolvedVersion === "latest") {
            resolvedVersion = await resolveJSRVersion({
              scope: jsrSpec.scope,
              name: jsrSpec.name,
              version: jsrSpec.version,
            });
          }

          if (!resolvedVersion) {
            return {
              errors: [{
                text: `Failed to resolve JSR version: ${argPath}`,
                detail: `Could not find a version matching "${jsrSpec.version || "latest"}" for @${jsrSpec.scope}/${jsrSpec.name}`,
              }],
            };
          }

          // Get version metadata to resolve exports
          let resolvedSubpath = jsrSpec.subpath || "/mod.ts";

          try {
            const versionMeta = await getJSRVersionMeta(jsrSpec.scope, jsrSpec.name, resolvedVersion);

            // If subpath provided, try to resolve through exports
            if (jsrSpec.subpath && versionMeta.exports) {
              // Normalize subpath for exports lookup (./foo or .)
              const exportsKey = jsrSpec.subpath === "/" ? "." : `.${jsrSpec.subpath}`;
              const altKey = jsrSpec.subpath.replace(/^\//, "./");

              if (versionMeta.exports[exportsKey]) {
                resolvedSubpath = versionMeta.exports[exportsKey];
              } else if (versionMeta.exports[altKey]) {
                resolvedSubpath = versionMeta.exports[altKey];
              }
              // If no match, use the subpath directly
            } else if (!jsrSpec.subpath && versionMeta.exports?.["."]) {
              // Default export
              resolvedSubpath = versionMeta.exports["."];
            }
          } catch {
            // If we can't get version meta, fall back to subpath or default
          }

          // Generate direct JSR module URL
          const moduleUrl = getJSRModuleUrl(
            jsrSpec.scope,
            jsrSpec.name,
            resolvedVersion,
            resolvedSubpath
          );

          // Resolve through HTTP plugin
          const pathWithExt = await determineExtension(moduleUrl);

          return {
            namespace: HTTP_NAMESPACE,
            path: pathWithExt.url,
            pluginData: Object.assign({}, args.pluginData, {
              manifest: {
                name: jsrSpec.fullName,
                version: resolvedVersion,
                // JSR packages can have their own dependencies we might need to track
                peerDependencies: initialManifest?.peerDependencies ?? {},
              },
            }),
          };
        } catch (e) {
          // If direct JSR resolution fails, fall back to esm.sh proxy
          dispatchEvent(LOGGER_WARN, `JSR direct resolution failed for ${argPath}, falling back to esm.sh proxy`);
          dispatchEvent(LOGGER_WARN, e);

          const esmShUrl = jsrToEsmSh(jsrSpec);
          const pathWithExt = await determineExtension(esmShUrl);

          return {
            namespace: HTTP_NAMESPACE,
            path: pathWithExt.url,
            pluginData: args.pluginData,
          };
        }
      }
    }

    // ========================================================================
    // Handle bare imports (react, @scope/pkg, lodash/get)
    // ========================================================================

    if (isBareImport(argPath)) {
      // ── Registry tarball propagation ─────────────────────────────────
      // When a bare import originates from within a registry-extracted
      // tarball (the source URL is stored in pluginData.tarballUrl by the
      // TarballPlugin), propagate registry mode to transitive deps.
      //
      // Without this, importing from a registry tarball URL like
      //   https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz
      // would correctly extract that top-level package, but its bare-import
      // dependencies ("react", "expo-asset", etc.) would fall back to the
      // default CDN (unpkg.com) instead of also resolving through the
      // registry. pluginData flows through the VFS → onLoad → onResolve
      // chain, so this propagation is self-sustaining across the entire
      // transitive dependency tree.
      let effectiveCdn = cdn;
      let propagatedRegistry: string | undefined;
      const _tarballUrl = args.pluginData?.tarballUrl;
      if (
        _tarballUrl &&
        typeof _tarballUrl === "string" &&
        /^https?:\/\//.test(_tarballUrl)
      ) {
        try {
          const tarballOrigin = new URL(_tarballUrl).origin;
          if (getCDNStyle(tarballOrigin) === "registry") {
            effectiveCdn = tarballOrigin;
            propagatedRegistry = tarballOrigin;
          }
        } catch {
          // Malformed URL — ignore, keep current cdn
        }
      }

      // Support a different default CDN + allow for custom CDN url schemes
      const { path: _argPath, origin } = getCDNUrl(argPath, effectiveCdn);

      // npm standard CDNs, e.g. unpkg, skypack, esm.sh, etc...
      const NPM_CDN = getCDNStyle(origin) === "npm";

      // npm registry tarball mode — fetch whole-package tarballs directly
      // from registry.npmjs.org instead of individual files from a CDN.
      const REGISTRY_CDN = getCDNStyle(origin) === "registry";

      // Heavily based off of https://github.com/egoist/play-esbuild/blob/main/src/lib/esbuild.ts
      const parsed = parsePackageName(_argPath, { defaultVersion: null });
      const parsedSubpath = parsed.path;

      // If the version of package isn't determinable from the path argument,
      // check the inherited manifest for a potential version
      let assumedVersion = parsed.version || "latest";
      if (!parsed.version && parsed.name in initialDeps) {
        assumedVersion = initialDeps[parsed.name];
      }

      // ======================================================================
      // Parse dependency spec to handle URLs, aliases, git, etc.
      // ======================================================================

      const spec = assumedVersion ? parseNpmSpec(assumedVersion) : null;

      // Apply npm alias rewrite: "npm:react@^18" -> name=react, version=^18
      let effectiveName = parsed.name;
      let effectiveAssumedVersion = assumedVersion;
      let effectiveExtraSubpath = "";

      if (spec && isAliasSpec(spec)) {
        effectiveName = spec.target.name;
        effectiveAssumedVersion = spec.target.version;
        effectiveExtraSubpath = spec.target.path;
      }

      // Resolve the appropriate registry for this package's scope, e.g.:
      //   @jsr/std__path  → https://npm.jsr.io   (if configured via .npmrc)
      //   react           → https://registry.npmjs.org   (default)
      // When propagating registry mode from a parent tarball, use that
      // tarball's origin as the fallback so API calls (version resolution,
      // manifest fetch) go through the same registry.
      const registry = getRegistryForPackage(effectiveName, registryConfig, propagatedRegistry);

      // ======================================================================
      // URL-based dependencies - route through build.resolve()
      // This allows TarballPlugin or HttpPlugin to handle them
      // ======================================================================

      if (spec && isUrlSpec(spec) && build) {
        const fullSubpath = joinSubpath(effectiveExtraSubpath, parsedSubpath);
        const targetUrl = appendUrlSubpath(spec.url, fullSubpath);

        // Let esbuild's plugin chain handle the URL
        // TarballPlugin will intercept tarball URLs, HttpPlugin handles others
        const resolved = await build.resolve(targetUrl, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: args.pluginData,
        });

        if (resolved.errors?.length) return { errors: resolved.errors };
        if (!resolved.path) {
          return {
            errors: [{
              text: `Failed to resolve URL dependency: ${targetUrl}`,
            }],
          };
        }

        // Preserve pluginData and inject peerDependencies stabilization
        const resolvedPluginData = Object.assign({}, resolved.pluginData);
        const resolvedManifest: PackageJson | null = resolvedPluginData.manifest ?? null;

        // Merge peerDependencies for version stabilization
        if (resolvedManifest && typeof resolvedManifest === "object") {
          const inheritPeerDependencies = computePeerDependencies({
            initialManifest,
            resolvedManifest,
            initialDeps,
            packageName: effectiveName,
            packageVersion: effectiveAssumedVersion,
            isNpmCdn: NPM_CDN,
          });

          Object.assign(resolvedPluginData, {
            manifest: deepMerge(
              structuredClone(resolvedManifest),
              { peerDependencies: inheritPeerDependencies }
            )
          });
        }

        return Object.assign({}, resolved, {
          pluginData: resolvedPluginData,
        });
      }

      // ======================================================================
      // Explicit unsupported spec types (git/file/workspace/link)
      // ======================================================================

      if (spec && isUnsupportedSpec(spec)) {
        return {
          errors: [{
            text: getUnsupportedSpecError(spec, parsed.name),
          }],
        };
      }

      // ======================================================================
      // Registry tarball mode — skip CDN, fetch entire package from npm registry
      //
      // Instead of resolving individual files via a CDN like unpkg or esm.sh,
      // download the whole package tarball from registry.npmjs.org in one shot,
      // extract it to VFS, then resolve entry points from the extracted tree.
      //
      // Why this is useful:
      // - Large packages with many internal imports (lodash-es, @aws-sdk/*)
      //   generate hundreds of individual HTTP fetches in CDN mode. Registry
      //   mode collapses this into a single tarball download + local resolution.
      // - Eliminates CDN-specific redirect/resolution quirks.
      // - Uses the exact same files that `npm install` would produce.
      //
      // The flow:
      // 1. Resolve version from the npm registry (same as CDN mode)
      // 2. Fetch the resolved package manifest to get dist.tarball
      // 3. Construct a tarball URL with any subpath appended
      // 4. Route through build.resolve() → TarballPlugin extracts + resolves
      // ======================================================================

      if (REGISTRY_CDN && build) {
        const nameToResolve = effectiveName;
        const versionToResolve = effectiveAssumedVersion;

        try {
          // Step 1: Resolve version range to exact version
          const identifiedVersion = await resolveVersion(`${nameToResolve}@${versionToResolve}`, registry);
          if (identifiedVersion) effectiveAssumedVersion = identifiedVersion;
        } catch (e) {
          dispatchEvent(LOGGER_WARN, `[registry] Version resolution failed for ${nameToResolve}@${versionToResolve}, falling back to assumed version.`);
          dispatchEvent(LOGGER_WARN, e);
        }

        // Step 2: Try to get manifest for authoritative dist.tarball URL
        let resolvedManifest: PackageJson | FullPackageVersion | null = null;
        const packageId = `${effectiveName}@${effectiveAssumedVersion}`;
        try {
          resolvedManifest = packageManifestsMap.get(packageId) ?? null;
          if (!resolvedManifest) {
            resolvedManifest = await getPackageOfVersion(packageId, registry);
            if (resolvedManifest) {
              packageManifestsMap.set(packageId, resolvedManifest);
            }
          }
        } catch (e) {
          dispatchEvent(LOGGER_WARN, `[registry] Could not fetch manifest for ${packageId}, constructing tarball URL from convention.`);
          dispatchEvent(LOGGER_WARN, e);
        }

        // Step 3: Construct tarball URL with subpath
        const tarballUrl = getPackageTarballUrl(
          resolvedManifest as FullPackageVersion | null,
          effectiveName,
          effectiveAssumedVersion,
          registry,
        );

        const combinedSubpath = joinSubpath(effectiveExtraSubpath, parsedSubpath);
        const targetUrl = combinedSubpath
          ? `${tarballUrl}${combinedSubpath}`
          : tarballUrl;

        // Step 4: Let TarballPlugin handle the download, extraction, and resolution
        const resolved = await build.resolve(targetUrl, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: args.pluginData,
        });

        if (resolved.errors?.length) return { errors: resolved.errors };
        if (!resolved.path) {
          return {
            errors: [{
              text: `[registry] Failed to resolve tarball for ${effectiveName}@${effectiveAssumedVersion}`,
              detail: `Tarball URL: ${targetUrl}`,
            }],
          };
        }

        // Merge pluginData with peerDependencies for version stabilization
        const resolvedPluginData = Object.assign({}, resolved.pluginData);
        const resolvedManifestFromTarball: PackageJson | null = resolvedPluginData.manifest ?? null;

        if (resolvedManifestFromTarball && typeof resolvedManifestFromTarball === "object") {
          // Store the manifest in the cache for install-size reporting
          if (!packageManifestsMap.get(packageId)) {
            packageManifestsMap.set(packageId, resolvedManifestFromTarball);
          }

          const inheritPeerDependencies = computePeerDependencies({
            initialManifest,
            resolvedManifest: resolvedManifestFromTarball,
            initialDeps,
            packageName: effectiveName,
            packageVersion: effectiveAssumedVersion,
            isNpmCdn: true, // registry mode behaves like an npm CDN for peer dep purposes
          });

          Object.assign(resolvedPluginData, {
            manifest: deepMerge(
              structuredClone(resolvedManifestFromTarball),
              { peerDependencies: inheritPeerDependencies }
            )
          });
        }

        return Object.assign({}, resolved, {
          pluginData: resolvedPluginData,
        });
      }

      // ======================================================================
      // Continue with normal CDN resolution for semver/tag specs
      // ======================================================================

      let resolvedManifest = structuredClone(initialManifest);
      let resultSubpath = parsedSubpath;

      // Track whether we successfully fetched the package's own manifest
      // from the CDN. When false, resolvedManifest still holds the parent's
      // version (from initialManifest), so we must prefer
      // effectiveAssumedVersion for the final URL construction.
      let manifestFetched = false;

      // Track whether we navigated into a sub-directory package
      // (e.g., preact/compat has its own package.json)
      let isSubpathDirectoryPackage = false;

      // If the CDN supports package.json and some other npm stuff, it counts as an npm CDN
      if (NPM_CDN) {
        // For npm aliases, we need to resolve the aliased package name
        const nameToResolve = effectiveName;
        const versionToResolve = effectiveAssumedVersion;

        try {
          const identifiedVersion = await resolveVersion(`${nameToResolve}@${versionToResolve}`, registry)
          if (identifiedVersion) effectiveAssumedVersion = identifiedVersion;
        } catch (e) {
          dispatchEvent(LOGGER_WARN, `Couldn't identify the correct npm version based on the semver (${versionToResolve}) for package (${nameToResolve}). Be cautious this is an unusual situation, the bundle may silently break in odd ways.`);
          dispatchEvent(LOGGER_WARN, e);
        }

        try {
          const ext = extname(parsedSubpath);
          const isDirectory = ext.length === 0;
          const subpath = isDirectory ? parsedSubpath : "";

          // If the subpath is a directory check to see if that subpath has a `package.json`,
          // after which check if the parent directory has a `package.json`
          //
          // NOTE: We fetch the version-specific manifest from the registry API
          // (e.g. registry.npmjs.org/pkgname/1.0.0) only for unscoped packages.
          // For scoped packages, the registry's version endpoint uses `%2f`
          // encoding (@scope%2fname/version) which breaks on some HTTP infra
          // that decodes `%2f` before routing. Instead, for scoped packages
          // we use the CDN-native path to fetch package.json directly.
          const useRegistryEndpoint = !effectiveName.includes("/");
          const registryManifestURL = useRegistryEndpoint
            ? getRegistryURL(`${effectiveName}@${effectiveAssumedVersion}`, registry).packageVersionURL
            : null;
          const manifestVariants = [
            useRegistryEndpoint && registryManifestURL
              // Registry endpoint: use the full URL directly (not via getCDNUrl)
              // because registry.npmjs.org URLs have a different format
              // (package/version) than CDN URLs (package@version)
              ? { path: registryManifestURL, isRegistryURL: true }
              : { path: `${effectiveName}@${effectiveAssumedVersion}/package.json` },
            // { path: `${effectiveName}@${effectiveAssumedVersion}/package.json` },
            isDirectory ? {
              path: `${effectiveName}@${effectiveAssumedVersion}${parsedSubpath}/package.json`,
              isDirectory: true
            } : null
          ].filter(x => x !== null);

          const manifestVariantsLen = manifestVariants.length;
          for (let i = 0; i < manifestVariantsLen; i++) {
            const variant = manifestVariants[i]!;
            // For registry URLs, use the URL directly; for CDN paths, construct via getCDNUrl
            const fetchUrl = (variant as { isRegistryURL?: boolean }).isRegistryURL
              ? variant.path
              : getCDNUrl(variant.path, origin).url.href;

            // If the url was fetched before and failed, skip it and try the next one
            if (failedManifestUrls?.has?.(fetchUrl) && i < manifestVariantsLen - 1)
              continue;

            try {
              // Strongly cache package.json files
              const { response: res } = await fetchWithCache(fetchUrl, { cacheMode: "reload" });
              if (!res.ok) throw new Error(await res.text());

              resolvedManifest = await res.json();
              manifestFetched = true;
              isSubpathDirectoryPackage = (variant as { isDirectory?: boolean }).isDirectory ?? false;

              // If the package.json is not a sub-directory package, then we should cache it as such
              if (!isDirectory) {
                packageManifestsMap.set(
                  `${effectiveName}@${resolvedManifest?.version || effectiveAssumedVersion}`,
                  resolvedManifest
                );
              }
              break;
            } catch (e) {
              failedManifestUrls?.add?.(fetchUrl);

              // If after checking all the different file extensions none of them are valid
              // Throw the last fetch error encountered, as that is generally the most accurate error
              if (i >= manifestVariantsLen - 1) throw e;
            }
          }

          // Combine any extra subpath from alias with the parsed subpath
          const combinedSubpath = joinSubpath(effectiveExtraSubpath, parsedSubpath);
          const legacyFields = getLegacyMainFields(resolvedManifest, args, effectiveResolveOpts);

          // ================================================================
          // NEW: Use resolvePackageEntry for combined resolution
          // This is the key integration point!
          //
          // When we resolved a sub-directory package.json (e.g., preact/compat/package.json),
          // the manifest is for the SUB-PACKAGE. We should resolve against its root ("")
          // not the original subpath, because the subpath is prepended later.
          // ================================================================

          const entrySubpath = isSubpathDirectoryPackage ? "" : combinedSubpath;

          const resolutionResult = resolvePackageEntry({
            manifest: resolvedManifest,
            subpath: entrySubpath,
            conditions,
            legacyFields,
            allowLiteralSubpath: !isSubpathDirectoryPackage && combinedSubpath.trim().length > 0,
          });

          if (resolutionResult.excluded && conditions.browser) {
            // Generate accurate message based on exclusion reason
            const reason = (resolutionResult as { exclusionReason?: string }).exclusionReason;
            
            let text: string;
            let detail: string;
            
            if (reason === "field-remapping" || reason === "browser" || reason === "browser-remapping") {
              text = `Package "${effectiveName}" is excluded for the current environment`;
              detail = "A path remapping field (browser, react-native, or electron) explicitly excludes this module.";
            } else if (reason === "no-entry-point") {
              text = `Could not find entry point for package "${effectiveName}"`;
              detail = `The package.json does not define 'main', 'module', 'exports', or other entry point fields. Subpath: "${combinedSubpath || "."}".`;
            } else {
              text = `Package resolution failed for "${effectiveName}"`;
              detail = resolutionResult.error?.message ?? "Unknown resolution error";
            }

            // ── Respect remapFalse.packageRemapFalse config ──
            // Default is "error". When set to "stub", produce an empty export
            // instead of a hard build error.
            const packagePolicy = LocalConfig.remapFalse?.packageRemapFalse ?? "error";

            if (packagePolicy === "stub") {
              const warnOnStub = LocalConfig.remapFalse?.warnOnStubbedRemapFalse ?? true;
              return {
                path: `${effectiveName}/${combinedSubpath || "."}`,
                namespace: EXCLUDED_MODULE_NAMESPACE,
                pluginData: Object.assign({}, args.pluginData, {
                  excludedBy: reason ?? "field-remapping",
                  originalPath: combinedSubpath || ".",
                  suppressWarning: !warnOnStub,
                }),
              };
            }

            return {
              errors: [{ text, detail }],
            };
          }

          // If we're not building for browser, don't treat this as a hard exclusion.
          // Prefer to continue and let normal "no entry point" errors surface if needed.
          // (With the resolveLegacy + resolvePackageEntry fixes, this path should rarely trigger.)
          if (resolutionResult.error) {
            dispatchEvent(LOGGER_WARN, `Resolution error for ${effectiveName}: ${resolutionResult.error.message}`);
          }

          if (resolutionResult.path) {
            resultSubpath = normalizeResolvedPath(resolutionResult.path);
          }

          if (subpath && isSubpathDirectoryPackage) {
            resultSubpath = `${subpath}${resultSubpath}`;
          }
        } catch (e) {
          dispatchEvent(LOGGER_WARN, `You may want to change CDNs. The current CDN ${!/unpkg\.com/.test(origin) ? `"${origin}" doesn't` : `path "${origin}${_argPath}" may not`} support package.json files.\nThere is a chance the CDN you're using doesn't support looking through the package.json of packages. Bundlejs will switch to inaccurate guesses for package versions. For package.json support you may wish to use https://unpkg.com or other CDN's that support package.json.`);
          dispatchEvent(LOGGER_WARN, e);
        }
      }

      // If the CDN is npm based then it should add the parsed version to the URL
      // e.g. https://unpkg.com/spring-easing@v1.0.0/
      //
      // When we successfully fetched this package's own manifest, its
      // `version` field is authoritative. Otherwise resolvedManifest is
      // still a clone of the *parent's* manifest, whose version would be
      // wrong (e.g. jsonfile getting fs-extra's "11.2.0").  In that case
      // fall back to effectiveAssumedVersion which was resolved from the
      // npm registry and is correct.
      //
      // When a sub-directory package.json was used (e.g., preact/compat/package.json),
      // its `version` field is an internal version (e.g., "4.0.0") that doesn't match
      // the root package version. Always use effectiveAssumedVersion for sub-packages.
      const knownVersion = isSubpathDirectoryPackage
        ? effectiveAssumedVersion
        : (manifestFetched
          ? (resolvedManifest?.version || effectiveAssumedVersion)
          : effectiveAssumedVersion);
      const cdnVersionFormat = NPM_CDN ? "@" + knownVersion : "";
      const { url } = getCDNUrl(`${effectiveName}${cdnVersionFormat}${resultSubpath}`, origin);

      // Compute the package root URL so downstream plugins (HttpPlugin) can derive
      // package-relative paths and apply browser field remappings correctly.
      // e.g. "https://unpkg.com/@exodus/bytes@1.13.0/"
      const { url: packageBaseUrl } = getCDNUrl(`${effectiveName}${cdnVersionFormat}/`, origin);

      // Store the package.json manifest of the dependencies fetched in the cache
      const packageId = `${effectiveName}@${knownVersion}`;
      if (!packageManifestsMap.get(packageId)) {
        try {
          const _manifest = await getPackageOfVersion(packageId, registry);
          if (_manifest) packageManifestsMap.set(packageId, _manifest);
        } catch (e) {
          dispatchEvent(LOGGER_WARN, "Could not store the package.json manifests of the dependencies we fetched.");
          dispatchEvent(LOGGER_WARN, e);
        }
      }

      // NEW: Use computePeerDependencies utility
      const inheritPeerDependencies = computePeerDependencies({
        initialManifest,
        resolvedManifest,
        initialDeps,
        packageName: effectiveName,
        packageVersion: knownVersion,
        isNpmCdn: NPM_CDN,
      });

      // Probe for the correct file extension on the CDN.
      const pathWithExt = await determineExtension(url.toString());

      // Delegate to PackagePlugin for sideEffects enrichment.
      // build.resolve() re-enters the plugin chain with HTTP namespace
      // so PackagePlugin's HTTP handler can compute sideEffects and
      // apply any additional manifest field remappings.
      const resolved = await build.resolve(pathWithExt.url, {
        namespace: HTTP_NAMESPACE,
        kind: args.kind,
        pluginData: Object.assign({}, args.pluginData, {
          manifest: deepMerge(
            structuredClone(resolvedManifest),
            { peerDependencies: inheritPeerDependencies }
          ),
          packageBaseUrl: packageBaseUrl.href,
        }),
      });

      if (resolved.errors?.length) return { errors: resolved.errors };

      return resolved;
    }
  };
};

/**
 * Esbuild CDN plugin
 *
 * Resolves bare imports to CDN URLs with support for:
 * - Standard semver/tag versions (^1.2.3, latest)
 * - npm aliases (npm:package@version)
 * - URL-based versions (routed to TarballPlugin via build.resolve)
 * - Modern exports/imports field resolution
 * - Legacy main/module/browser field resolution
 *
 * @param StateContext Context with origin configuration
 *
 * @example Plugin registration
 * ```ts
 * const plugins = [
 *   AliasPlugin(StateContext),
 *   ExternalPlugin(StateContext),
 *   TarballPlugin(StateContext),  // Must be before CDN for URL routing
 *   VirtualFileSystemPlugin(StateContext),
 *   HttpPlugin(StateContext),
 *   CdnPlugin(StateContext),      // Handles bare imports
 * ];
 * ```
 */
export function CdnPlugin<T>(StateContext: Context<LocalState<T> & { origin: string }>): ESBUILD.Plugin {
  return {
    name: CDN_NAMESPACE,
    setup(build) {
      const ctx = withContext({ build: Context.opaque(build) }, StateContext);

      // Resolve bare imports to the CDN required using different URL schemes
      // Pass `build` to enable URL-based version routing through TarballPlugin
      build.onResolve({ filter: /.*/ }, CdnResolution(ctx));
      build.onResolve({ filter: /.*/, namespace: CDN_NAMESPACE }, CdnResolution(ctx));
    },
  };
};