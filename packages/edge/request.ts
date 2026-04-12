import type { PackageJson } from "@bundle/utils/types";
import type { BundleKeyObject, BundleModule, Config, PreparedBundleRequest } from "./types.ts";

import JSON5 from "./vendor/json5.ts";

import { createCompressConfig } from "@bundle/compress";
import { deepMerge, parsePackageName, resolveVersion } from "@bundle/utils";
import { BUILD_CONFIG } from "@bundle/core";

import { inputModelResetValue, PACKAGE_RESULT_PREFIX } from "./constants.ts";
import { parseConfig, parseShareURLQuery, parseTreeshakeExports } from "./parse-query.ts";

export function convertQueryValue(str?: string | null) {
	if (str === "false") return false;
	if (str === "true") return true;
	return str;
}

export async function hashString(str: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(str);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));

	return hashArray.map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function getPackageResultKey(str: string) {
	return `${PACKAGE_RESULT_PREFIX}/${str}`;
}

export async function prepareBundleRequest(url: URL): Promise<PreparedBundleRequest> {
	const initialValue = parseShareURLQuery(url) || inputModelResetValue;
	const { init: _init, entryPoints: _entryPoints, ansi: _ansi, ...initialConfig } = (parseConfig(url) || {}) as Config;

	const configQuery = url.searchParams.get("config");
	const treeshakeQuery = url.searchParams.has("treeshake");
	const treeshake = url.searchParams.get("treeshake");
	const treeshakeArr = parseTreeshakeExports(
		decodeURIComponent(treeshake ?? "")
			.trim()
			.replace(/\s{2,}/, " ")
	).map(value => value.trim());

	const uniqueTreeshakeArr = Array.from(new Set(treeshakeArr));
	const exportAll = !treeshakeQuery || uniqueTreeshakeArr.every(value => /\*|{\s?default\s?}/.test(value));

	const metafileQuery = url.searchParams.has("metafile") || url.pathname === "/metafile";
	const analysisQuery = url.searchParams.has("analysis") ||
		url.searchParams.has("analyze") ||
		["/analysis", "/analyze"].includes(url.pathname);

	const badgeQuery = url.searchParams.has("badge") || ["/badge", "/badge/raster", "/badge-raster"].includes(url.pathname);
	const polyfill = url.searchParams.has("polyfill");
	const prettyQuery = url.searchParams.has("pretty");
	const minifyQuery = url.searchParams.has("minify");
	const sourcemapQuery = url.searchParams.has("sourcemap");
	const tsxQuery = url.searchParams.has("tsx") || url.searchParams.has("jsx");
	const enableMetafile = analysisQuery || metafileQuery || Boolean(initialConfig?.analysis);

	const prettyResult = url.searchParams.get("pretty");
	const minifyResult = url.searchParams.get("minify");
	const minify = initialConfig?.esbuild?.minify ?? (
		minifyQuery
			? (minifyResult?.length === 0 ? true : convertQueryValue(minifyResult))
			: (prettyQuery ? (prettyResult?.length === 0 ? !prettyQuery : !convertQueryValue(prettyResult)) : null) ??
				initialConfig?.esbuild?.minify
	);

	const sourcemapResult = url.searchParams.get("sourcemap");
	const sourcemap = initialConfig?.esbuild?.sourcemap ?? (
		sourcemapQuery
			? convertQueryValue(sourcemapResult)
			: initialConfig?.esbuild?.sourcemap
	);

	const formatQuery = url.searchParams.has("format");
	const format = initialConfig?.esbuild?.format || url.searchParams.get("format");

	const earlyConfig = Object.assign(deepMerge(
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
	}) as Config;

	const hasQuery = url.searchParams.has("q") || url.searchParams.has("query");
	const shareQuery = url.searchParams.get("share");
	const textQuery = url.searchParams.get("text");
	const query = (url.searchParams.get("q") || url.searchParams.get("query")) ?? "spring-easing";
	const mutationQueries = Boolean(
		shareQuery || textQuery || minifyQuery || prettyQuery || polyfill || tsxQuery ||
		formatQuery || configQuery || badgeQuery || sourcemapQuery || analysisQuery || metafileQuery
	);

	const rootPkg = (earlyConfig["package.json"] ?? {}) as PackageJson;
	const dependencies = Object.assign({}, rootPkg.devDependencies, rootPkg.peerDependencies, rootPkg.dependencies);

	const versionsList = await Promise.allSettled(
		!hasQuery && (shareQuery || textQuery)
			? []
			: query
				.split(",")
				.map(value => [
					value.replace(/^\((\w+)\)/, ""),
					/^\((\w+)\)/.exec(value)?.[1] ?? "export"
				] as const)
				.filter(([pkgName]) => !/^https?\:\/\//.exec(pkgName))
				.map(async ([pkgName, imported]) => {
					const { name = pkgName, version, path } = parsePackageName(pkgName, { ignoreError: true });
					return [
						name,
						await resolveVersion(dependencies[name] ? `${name}@${dependencies[name]}` : pkgName) ?? version,
						path,
						imported
					] as const;
				})
	);

	const versions: string[] = [];
	const modules: BundleModule[] = [];

	for (const version of versionsList) {
		if (version.status === "fulfilled" && version.value) {
			const [name, resolvedVersion, path, imported] = version.value;
			versions.push(`${name}@${resolvedVersion}`);
			modules.push([`${name}@${resolvedVersion}${path}`, imported ?? "export"]);
		}
	}

	const { init = {}, ...configWithoutInit } = earlyConfig;
	const jsonKeyObject = Object.assign({}, configWithoutInit, {
		init,
		versions,
		modules,
		initialValue: initialValue.trim()
	}) as BundleKeyObject;

	const jsonKey = `json/${JSON5.stringify(jsonKeyObject).trim()}`;
	const badgeResult = url.searchParams.get("badge");
	const badgeStyle = url.searchParams.get("badge-style");
	const badgeRasterQuery =
		url.searchParams.has("badge-raster") ||
		url.searchParams.has("png") ||
		["/badge/raster", "/badge-raster"].includes(url.pathname);

	const badgeKey = `badge/${jsonKey}`;
	const badgeID = JSON5.stringify(Object.assign({}, jsonKeyObject, {
		badge: {
			raster: badgeRasterQuery,
			result: badgeResult,
			style: badgeStyle
		}
	})).trim();

	return {
		bundleKey: await hashString(jsonKey),
		query,
		initialValue,
		initialConfig,
		earlyConfig,
		versions,
		modules,
		jsonKeyObject,
		jsonKey,
		badgeKey,
		badgeID,
		exportAll,
		mutationQueries,
		shareQuery,
		textQuery,
		useTsxEntrypoint: Boolean(tsxQuery || initialConfig.tsx)
	};
}