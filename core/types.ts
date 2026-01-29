import type * as ESBUILD from "esbuild";
import type * as ESBUILD_WASM from "esbuild-wasm";
import type { FullPackageVersion, PackageJson } from "@bundle/utils/types";
import type { InitOptions } from "./init.ts";

import type { record } from "./context/context.ts";
import type { IFileSystem } from "./utils/filesystem.ts";
import type { TarballState } from "./plugins/tar.ts";
import type { ResolverConditionInputs } from "../utils/resolve-conditions.ts";
import type { SideEffectsMatchers } from "./utils/side-effects.ts";

export type { ESBUILD, ESBUILD_WASM };

export interface CommonConfigOptions extends record {
  /**
   * Configures how esbuild-wasm is initialized 
   */
  init?: InitOptions | null
};

/**
 * Local state available to all plugins
 */
export interface LocalState<T = unknown> extends TarballState, record {
  filesystem: IFileSystem<T>,

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
  cdn?: "https://unpkg.com" | "https://esm.run" | "https://esm.sh" | "https://esm.sh/jsr" | "https://cdn.skypack.dev" | "https://cdn.jsdelivr.net/npm" | "https://cdn.jsdelivr.net/gh" | "https://deno.land/x" | "https://raw.githubusercontent.com" | "unpkg" | "esm.run" | "esm.sh" | "esm" | "jsr" | "skypack" | "jsdelivr" | "jsdelivr.gh" | "github" | "deno" | (string & {}),

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
