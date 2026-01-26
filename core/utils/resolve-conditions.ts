// core/utils/resolve-conditions.ts
import type { PackageJson } from "@bundle/utils/types";
import type { ESBUILD } from "../types.ts";

/**
 * A minimal view of esbuild options that matter for package.json conditional resolution.
 */
export interface ResolverConditionInputs {
	platform?: ESBUILD.BuildOptions["platform"];
	conditions?: ESBUILD.BuildOptions["conditions"];
	format?: ESBUILD.BuildOptions["format"];

	/**
	 * Optional: used by legacy (main/module/browser field) fallback.
	 * If omitted, we emulate esbuild's defaults per-platform.
	 */
	mainFields?: ESBUILD.BuildOptions["mainFields"];
}

/**
 * The computed condition set we pass into resolve-exports-imports.
 */
export interface ResolverConditions {
	/**
	 * Whether to respect the `browser` field and browser mappings.
	 *
	 * In esbuild, the browser field is interpreted when platform === "browser".
	 * It is not part of platform === "neutral" behavior. 
	 */
	browser: boolean;

	/**
	 * Whether we are resolving for a CommonJS "require" context.
	 */
	require: boolean;

	/**
	 * Ordered, de-duped list of conditions to test against package.json "exports"/"imports".
	 * Includes "default" explicitly for downstream resolvers that want it.
	 *
	 * Notes:
	 * - `default` is always active in esbuild and is intended as a fallback. 
	 * - `import` vs `require` is context-dependent (import statement/import() vs require()). 
	 * - `browser` and `node` are platform-gated. 
	 * - `module` is auto-included only for platform browser|node when no custom conditions exist. 
	 */
	conditions: string[];
}

/**
 * True when an esbuild resolve kind behaves like CommonJS `require(...)`.
 */
export function isRequireKind(kind: ESBUILD.ImportKind): boolean {
	return kind === "require-call" || kind === "require-resolve";
}

/**
 * Determine whether this resolve is conceptually a CommonJS "require" edge.
 *
 * Entry points are special: args.kind === "entry-point" doesn't tell you whether the
 * entry module originated as ESM or CJS, so format is the best available signal.
 */
export function isRequireContext(
	args: Pick<ESBUILD.OnResolveArgs, "kind">,
	esbuildOpts: Pick<ResolverConditionInputs, "format">,
): boolean {
	if (isRequireKind(args.kind)) return true;
	if (args.kind === "entry-point") return esbuildOpts.format === "cjs";
	return false;
}

/**
 * Custom conditions can be any strings, but esbuild has special behavior for:
 * default/import/require/browser/node (cannot be disabled, and some are platform-gated). 
 *
 * We treat these as *not* true "custom conditions" to avoid accidentally deviating from esbuild.
 * We deliberately allow "module" to be user-specified because esbuild allows you to add it back
 * by configuring conditions (even an empty list disables the auto-inclusion). 
 */
export function normalizeCustomConditions(
	conditions: readonly string[] | undefined,
): string[] {
	if (!conditions || conditions.length <= 0) return [];

	const out: string[] = [];
	for (const raw of conditions) {
		const c = raw.trim();
		if (!c) continue;

		// Do not let user "force" platform-gated built-ins.
		if (
			c === "default" ||
			c === "import" ||
			c === "require" ||
			c === "browser" ||
			c === "node"
		) continue;

		out.push(c);
	}

	return dedupePreserveOrder(out);
}

/**
 * A minimal view of esbuild options that matter for package.json conditional resolution.
 */
export interface ResolverConditionInputs {
	platform?: ESBUILD.BuildOptions["platform"];
	conditions?: ESBUILD.BuildOptions["conditions"];
	format?: ESBUILD.BuildOptions["format"];
}

/**
 * Compute the effective condition set to match esbuild’s documented behavior. 
 */
export function getResolverConditions(
	args: Pick<ESBUILD.OnResolveArgs, "kind">,
	esbuildOpts: ResolverConditionInputs,
): ResolverConditions {
	const platform = esbuildOpts.platform ?? "browser";

	// Entry points can be CommonJS even though `args.kind` is "entry-point".
	const require =
		isRequireKind(args.kind) ||
		(args.kind === "entry-point" && esbuildOpts.format === "cjs");

	// Legacy `browser` field mapping: only automatic on platform="browser". 
	const browserField = platform === "browser";

	// Esbuild only auto-adds "module" when:
	// - platform is "browser" or "node"
	// - AND the user did not configure `conditions` at all (undefined)
	const userProvidedConditions = typeof esbuildOpts.conditions !== "undefined";
	const mayAutoAddModule = !userProvidedConditions &&
		(platform === "browser" || platform === "node");

	const computed: string[] = [];

	// Built-in import-vs-require dimension. 
	computed.push(require ? "require" : "import");

	// Platform dimension: neutral adds neither. 
	if (platform === "browser") computed.push("browser");
	if (platform === "node") computed.push("node");

	// Bundler-only "module" (only in browser/node by default). 
	if (mayAutoAddModule) computed.push("module");

	// Then append any explicit custom conditions the caller provided.
	if (esbuildOpts.conditions?.length) {
		for (const c of esbuildOpts.conditions) computed.push(c);
	}

	// "default" is always active in esbuild. 
	computed.push("default");

	return {
		browser: browserField,
		require,
		conditions: dedupePreserveOrder(computed),
	};
}


export function getLegacyMainFields(
	manifest: Pick<PackageJson, "browser" | "main" | "module">,
	args: Pick<ESBUILD.OnResolveArgs, "kind">,
	esbuildOpts: Pick<ResolverConditionInputs, "platform" | "format" | "mainFields">,
): string[] {
	// If the user set mainFields, that replaces defaults (and disables special behavior). 
	if (esbuildOpts.mainFields) return Array.from(esbuildOpts.mainFields);

	const platform = esbuildOpts.platform ?? "browser";
	const require = isRequireContext(args, esbuildOpts);

	if (platform === "node") {
		// esbuild default: main,module 
		return ["main", "module"];
	}

	if (platform === "browser") {
		// esbuild default: browser,module,main with an extra require() compatibility tweak: 
		// If there's no browser *entry point* and it's a require() edge, prefer main over module.
		const hasBrowserEntrypoint = typeof (manifest as { browser?: unknown }).browser === "string";
		if (require && !hasBrowserEntrypoint) return ["browser", "main", "module"];
		return ["browser", "module", "main"];
	}

	// platform === "neutral": esbuild default is empty. 
	return [];
}

/**
 * De-dupe while preserving first-seen order.
 */
export function dedupePreserveOrder(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
}