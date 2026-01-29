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
import type { SideEffectsMatchers } from "../utils/side-effects.ts";
import type { record } from "../context/context.ts";

import { Context, fromContext, withContext } from "../context/context.ts";

import { resolve, legacy } from "@bundle/utils/resolve-exports-imports";
import { parsePackageName } from "@bundle/utils/parse-package-name";
import { getPackageOfVersion, getRegistryURL, resolveVersion } from "@bundle/utils/npm-search";

import {
  parseNpmDependencySpec,
  isUrlSpec,
  isAliasSpec,
  isUnsupportedSpec,
  joinSubpath,
  appendUrlSubpath,
  getUnsupportedSpecError,
} from "@bundle/utils/npm-spec";
import { computeEsbuildSideEffects } from "../utils/side-effects.ts";

import { extname, isBareImport, join } from "@bundle/utils/path";
import { fetchWithCache } from "@bundle/utils/fetch-and-cache";
import { deepMerge } from "@bundle/utils/deep-object";

import { determineExtension, HTTP_NAMESPACE } from "./http.ts";
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

  const cdn = fromContext("origin", StateContext)! ?? DEFAULT_CDN_HOST;
  const build = fromContext("build", StateContext)!;

  const failedManifestUrls = fromContext("failedManifestUrls", StateContext) ?? new Set<string>();
  const packageManifestsMap = fromContext("packageManifests", StateContext) ?? new Map<string, PackageJson | FullPackageVersion>();

  const sideEffectsMatchersCache =
    fromContext("sideEffectsMatchersCache", StateContext) ??
    new Map<string, SideEffectsMatchers>();

  return async function (args: ESBUILD.OnResolveArgs): Promise<ESBUILD.OnResolveResult | undefined> {
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
    // ========================================================================

    if (/^#/.test(argPath)) {
      try {
        // Resolving imports & exports from the package.json
        // If an import starts with "#" then it's a subpath-import, and should be treated as so
        const modernResolve = resolve(initialManifest, argPath, {
          browser: conditions.browser,
          conditions: conditions.conditions,
          require: conditions.require
        }) || 
          // Compatibility fallback: if we're in ESM-import context but the package only
          // defined require-branches, try require once (keeps existing "try hard" behavior).
          (!conditions.require
            ? resolve(initialManifest, argPath, {
                browser: conditions.browser,
                conditions: ["require", ...conditions.conditions],
                require: true
              })
            : undefined);

        if (modernResolve) {
          const resolvedPath = Array.isArray(modernResolve) ? modernResolve[0] : modernResolve;
          argPath = join(initialManifest.name + "@" + initialManifest.version, resolvedPath);
        }
        // deno-lint-ignore no-empty
      } catch (_) { }
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
      // Support a different default CDN + allow for custom CDN url schemes
      const { path: _argPath, origin } = getCDNUrl(argPath, cdn);

      // npm standard CDNs, e.g. unpkg, skypack, esm.sh, etc...
      const NPM_CDN = getCDNStyle(origin) === "npm";

      // Heavily based off of https://github.com/egoist/play-esbuild/blob/main/src/lib/esbuild.ts
      const parsed = parsePackageName(_argPath, { defaultVersion: null });
      const parsedSubpath = parsed.path;

      // If the version of package isn't determinable from the path argument,
      // check the inherited manifest for a potential version
      let assumedVersion = parsed.version || "latest";
      if (!parsed.version) {
        if (parsed.name in initialDeps)
          assumedVersion = initialDeps[parsed.name];
      }

      // ======================================================================
      // Parse dependency spec to handle URLs, aliases, git, etc.
      // ======================================================================

      const spec = assumedVersion ? parseNpmDependencySpec(assumedVersion) : null;

      // Apply npm alias rewrite: "npm:react@^18" -> name=react, version=^18
      let effectiveName = parsed.name;
      let effectiveAssumedVersion = assumedVersion;
      let effectiveExtraSubpath = "";

      if (spec && isAliasSpec(spec)) {
        effectiveName = spec.target.name;
        effectiveAssumedVersion = spec.target.version;
        effectiveExtraSubpath = spec.target.path;
      }

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
          const peerDeps = Object.assign({},
            initialManifest?.peerDependencies,
            resolvedManifest?.peerDependencies,
            { [effectiveName]: effectiveAssumedVersion}
          );

          const inheritPeerDependencies = structuredClone(peerDeps);
          for (const [name, version] of Object.entries(peerDeps)) {
            inheritPeerDependencies[name] = initialDeps[name] ?? version;
          }

          Object.assign(resolvedPluginData, {
            manifest: deepMerge(
              structuredClone(resolvedManifest),
              { peerDependencies: inheritPeerDependencies }
            )
          })
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
      // Continue with normal CDN resolution for semver/tag specs
      // ======================================================================

      let resolvedManifest = structuredClone(initialManifest);
      let resultSubpath = parsedSubpath;

      // If the CDN supports package.json and some other npm stuff, it counts as an npm CDN
      if (NPM_CDN) {
        // For npm aliases, we need to resolve the aliased package name
        const nameToResolve = effectiveName;
        const versionToResolve = effectiveAssumedVersion;

        try {
          const identifiedVersion = await resolveVersion(`${nameToResolve}@${versionToResolve}`)
          if (identifiedVersion) effectiveAssumedVersion = identifiedVersion;
        } catch (e) {
          dispatchEvent(LOGGER_WARN, `Couldn't identify the correct npm version based on the semver (${versionToResolve}) for package (${nameToResolve}). Be cautious this is an unusual situation, the bundle may silently break in odd ways.`);
          dispatchEvent(LOGGER_WARN, e);
        }

        try {
          const ext = extname(parsedSubpath);
          const isDirectory = ext.length === 0;
          const subpath = isDirectory ? parsedSubpath : "";
          let isSubpathDirectoryPackage = false;

          // If the subpath is a directory check to see if that subpath has a `package.json`,
          // after which check if the parent directory has a `package.json`
          const manifestVariants = [
            { path: getRegistryURL(`${effectiveName}@${effectiveAssumedVersion}`).packageVersionURL },
            // { path: `${effectiveName}@${effectiveAssumedVersion}/package.json` },
            isDirectory ? {
              path: `${effectiveName}@${effectiveAssumedVersion}${parsedSubpath}/package.json`,
              isDirectory: true
            } : null
          ].filter(x => x !== null);

          const manifestVariantsLen = manifestVariants.length;
          for (let i = 0; i < manifestVariantsLen; i++) {
            const { path, isDirectory } = manifestVariants[i]!;
            const { url } = getCDNUrl(path, origin);

            // If the url was fetched before and failed, skip it and try the next one
            if (failedManifestUrls?.has?.(url.href) && i < manifestVariantsLen - 1)
              continue;

            try {
              // Strongly cache package.json files
              const { response: res } = await fetchWithCache(url.href, { cacheMode: "reload" });
              if (!res.ok) throw new Error(await res.text());

              resolvedManifest = await res.json();
              isSubpathDirectoryPackage = isDirectory ?? false;

              // If the package.json is not a sub-directory package, then we should cache it as such
              if (!isDirectory) {
                packageManifestsMap.set(
                  `${effectiveName}@${resolvedManifest?.version || effectiveAssumedVersion}`,
                  resolvedManifest
                );
              }
              break;
            } catch (e) {
              failedManifestUrls?.add?.(url.href);

              // If after checking all the different file extensions none of them are valid
              // Throw the last fetch error encountered, as that is generally the most accurate error
              if (i >= manifestVariantsLen - 1) throw e;
            }
          }

          // Combine any extra subpath from alias with the parsed subpath
          const combinedSubpath = joinSubpath(
            effectiveExtraSubpath,
            parsedSubpath
          );
          const relativePath = combinedSubpath.replace(/^\//, "./");

          let modernResolve: ReturnType<typeof resolve> | null = null;
          let legacyResolve: ReturnType<typeof legacy> | null = null;
          let resolvedPath: string | null = combinedSubpath;

          try {
            // Resolving imports & exports from the package.json
            // If an import starts with "#" then it's a subpath-import, and should be treated as so
            modernResolve = resolve(resolvedManifest, relativePath || ".", {
              browser: conditions.browser,
              conditions: conditions.conditions,
              require: conditions.require,
              unsafe: true
            }) ||
              // Same compat fallback as above
              (!conditions.require
                ? resolve(resolvedManifest, relativePath, {
                  browser: conditions.browser,
                  conditions: ["require", ...conditions.conditions],
                  require: true
                })
                : undefined
              );

            if (modernResolve) {
              resolvedPath = Array.isArray(modernResolve) ? modernResolve[0] : modernResolve;
            }
            // deno-lint-ignore no-empty
          } catch (_) { }

          if (!modernResolve) {
            // If the subpath has a package.json, and the modern resolve didn't work for it
            // we can safely use legacy resolve,
            // else, if the subpath doesn't have a package.json, then the subpath is literal,
            // and we should just use the subpath as it is
            const emptyRelativePath = relativePath.trim().length === 0
            if (isSubpathDirectoryPackage || emptyRelativePath) {
              try {
                const legacyFields = getLegacyMainFields(resolvedManifest, args, effectiveResolveOpts);
                
                // Resolving using main, module, etc... from package.json
                legacyResolve = legacy(resolvedManifest, {
                  browser: conditions.browser,
                  fields: legacyFields
                });

                if (legacyResolve) {
                  // Some packages have `browser` fields in their package.json which have some values set to false
                  // e.g. typescript -> https://unpkg.com/browse/typescript@4.9.5/package.json
                  if (typeof legacyResolve === "object") {
                    const values = Object.values(legacyResolve);
                    const validValues = values.filter(x => x);
                    if (validValues.length <= 0)
                      legacyResolve = legacy(resolvedManifest);
                  }

                  if (Array.isArray(legacyResolve)) {
                    resolvedPath = legacyResolve[0];
                  } else if (typeof legacyResolve === "object") {
                    const allKeys = Object.keys(legacyResolve);
                    const nonCJSKeys = allKeys.filter(key => {
                      return (
                        !/\.cjs$/.exec(key) &&
                        !/src\//.exec(key) &&
                        (legacyResolve as record<string | false>)[key]!
                      );
                    });

                    const keysToUse = nonCJSKeys.length > 0 ? nonCJSKeys : allKeys;
                    resolvedPath = legacyResolve[keysToUse[0]] as string;
                  } else {
                    resolvedPath = legacyResolve;
                  }
                }
                // deno-lint-ignore no-empty
              } catch (_) { }
            } else resolvedPath = relativePath;
          }

          if (resolvedPath && typeof resolvedPath === "string") {
            resultSubpath = resolvedPath.replace(/^(\.\/)/, "/");
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
      const knownVersion = resolvedManifest?.version || effectiveAssumedVersion;
      const cdnVersionFormat = NPM_CDN ? "@" + knownVersion : "";
      const { url } = getCDNUrl(`${effectiveName}${cdnVersionFormat}${resultSubpath}`, origin);

      const packageId = `${effectiveName}@${knownVersion}`;

      // Store the package.json manifest of the dependencies fetched in the cache
      if (!packageManifestsMap.get(packageId)) {
        try {
          const _manifest = await getPackageOfVersion(packageId);
          if (_manifest)
            packageManifestsMap.set(packageId, _manifest);
        } catch (e) {
          console.warn(e);
        }
      }

      const peerDeps = Object.assign(
        initialManifest?.peerDependencies ?? {},
        resolvedManifest?.peerDependencies ?? {},
        {
          // Some packages rely on cyclic dependencies, e.g. https://x.com/jsbundle/status/1792325771354149261
          // so we create a new field in peerDependencies and place the current package and it's version,
          // the algorithm should then be able to use the correct version if a dependency is cyclic
          [effectiveName]: NPM_CDN ? knownVersion : (initialDeps[effectiveName] ?? "latest")
        }
      );
      const inheritPeerDependencies = structuredClone(peerDeps);

      // Force inherit peerDependencies, makes it easier to keep versions stable 
      // and to avoid duplicates
      for (const [name, version] of Object.entries(peerDeps)) {
        inheritPeerDependencies[name] = initialDeps[name] ?? version;
      }

      const computedSideEffects = computeEsbuildSideEffects(
        resolvedManifest,
        resultSubpath, // IMPORTANT: package-relative path (e.g. "/dist/index.js")
        {
          matcherCache: sideEffectsMatchersCache,
          packageId,
        }
      );

      const pathWithExt = await determineExtension(url.toString());
      return {
        namespace: HTTP_NAMESPACE,
        path: pathWithExt.url,
        sideEffects: computedSideEffects,
        pluginData: Object.assign({}, args.pluginData, {
          manifest: deepMerge(
            structuredClone(resolvedManifest),
            { peerDependencies: inheritPeerDependencies }
          )
        })
      };
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