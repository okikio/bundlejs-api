// src/utils/resolve-conditions.ts
import type { ESBUILD } from "../types.ts";

/**
 * A minimal view of esbuild options that matter for package.json conditional resolution.
 */
export interface ResolverConditionInputs {
	platform?: ESBUILD.BuildOptions["platform"];
	conditions?: ESBUILD.BuildOptions["conditions"];
	format?: ESBUILD.BuildOptions["format"];
}

/**
 * The computed condition set we pass into resolve-exports-imports.
 */
export interface ResolverConditions {
	/**
	 * Whether to respect the `browser` field and browser mappings.
	 */
	browser: boolean;

	/**
	 * Whether we are resolving for a CommonJS "require" context.
	 */
	require: boolean;

	/**
	 * Ordered, de-duped list of conditions to test against package.json "exports"/"imports".
	 * Always ends with "default" as a last-resort condition.
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
 * Compute the effective condition set in a way that matches esbuild’s documented behavior:
 * - platform injects either "browser" or "node"
 * - "module" is injected only when the user did not explicitly provide `conditions`
 *
 * See esbuild’s `conditions` and platform behavior. :contentReference[oaicite:5]{index=5}
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

	const browser = platform === "browser";

	// Esbuild only auto-adds "module" when user didn't specify `conditions` at all.
	const userProvidedConditions = typeof esbuildOpts.conditions !== "undefined";

	const computed: string[] = [];

	// Model the import-vs-require dimension explicitly.
	computed.push(require ? "require" : "import");

	// Model platform dimension.
	if (platform === "browser") computed.push("browser");
	if (platform === "node") computed.push("node");

	// Model esbuild's implicit "module" condition (only if conditions not explicitly set).
	if (!userProvidedConditions) computed.push("module");

	// Then append any explicit custom conditions the caller provided.
	// (Esbuild will *not* auto-add "module" in this case; user owns the full list.)
	if (esbuildOpts.conditions?.length) {
		for (const c of esbuildOpts.conditions) computed.push(c);
	}

	// Always allow "default" fallback last.
	computed.push("default");

	return {
		browser,
		require,
		conditions: dedupePreserveOrder(computed),
	};
}

/**
 * De-dupe while preserving left-to-right priority.
 */
export function dedupePreserveOrder(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}
