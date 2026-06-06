import type { PackageJson } from "@bundle/utils/types";

import { createCompressConfig } from "@bundle/compress";
import { dispatchEvent, BUILD_CONFIG, LOGGER_INFO } from "@bundle/core";
import { getCDNStyle, getPureImportPath } from "@bundle/core/utils/cdn-format";
import {
  deepMerge,
  looksLikeJSRSpec,
  parseJSRSpec,
  parsePackageName,
  resolveJSRVersion,
  resolveVersion
} from "@bundle/utils";
import { getRegistryForPackage, normalizeRegistryConfig } from "@bundle/utils/npmrc";

import JSON5 from "../utils/json5.ts";

import { inputModelResetValue } from "./bundle.ts";
import { parseConfig, parseShareURLQuery, parseTreeshakeExports } from "./parse-query.ts";
import type { Config } from "./types.ts";
import { sha256Hex } from "./hash.ts";

/**
 * A normalized, runtime-agnostic representation of a bundle request.
 *
 * Why this exists:
 * - We want **Deno Deploy** (`edge/mod.ts`) and **Cloudflare Workers**
 *   (`cloudflare/src/index.ts`) to share the same request parsing rules.
 * - Most importantly, we want a stable `jsonKey` / `badgeKey` derivation so
 *   caching behaves the same across runtimes.
 */
export interface PreparedBundleRequest {
  /**
   * A stable cache key for the JSON response.
   *
   * This is intentionally derived from a normalized object (`jsonKeyObj`)
   * stringified via JSON5 so equivalent inputs produce identical cache keys.
   */
  jsonKey: string;

  /**
   * The normalized object that is stringified into `jsonKey`.
   *
   * This is useful for execution (we later inject the wasm module and
   * generate a stable entrypoint file name).
   */
  jsonKeyObj: Record<string, unknown>;

  /**
   * A per-request identifier used for artifact storage / work coordination.
   *
   * In Workers we use this to name the R2 bundle artifact. In Deno Deploy we
   * currently don't need an artifact key, but keeping it here keeps parity.
   */
  bundleKey: string;

  /**
   * The Redis/KV key for the badge "hash" for this bundle.
   *
   * Deno stores multiple badge variants under this key keyed by `badgeID`.
   * Workers mimic that shape so we can delete all variants at once.
   */
  badgeKey: string;

  /**
   * The field/key within `badgeKey` representing the exact badge variant.
   *
   * This includes badge options (style/result/raster) so different badge
   * outputs don't overwrite each other.
   */
  badgeID: string;

  /**
   * The raw input model/source used as the basis of bundling.
   *
   * This is either decoded from `?share`, pulled from `?text`, or falls back
   * to the interactive default model reset value.
   */
  initialValue: string;

  /**
   * A list of resolved module specifiers with versions pinned.
   * Each entry also stores whether it should be imported or exported.
   */
  modules: [string, "import" | "export" | (string & {})][];

  /**
   * The list of `name@version` strings used for display/debugging.
   *
   * This exists separately from `modules` because `modules` includes subpaths.
   */
  versions: string[];

  /** Whether the request is effectively exporting everything (no tree-shake). */
  exportAll: boolean;

  /**
   * Whether any query parameter is present that mutates the output.
   *
   * This is used to decide if we can store a "permanent" package cache entry
   * for simple single-module export requests.
   */
  mutationQueries: boolean;

  /** The original `q/query` string (defaults to "spring-easing"). */
  query: string;

  /** `?share` value if present (compressed input model). */
  shareQuery: string | null;

  /** `?text` value if present (inline input model). */
  textQuery: string | null;

  /** True when we should generate a `.tsx` entrypoint (JSX/TSX enabled). */
  tsx: boolean;
}

function convertQueryValue(str?: string | null) {
  // The API historically allows boolean flags to be expressed as strings.
  // We keep this behavior for parity with the existing Deno Deploy handler.
  if (str === "false") return false;
  if (str === "true") return true;
  return str;
}

/**
 * Prepare/normalize a bundle request.
 *
 * This function is intentionally side-effect free (aside from lightweight
 * logging) and does not touch runtime-specific APIs (Deno, KV, R2, Redis).
 *
 * The output of this function forms the basis of cache keys used by both
 * runtimes; changes here can cause cache misses or cross-runtime drift, so keep
 * it stable unless we're intentionally versioning the cache.
 */
export async function prepareBundleRequest(url: URL): Promise<PreparedBundleRequest> {
  const initialValue = parseShareURLQuery(url) || inputModelResetValue;
  const { init: _init, entryPoints: _entryPoints, ansi: _ansi, ...initialConfig } = (parseConfig(url) || {}) as Config;

  const configQuery = url.searchParams.get("config");

  const treeshakeQuery = url.searchParams.has("treeshake");
  const treeshake = url.searchParams.get("treeshake");
  const treeshakeArr = parseTreeshakeExports(
    decodeURIComponent(treeshake ?? "")
      .trim()
      // Replace multiple 2 or more spaces with just a single space
      .replace(/\s{2,}/, " ")
  ).map((item) => item.trim());

  const uniqueTreeshakeArr = Array.from(new Set(treeshakeArr));
  // This treeshake pattern is what's required export all modules
  const exportAll = !treeshakeQuery || uniqueTreeshakeArr.every((item) => /\*|{\s?default\s?}/.test(item));

  const metafileQuery = url.searchParams.has("metafile") || url.pathname === "/metafile";
  const analysisQuery = url.searchParams.has("analysis") ||
    url.searchParams.has("analyze") ||
    ["/analysis", "/analyze"].includes(url.pathname);

  const badgeQuery = url.searchParams.has("badge") || ["/badge", "/badge/raster", "/badge-raster"].includes(url.pathname);
  const polyfill = url.searchParams.has("polyfill");

  const prettyQuery = url.searchParams.has("pretty");
  const minifyQuery = url.searchParams.has("minify");
  const sourcemapQuery = url.searchParams.has("sourcemap");

  const tsxQuery =
    url.searchParams.has("tsx") ||
    url.searchParams.has("jsx");

  const enableMetafile = analysisQuery ||
    metafileQuery ||
    Boolean(initialConfig?.analysis);

  const prettyResult = url.searchParams.get("pretty");
  const minifyResult = url.searchParams.get("minify");
  const minify = initialConfig?.esbuild?.minify ?? (
    minifyQuery
      ? (minifyResult?.length === 0 ? true : convertQueryValue(minifyResult))
      : (prettyQuery
        ? (prettyResult?.length === 0 ? !prettyQuery : !convertQueryValue(prettyResult))
        : null) ??
        initialConfig?.esbuild?.minify
  );

  const sourcemapResult = url.searchParams.get("sourcemap");
  const sourcemap = initialConfig?.esbuild?.sourcemap ?? (
    sourcemapQuery
      ? (convertQueryValue(sourcemapResult))
      : initialConfig?.esbuild?.sourcemap
  );

  const cdnQuery = url.searchParams.has("cdn");
  const cdnResult = url.searchParams.get("cdn")?.trim();
  const cdn = cdnResult?.length ? cdnResult : null;

  const registryQuery = url.searchParams.has("registry");
  const registryResult = url.searchParams.get("registry")?.trim();
  const registry = registryResult?.length ? registryResult : null;

  const formatQuery = url.searchParams.has("format");
  const format = initialConfig?.esbuild?.format || url.searchParams.get("format");

  const earlyConfigObj: Config = Object.assign(deepMerge(
    deepMerge(
      deepMerge(
        Object.assign({}, BUILD_CONFIG),
        {
          polyfill,
          compression: createCompressConfig(initialConfig.compression)
        }
      ),
      initialConfig
    ),
    {
      ...(cdn ? { cdn } : {}),
      ...(registry ? { registry } : {}),
      esbuild: Object.assign(
        {},
        enableMetafile ? { metafile: enableMetafile } : {},
        minifyQuery || prettyQuery ? { minify } : {},
        sourcemapQuery ? { sourcemap } : {},
        formatQuery ? { format } : {}
      ),
      init: {
        platform: "deno-wasm",
        worker: false
      }
    } as Config
  ), {
    entryPoints: [`/index${tsxQuery || initialConfig.tsx ? ".tsx" : ".ts"}`]
  });

  const hasQuery = (
    url.searchParams.has("q") ||
    url.searchParams.has("query")
  );
  const shareQuery = url.searchParams.get("share");
  const textQuery = url.searchParams.get("text");
  const query = (
    (
      url.searchParams.get("q") ||
      url.searchParams.get("query")
    ) ?? "spring-easing"
  );

  // All the queries that will affect the final result
  const mutationQueries = Boolean(
    shareQuery || textQuery || minifyQuery || prettyQuery || polyfill || tsxQuery ||
    formatQuery || cdnQuery || registryQuery || configQuery || badgeQuery || sourcemapQuery || analysisQuery || metafileQuery
  );

  const rootPkg = earlyConfigObj["package.json"] ?? {} as PackageJson;
  const dependecies = Object.assign({}, rootPkg.devDependencies, rootPkg.peerDependencies, rootPkg.dependencies);
  const registryConfig = normalizeRegistryConfig(earlyConfigObj.registry);

  const versionsList = await Promise.allSettled(
    !hasQuery && (shareQuery || textQuery) ? [] :
      query
        .split(",")
        .map((item) => [
          item.replace(/^\((\w+)\)/, ""),
          /^\((\w+)\)/.exec(item)?.[1] ?? "export"
        ] as const)
        .filter(([pkgName]) => !/^https?\:\/\//.exec(pkgName))
        .map(async ([pkgName, imported]) => {
          // Avoid routing protocol specifiers through the npm resolver.
          // - jsr:* uses the JSR registry
          // - npm-CDN protocols (esm:, unpkg:, etc.) are treated as npm packages
          // - anything else (node:, deno:, github:, etc.) is ignored for version tracking
          const isJsrRegistryAlias = pkgName.startsWith("jsr.registry:");

          if (looksLikeJSRSpec(pkgName) || isJsrRegistryAlias) {
            const jsrInput = isJsrRegistryAlias
              ? `jsr:${pkgName.slice("jsr.registry:".length)}`
              : pkgName;

            const jsrSpec = parseJSRSpec(jsrInput);
            if (!jsrSpec) return null;

            const resolved = await resolveJSRVersion({
              scope: jsrSpec.scope,
              name: jsrSpec.name,
              version: jsrSpec.version
            });

            const fallback = jsrSpec.version && !/^latest$/i.test(jsrSpec.version)
              ? jsrSpec.version
              : null;
            const ver = resolved ?? fallback;
            if (!ver) return null;
            const name = `jsr:${jsrSpec.fullName}`;
            const path = jsrSpec.subpath;
            return [name, ver, path, imported] as const;
          }

          const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(pkgName);
          const scheme = schemeMatch?.[1] ?? null;
          const hasScheme = Boolean(scheme);

          // If this is an explicit protocol/scheme, only treat known npm-ish
          // schemes as versionable. Everything else is ignored to avoid noisy
          // npm registry lookups.
          if (hasScheme) {
            const style = getCDNStyle(pkgName);
            if (style !== "npm" && style !== "registry") return null;
          }

          const normalizedPkgName = hasScheme ? getPureImportPath(pkgName) : pkgName;
          if (/^[a-z][a-z0-9+.-]*:/i.test(normalizedPkgName)) return null;

          const { name = normalizedPkgName, version, path } = parsePackageName(normalizedPkgName, { ignoreError: true });

          const registryForPkg = getRegistryForPackage(name, registryConfig);
          const resolved = await resolveVersion(
            dependecies[name] ? `${name}@${dependecies[name]}` : normalizedPkgName,
            registryForPkg
          ) ?? version;

          if (!resolved) return null;

          const finalName = hasScheme ? `${scheme}:${name}` : name;
          return [finalName, resolved, path, imported] as const;
        })
  );

  const versions: string[] = [];
  const modules: [string, "import" | "export" | (string & {})][] = [];
  for (const version of versionsList) {
    if (version.status === "fulfilled" && version.value) {
      const [name, ver, path, imported] = version.value;
      versions.push(`${name}@${ver}`);
      modules.push([`${name}@${ver}${path}`, imported ?? "export"]);
    }
  }

  // Non-critical observability: helps correlate request inputs when debugging.
  dispatchEvent(LOGGER_INFO, {
    query,
    modules,
    exportAll,
    shareQuery,
    textQuery
  });

  const { init = {}, ..._configObj } = earlyConfigObj;
  const jsonKeyObj = Object.assign({}, _configObj, {
    init,
    versions,
    modules,
    initialValue: initialValue.trim()
  });
  const jsonKey = `json/${JSON5.stringify(jsonKeyObj).trim()}`;

  const badgeResult = url.searchParams.get("badge");
  const badgeStyle = url.searchParams.get("badge-style");

  const badgeRasterQuery =
    url.searchParams.has("badge-raster") ||
    url.searchParams.has("png") ||
    ["/badge/raster", "/badge-raster"].includes(url.pathname);

  const badgeKey = `badge/${jsonKey}`;
  const badgeIDObj = Object.assign({}, jsonKeyObj, {
    badge: {
      raster: badgeRasterQuery,
      result: badgeResult,
      style: badgeStyle
    }
  });
  const badgeID = JSON5.stringify(badgeIDObj).trim();

  const tsx = Boolean(tsxQuery || (initialConfig as Config).tsx);
  const bundleKey = await sha256Hex(jsonKey);

  return {
    badgeID,
    badgeKey,
    bundleKey,
    exportAll,
    initialValue,
    jsonKey,
    jsonKeyObj,
    modules,
    mutationQueries,
    query,
    shareQuery,
    textQuery,
    tsx,
    versions
  };
}
