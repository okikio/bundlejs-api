import type * as ESBUILD from "esbuild";
import type * as ESBUILD_WASM from "esbuild-wasm";
import type { FullPackageVersion, PackageJson } from "@bundle/utils/types";
import type { InitOptions } from "./init.ts";

import type { record } from "./context/context.ts";
import type { IFileSystem } from "./utils/filesystem.ts";
import type { TarballState } from "./plugins/tar.ts";
import type { ResolverConditionInputs } from "../utils/resolve-conditions.ts";
import type { SideEffectsMatchers } from "./utils/side-effects.ts";
import type { RegistryConfig } from "@bundle/utils/npmrc";

export type { ESBUILD, ESBUILD_WASM };

/**
 * Policy for handling `false` remapping values found in path remapping
 * fields (browser, react-native, electron).
 *
 * - `"stub"` – replace the module with an empty export (`{}` at runtime).
 *   This is spec-compliant and matches webpack/rollup behavior.
 * - `"error"` – produce a build error, halting the bundle.
 * - `"external"` – mark the import as external so it's preserved in the
 *   output verbatim and resolved at runtime.
 */
export type RemapFalsePolicy = "stub" | "error" | "external";

/**
 * Controls how the bundler reacts when a path remapping field (browser,
 * react-native, electron) maps a package or module to `false`.
 */
export interface RemapFalseBehavior {
  /**
   * Policy when an *entire package* is excluded (e.g., the top-level
   * `"browser": false` or an exports condition that resolves to nothing).
   *
   * - `"error"` (default) – fail the build with a clear error.
   * - `"stub"` – replace with an empty export stub instead of erroring.
   *
   * `"external"` is not supported at the package level because the bare
   * specifier would need a runtime resolver, which esbuild cannot provide.
   *
   * @default "error"
   */
  packageRemapFalse?: "error" | "stub";

  /**
   * Policy when a *single module* inside a package is excluded (e.g.,
   * `"browser": { "./server.js": false }`).
   *
   * - `"stub"` (default) – spec-compliant empty export.
   * - `"error"` – fail the build.
   * - `"external"` – mark the import as external.
   *
   * @default "stub"
   */
  importRemapFalse?: RemapFalsePolicy;

  /**
   * Whether to emit an esbuild warning when a module is stubbed.
   *
   * Only takes effect when the active policy is `"stub"`.
   *
   * @default true
   */
  warnOnStubbedRemapFalse?: boolean;
}

export interface CommonConfigOptions extends record {
  /**
   * Configures how esbuild-wasm is initialized 
   */
  init?: InitOptions | null;
};

/**
 * Local state available to all plugins
 */
export interface LocalState<T = unknown> extends TarballState, record {
  filesystem: IFileSystem<T>,

  /**
   * Per-build resource scope.
   *
   * Anything that must be torn down at the end of the build (workers,
   * wasm runtimes, in-flight background work, etc.) should be registered here.
   *
   * Registers cleanup callbacks (abort controllers, WASM handles, workers,
   * etc.) that run when the build finishes or the context is disposed.
   * Resources are released in **LIFO** order.
   *
   * @example
   * ```ts
   * // Plugin-side cleanup
   * const scope = fromContext('scope', StateContext);
   * const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
   *
   * scope.defer(function () {
   *   worker.terminate();
   * });
   * ```
   *
   * @example
   * ```ts
   * // Adopt a non-disposable value with a disposer
   * scope.adopt(wasmRuntime, function (rt) {
   *   rt.close();
   * });
   * ```
   *
   * @see https://github.com/tc39/proposal-explicit-resource-management
   */
  scope: AsyncDisposableStack,

  /**
   * Abort controller scoped to this build’s lifetime.
   * Put simply, it allows you to cancel individual builds.
   *
   * Use this for fetches or long-running work that should stop when the build
   * is canceled/disposed.
   *
   * Threaded through background fetch operations so they are cancelled
   * when the build finishes. Prevents resource leaks from fire-and-forget
   * stale-while-revalidate refreshes.
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal
   */
  abort: AbortController,

  /**
   * Versions
   */
  versions: Map<string, string>,

  /**
   * Assets are files during the build process that esbuild can't handle natively, 
   * e.g. fetching web workers using the `new URL("...", import.meta.url)`
   */
  assets: ESBUILD.OutputFile[] | ESBUILD_WASM.OutputFile[],

  failedExtensionChecks: Set<string>,
  failedManifestUrls: Set<string>,
  packageManifests: Map<string, PackageJson | FullPackageVersion>,
  sideEffectsMatchersCache: Map<string, SideEffectsMatchers>,

  host: string,
  config: BuildConfig,
}

export interface BuildConfig extends CommonConfigOptions {
  /** esbuild config options https://esbuild.github.io/api/#build-api */
  esbuild?: ESBUILD.BuildOptions | ESBUILD_WASM.BuildOptions,
  resolve?: ResolverConditionInputs,

  /**
   * The package.json to use when trying to bundle files
   */
  "package.json"?: PackageJson | FullPackageVersion,

  /**
   * Enables or disables polyfill
   */
  polyfill?: boolean,

  /** The default CDN to import packages from */
  cdn?: "https://unpkg.com" | "https://esm.run" | "https://esm.sh" | "https://esm.sh/jsr" | "https://cdn.skypack.dev" | "https://cdn.jsdelivr.net/npm" | "https://cdn.jsdelivr.net/gh" | "https://deno.land/x" | "https://raw.githubusercontent.com" | "https://registry.npmjs.org" | "unpkg" | "esm.run" | "esm.sh" | "esm" | "jsr" | "jsr.registry" | "skypack" | "jsdelivr" | "jsdelivr.gh" | "github" | "deno" | "npm" | "npm.registry" | (string & {}),

  /**
   * Custom npm registry configuration.
   *
   * Controls which registries are used for package resolution and tarball
   * downloads. Supports scoped registries for routing different scopes
   * to different registries (e.g., JSR packages through npm.jsr.io).
   *
   * Accepts:
   * - `string`: A default registry URL, or raw `.npmrc` content
   *   (auto-detected by presence of `=` or newlines)
   * - `RegistryConfig`: Structured config with optional scoped overrides
   *
   * @example Default registry
   * ```ts
   * { registry: "https://npm.jsr.io" }
   * ```
   *
   * @example Scoped registries
   * ```ts
   * {
   *   registry: {
   *     registry: "https://registry.npmjs.org",
   *     scopedRegistries: {
   *       "@jsr": "https://npm.jsr.io",
   *       "@mycompany": "https://npm.mycompany.com/"
   *     }
   *   }
   * }
   * ```
   *
   * @example Raw .npmrc content
   * ```ts
   * { registry: "@jsr:registry=https://npm.jsr.io\nregistry=https://registry.npmjs.org" }
   * ```
   */
  registry?: string | RegistryConfig,

  /**
   * Controls behavior when path remapping fields (browser, react-native,
   * electron) map a package or module to `false`.
   *
   * @example Stub whole-package exclusions instead of erroring
   * ```ts
   * { remapFalse: { packageRemapFalse: "stub" } }
   * ```
   *
   * @example Error on per-module exclusions
   * ```ts
   * { remapFalse: { importRemapFalse: "error" } }
   * ```
   */
  remapFalse?: RemapFalseBehavior,

  /** Aliases for replacing packages with different ones, e.g. replace "fs" with "memfs", so, it can work on the web, etc... */
  alias?: Record<string, string>,

  /**
   * Enables converting ansi logs to HTML so virtual consoles can handle the logs and print with color
   */
  ansi?: "html" | "html-and-ansi" | "ansi",

  /**
   * Documentation: https://esbuild.github.io/api/#entry-points
   */
  entryPoints?: ESBUILD.BuildOptions["entryPoints"] | ESBUILD_WASM.BuildOptions['entryPoints']
};
