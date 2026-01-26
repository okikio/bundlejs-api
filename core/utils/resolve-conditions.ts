// core/utils/resolve-conditions.ts
import type { PackageJson } from "@bundle/utils/types";
import type { ESBUILD } from "../types.ts";

/**
 * A high-level “runtime profile” that influences resolution.
 *
 * Why this exists:
 * - Many runtimes are *not* captured by esbuild’s `platform` alone.
 * - Many packages use conditional exports like `"react-native"`, `"electron"`,
 *   `"workerd"`, `"edge-light"`, `"deno"`, etc.
 *
 * This type intentionally does NOT map 1:1 to esbuild `platform`:
 * - `"edge-light"` might be “web-like” but still not the same as `"browser"`.
 * - `"workerd"` is “worker-like” but often wants different fallbacks than `"browser"`.
 *
 * This overlay lets you express “what runtime am I building for?” without
 * mutating `esbuildOpts.conditions` (which would change esbuild’s default `"module"` behavior).
 */
export type ResolveRuntime =
	| "react-native"
	| "electron-main"
	| "electron-renderer"
	| "deno"
	| "workerd"
	| "edge-light";

/**
 * Inputs used to compute resolver conditions and legacy mainFields ordering.
 *
 * Design intent:
 * - Keep the current esbuild-faithful behavior by default.
 * - Add a separate “runtime overlay” that can inject additional conditions
 *   without changing how `esbuildOpts.conditions` behaves.
 *
 * Important nuance:
 * - In the current resolver, *setting* `esbuildOpts.conditions` disables
 *   the “auto-add `"module"`” behavior.
 * - This is desirable because it preserves esbuild semantics:
 *   “If the user sets conditions explicitly, we won’t add implicit ones.”
 *
 * The runtime overlay exists specifically so you can add runtime conditions
 * (like `"react-native"` or `"workerd"`) without turning off auto `"module"`.
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

  /**
   * Runtime overlay:
   * Adds common conditions and mainFields behavior for a known target runtime.
   *
   * This does NOT behave like `esbuildOpts.conditions`.
   * In particular:
   * - It does not disable auto `"module"`.
   * - It is intended to be an additive “profile” layer.
   *
   * Example:
   * - runtime: "react-native" will add the `"react-native"` condition and may
   *   choose to disable `browser` field mapping (because RN is not “the browser”).
   */
	runtime?: ResolveRuntime;

  /**
   * Additional overlay conditions to apply in addition to the runtime profile.
   *
   * Use this when:
   * - A runtime is “close” but you want to add one more condition.
   * - You want to A/B test a condition without adding a new runtime enum.
   *
   * Examples:
   * - runtime: "workerd", runtimeConditions: ["edge-light"]
   * - runtime: "deno", runtimeConditions: ["worker"]
   *
   * These are additive and do NOT disable auto `"module"`.
   */
	runtimeConditions?: readonly string[];
}

/**
 * The computed condition result used by your resolver.
 *
 * - `browser`: Whether the resolver should treat `package.json#browser` mappings as active.
 * - `require`: Whether we’re in a “require-like” context (CJS), which influences
 *   both exports conditions and legacy main field ordering.
 * - `conditions`: The final condition set used for conditional exports / imports resolution.
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
 * Runtime default policy output.
 *
 * - `conditions`: Conditions to add to exports/imports resolution.
 * - `browserField`: Whether to enable `package.json#browser` field mapping.
 *   - `null` means “don’t override; let platform decide”.
 */
export interface RuntimeDefaults {
  conditions: string[];
  browserField: boolean | null;
}


/**
 * Get runtime-specific default overlays.
 *
 * This is intentionally a policy function:
 * - You can tweak these defaults without touching core resolution logic.
 *
 * Notes about ecosystem reality:
 * - Some condition names are “de facto” community standards, not official specs.
 * - Many packages use them anyway, so having a predictable policy helps.
 *
 * If you disagree with any default:
 * - Use `runtimeConditions` to add extra conditions.
 * - Or create a new runtime profile in `ResolveRuntime`.
 */
export function getRuntimeDefaults(runtime: ResolveRuntime | undefined): RuntimeDefaults {
  if (!runtime) {
    return { conditions: [], browserField: null };
  }

  switch (runtime) {
    case "react-native":
      // React Native / Metro commonly uses `"react-native"` in conditional exports.
      // It is NOT “browser”, so we default to disabling browser field mapping.
      return { conditions: ["react-native"], browserField: false };

    case "electron-main":
      // Electron main process behaves like Node, but packages may branch for electron.
      return { conditions: ["electron"], browserField: false };

    case "electron-renderer":
      // Renderer is web-like in many apps, so `browser` mappings are often correct.
      return { conditions: ["electron"], browserField: true };

    case "deno":
      // Deno can satisfy `"deno"` and often supports `"node"` via compat mode.
      // If you want to force “no node compat”, remove `"node"` here or override.
      return { conditions: ["deno", "node"], browserField: false };

    case "workerd":
      // Cloudflare / workerd deployments may use `"workerd"` and/or `"worker"`.
      // We default to disabling browser mappings because workers are not DOM runtimes.
      return { conditions: ["workerd", "worker"], browserField: false };

    case "edge-light":
      // Edge runtimes are typically “web-ish”; `browser` mappings often help.
      return { conditions: ["edge-light"], browserField: true };
  }
}

/**
 * Returns true when the import kind represents a Node-style `require()` usage.
 *
 * This is used to decide whether we should include `"require"` or `"import"` in the
 * conditions list, and influences which legacy fields we prefer.
 */
export function isRequireKind(kind: ESBUILD.ImportKind): boolean {
	return kind === "require-call" || kind === "require-resolve";
}

/**
 * Returns true if the current resolution context should be treated as CommonJS.
 *
 * Plain English:
 * - If the import was triggered by `require()` or `require.resolve()`, it’s require-context.
 * - If it’s an entry point and the output format is `"cjs"`, also treat as require-context.
 *
 * Why entry-point is special:
 * - esbuild’s `args.kind` for entry points is `"entry-point"`, which doesn’t encode
 *   CJS vs ESM. Your chosen output format does.
 *
 * Example:
 * - args.kind === "entry-point"
 * - esbuildOpts.format === "cjs"
 * => we treat it as require-context so `"require"` is used.
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
 * Compute the set of conditions used to resolve package `"exports"` and `"imports"`.
 *
 * This function is a small “policy engine” that combines:
 * 1) Require vs Import (`"require"` or `"import"`)
 * 2) Platform (`"browser"` and/or `"node"`)
 * 3) esbuild’s implicit `"module"` condition (only when user did NOT specify conditions)
 * 4) Runtime overlay (`runtime` and `runtimeConditions`)
 * 5) User conditions (`esbuildOpts.conditions`)
 * 6) Always includes `"default"`
 *
 * The most important rule:
 * - If the user explicitly sets `esbuildOpts.conditions`, we do not auto-add `"module"`.
 *   This preserves esbuild behavior and avoids surprising condition sets.
 *
 * Examples
 * --------
 *
 * Example 1: Default browser build (no explicit conditions)
 * ```ts
 * const c = getResolverConditions(
 *   { kind: "import-statement" },
 *   { platform: "browser", format: "esm" },
 * );
 * // c.conditions includes: ["import", "browser", "module", "default"]
 * // c.browser === true
 * ```
 *
 * Example 2: React Native overlay without disabling auto `"module"`
 * ```ts
 * const c = getResolverConditions(
 *   { kind: "import-statement" },
 *   { platform: "browser", format: "esm", runtime: "react-native" },
 * );
 * // c.conditions includes: ["import", "browser", "module", "react-native", "default"]
 * // c.browser === false  (browser field mapping disabled by RN policy)
 * ```
 *
 * Example 3: User sets explicit esbuild conditions (auto `"module"` stops)
 * ```ts
 * const c = getResolverConditions(
 *   { kind: "import-statement" },
 *   { platform: "browser", format: "esm", conditions: ["react-server"] },
 * );
 * // c.conditions includes: ["import", "browser", "react-server", "default"]
 * // Notice: "module" is NOT auto-added because user provided `conditions`.
 * ```
 */
export function getResolverConditions(
  args: Pick<ESBUILD.OnResolveArgs, "kind">,
  esbuildOpts: ResolverConditionInputs,
): ResolverConditions {
  const platform = esbuildOpts.platform ?? "browser";

  // `require` impacts both exports conditions and legacy mainFields ordering.
  const require = isRequireContext(args, esbuildOpts);

  // Your existing behavior: Cache/Browser field mapping is enabled by default
  // when platform is "browser". This is a boolean policy switch you pass onward.
  let browserField = platform === "browser";

  // This line preserves your esbuild-faithful behavior:
  // if the user supplied conditions, we treat that as authoritative and stop
  // auto-adding "module".
  const userProvidedConditions = typeof esbuildOpts.conditions !== "undefined";

  // Your existing rule: only auto-add "module" for browser/node platforms,
  // and only if user did not supply conditions.
  const mayAutoAddModule =
    !userProvidedConditions && (platform === "browser" || platform === "node");

  const computed: string[] = [];

  // 1) import-vs-require dimension
  computed.push(require ? "require" : "import");

  // 2) platform dimension
  if (platform === "browser") computed.push("browser");
  if (platform === "node") computed.push("node");

  // 3) esbuild-style implicit bundler condition
  if (mayAutoAddModule) computed.push("module");

  // 4) runtime overlay (additive, does NOT affect mayAutoAddModule)
  const runtimeDefaults = getRuntimeDefaults(esbuildOpts.runtime);
  if (runtimeDefaults.browserField !== null) {
    browserField = runtimeDefaults.browserField;
  }
  for (const c of runtimeDefaults.conditions) computed.push(c);

  // 5) extra runtime overlay conditions (also additive)
  if (esbuildOpts.runtimeConditions?.length) {
    for (const c of esbuildOpts.runtimeConditions) computed.push(c);
  }

  // 6) explicit user conditions (these DO imply “no implicit module”)
  if (esbuildOpts.conditions?.length) {
    for (const c of esbuildOpts.conditions) computed.push(c);
  }

  // 7) default always active
  computed.push("default");

  return {
    browser: browserField,
    require,
    conditions: dedupePreserveOrder(computed),
  };
}

/**
 * Compute the “legacy” main fields ordering (for packages that do not resolve via `"exports"`).
 *
 * Plain English:
 * - If `"exports"` resolution fails (or is absent), you fall back to legacy fields:
 *   `"browser"`, `"module"`, `"main"`, etc.
 * - Different runtimes tend to want different priorities.
 * - This function centralizes that policy in one place.
 *
 * Rules:
 * - If user provides `esbuildOpts.mainFields`, we return that as authoritative.
 * - Otherwise, we compute defaults based on platform + require-context + runtime overlay.
 *
 * Examples
 * --------
 *
 * Example 1: Browser ESM default
 * ```ts
 * const fields = getLegacyMainFields(
 *   { main: "./cjs.js", module: "./esm.js", browser: "./browser.js" },
 *   { kind: "import-statement" },
 *   { platform: "browser", format: "esm" },
 * );
 * // ["browser", "module", "main"]
 * ```
 *
 * Example 2: React Native overlay prefers "react-native" field first
 * ```ts
 * const fields = getLegacyMainFields(
 *   { main: "./cjs.js", module: "./esm.js", "react-native": "./rn.js" },
 *   { kind: "import-statement" },
 *   { platform: "browser", format: "esm", runtime: "react-native" },
 * );
 * // ["react-native", "browser", "module", "main"]
 * ```
 */
export function getLegacyMainFields(
  manifest: Pick<PackageJson, "browser" | "main" | "module"> & Record<string, unknown>,
  args: Pick<ESBUILD.OnResolveArgs, "kind">,
  esbuildOpts: Pick<ResolverConditionInputs, "platform" | "format" | "mainFields" | "runtime">,
): string[] {
  // User override takes precedence, consistent with esbuild.
  if (esbuildOpts.mainFields) return Array.from(esbuildOpts.mainFields);

  const platform = esbuildOpts.platform ?? "browser";
  const require = isRequireContext(args, esbuildOpts);

  // Runtime overlays for legacy fields:
  // This is the place you capture “ecosystem reality” for packages that haven't
  // fully migrated to conditional exports.

  if (esbuildOpts.runtime === "react-native") {
    // Many packages still expose a top-level "react-native" legacy field.
    // Prefer it first to match Metro/RN expectations.
    const hasReactNativeEntrypoint = typeof manifest["react-native"] === "string";

    // If we're in require-context and there's no RN entrypoint, we prefer
    // main before module to avoid accidentally selecting ESM in a CJS-only path.
    if (require && !hasReactNativeEntrypoint) {
      return ["react-native", "browser", "main", "module"];
    }

    // Otherwise ESM-first fallback (module before main).
    return ["react-native", "browser", "module", "main"];
  }

  if (esbuildOpts.runtime === "electron-renderer") {
    // Renderer: browser mappings tend to be desirable; ESM-first for imports.
    if (require) return ["browser", "main", "module"];
    return ["browser", "module", "main"];
  }

  if (esbuildOpts.runtime === "electron-main") {
    // Main: Node-like. Keep ordering conservative.
    return ["main", "module"];
  }

  if (esbuildOpts.runtime === "edge-light") {
    // Edge runtimes are commonly ESM-first and "web-ish".
    return ["browser", "module", "main"];
  }

  if (esbuildOpts.runtime === "workerd") {
    // Workerd / workers: typically ESM-first, and "browser" mappings can be risky
    // because they may assume DOM APIs or bundle in browser-only shims.
    return ["module", "main"];
  }

  if (esbuildOpts.runtime === "deno") {
    // Deno: ESM-first fallback.
    return ["module", "main"];
  }

  // Default behavior (no runtime overlay):
  if (platform === "node") {
    return ["main", "module"];
  }

  if (platform === "browser") {
    const hasBrowserEntrypoint = typeof (manifest as { browser?: unknown }).browser === "string";

    // This is your existing nuance:
    // If we're in require-context AND browser is NOT a string entrypoint,
    // prefer main over module to avoid forcing ESM onto a CJS path.
    if (require && !hasBrowserEntrypoint) {
      return ["browser", "main", "module"];
    }

    return ["browser", "module", "main"];
  }

  return [];
}

/**
 * Dedupe an array of strings while preserving order.
 *
 * Why:
 * - Condition lists are effectively sets, but order matters for debugging and for
 *   deterministic tests.
 * - We want stable output and no accidental duplicates.
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