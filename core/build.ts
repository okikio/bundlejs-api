import type { BuildConfig, ESBUILD, LocalState } from "./types.ts";
import type { FullPackageVersion, PackageJson } from "@bundle/utils/types";

import { VirtualFileSystemPlugin } from "./plugins/fs.ts";
import { ExternalPlugin } from "./plugins/external.ts";
import { TarballPlugin } from "./plugins/tar.ts";
import { AliasPlugin } from "./plugins/alias.ts";
import { HttpPlugin } from "./plugins/http.ts";
import { CdnPlugin } from "./plugins/cdn.ts";

import { Context, fromContext, toContext, withContext } from "./context/context.ts";

import { BUILD_ERROR, INIT_LOADING, LOGGER_ERROR, LOGGER_LOG, LOGGER_WARN, dispatchEvent } from "./configs/events.ts";
import { createConfig } from "./configs/config.ts";
import { PLATFORM_AUTO } from "./configs/platform.ts";

import { DEFAULT_CDN_HOST, getCDNUrl } from "./utils/cdn-format.ts";
import { useFileSystem, type IFileSystem } from "./utils/filesystem.ts";
import { createNotice } from "./utils/create-notice.ts";

import { init } from "./init.ts";
import { bytes } from "@bundle/utils/fmt";

/**
 * Default build config
 */
export const BUILD_CONFIG: BuildConfig = {
  "entryPoints": ["/index.tsx"],
  "cdn": DEFAULT_CDN_HOST,
  "polyfill": false,

  "esbuild": {
    "color": true,
    "globalName": "BundledCode",

    "logLevel": "info",
    "sourcemap": false,

    "target": ["esnext"],
    "format": "esm",
    "bundle": true,
    "minify": true,

    "treeShaking": true,
    "platform": "node",

    "jsx": "transform"
  },

  "ansi": "ansi",
  init: {
    platform: PLATFORM_AUTO
  }
};

export interface BuildResult extends ESBUILD.BuildResult {
  outputs: ESBUILD.OutputFile[];
  contents: ESBUILD.OutputFile[];

  packageSizeArr: string[][];
  totalInstallSize: string;
};

export interface BuildResultContext extends ESBUILD.BuildResult {
  state: Context<LocalState>
};

export const TheFileSystem = useFileSystem();
export async function build(opts: BuildConfig = {}, filesystem: Promise<IFileSystem<unknown>> = TheFileSystem): Promise<BuildResult> {
  if (!fromContext("initialized"))
    dispatchEvent(INIT_LOADING);

  const StateContext = new Context<LocalState>({
    filesystem: Context.opaque(await filesystem),
    assets: [],
    config: Context.opaque(createConfig("build", opts)),

    failedExtensionChecks: new Set(),
    failedManifestUrls: new Set(),
    host: DEFAULT_CDN_HOST,
    versions: new Map(),

    tarballInflight: new Map(),
    tarballMounts: new Map(),
    sideEffectsMatchersCache: new Map(),

    packageManifests: new Map(),
  });

  const LocalConfig = fromContext("config", StateContext)!;
  const { origin: host } = LocalConfig?.cdn && !/:/.test(LocalConfig?.cdn) ?
    getCDNUrl(LocalConfig?.cdn + ":") :
    getCDNUrl(LocalConfig?.cdn ?? DEFAULT_CDN_HOST);

  toContext("host", host ?? DEFAULT_CDN_HOST, StateContext);

  const { platform, version, ...initOpts } = LocalConfig.init ?? {};
  const esbuildOpts = LocalConfig.esbuild ?? {};
  const esbuild = await init(initOpts, [platform, version]);

  // Stores content from all external outputed files, this is for checking the gzip size when dealing with CSS and other external files
  let build_result: ESBUILD.BuildResult;

  try {
    if (!esbuild?.build)
      throw new Error("Initialization failed, couldn't access esbuild.build(...) function");

    try {
      build_result = await esbuild.build({
        entryPoints: LocalConfig?.entryPoints ?? [],
        loader: {
          ".png": "file",
          ".jpeg": "file",
          ".ttf": "file",
          ".svg": "text",
          ".html": "text",
          ".scss": "css"
        },
        define: Object.assign({
          "__NODE__": "false",
          "process.env.NODE_ENV": "\"production\"",
        }, esbuildOpts.define),
        write: false,
        outdir: "/",
        plugins: [
          AliasPlugin(StateContext),
          ExternalPlugin(StateContext),
          VirtualFileSystemPlugin(StateContext),
          TarballPlugin(StateContext),
          HttpPlugin(StateContext),
          CdnPlugin(withContext({ origin: host }, StateContext)),
        ],
        ...esbuildOpts,
      });
    } catch (e) {
      const fail = e as ESBUILD.BuildFailure;
      if (fail.errors) {
        // Log errors with added color info. to the virtual console
        const ansiMsgs = await createNotice(fail.errors, "error", false) ?? [];
        dispatchEvent(LOGGER_ERROR, new Error(ansiMsgs.join("\n")));

        const message = (ansiMsgs.length > 1 ? `${ansiMsgs.length} error(s) ` : "") + "(if you are having trouble solving this issue, please create a new issue in the repo, https://github.com/okikio/bundlejs)";
        dispatchEvent(LOGGER_ERROR, new Error(message));

        const htmlMsgs = await createNotice(fail.errors, "error") ?? [];
        throw { msgs: htmlMsgs };
      } else throw e;
    }

    return await formatBuildResult({
      state: StateContext,
      ...build_result
    });
  } catch (e) {
    const err = e as Error;
    if (!("msgs" in err)) {
      dispatchEvent(BUILD_ERROR, err);
    }

    throw e;
  }
}

export async function formatBuildResult(_ctx: BuildResultContext) {
  const LocalConfig = fromContext("config", _ctx.state)!;

  const assets = fromContext("assets", _ctx.state)! ?? [];
  const packageManifests = 
    fromContext('packageManifests', _ctx.state)
    ?? new Map<string, PackageJson | FullPackageVersion>();

  try {
    const esbuild_opts = LocalConfig.esbuild ?? {};
    let outputs: ESBUILD.OutputFile[] = [];
    let contents: ESBUILD.OutputFile[] = [];

    if (_ctx.warnings?.length > 0) {
      // Log errors with added color info. to the virtual console
      const ansiMsgs = await createNotice(_ctx.warnings, "warning", false) ?? [];
      dispatchEvent(LOGGER_WARN, ansiMsgs.join("\n"));

      const message = `${ansiMsgs.length} warning(s) `;
      dispatchEvent(LOGGER_WARN, message);
    }

    // Create an array of assets and actual output files, this will later be used to calculate total file size
    outputs = await Promise.all(
      Array.from(assets ?? [])
        .concat(_ctx?.outputFiles as ESBUILD.OutputFile[])
    );

    contents = await Promise.all(
      outputs
        .map((file): ESBUILD.OutputFile | null => {
          if (/\.map$/.test(file.path))
            return null;

          // For debugging reasons, if the user chooses verbose, print all the content to the Shared Worker console
          if (esbuild_opts?.logLevel === "verbose") {
            const ignoreFile = /\.(wasm|png|jpeg|webp)$/.test(file.path);
            if (ignoreFile) {
              dispatchEvent(LOGGER_LOG, "Output File: " + file.path);
            } else {
              dispatchEvent(LOGGER_LOG, "Output File: " + file.path + "\n" + file.text);
            }
          }

          return {
            path: file.path,
            get text() { return file.text },
            get contents() { return file.contents },
            hash: file.hash
          };
        })

        // Remove null output files
        .filter(x => x !== null && x !== undefined) as ESBUILD.OutputFile[]
    );

    // Ensure a fresh filesystem on every run
    // await fs?.clear?.();
    // console.log({ contentsLen: contents.length })
    
    const packageSizeArr: [string, string][] = [];
    let totalInstallSize = 0;

    for (const [name, manifest] of packageManifests) {
      const unpackedSize: number = manifest?.dist?.unpackedSize;
      if (typeof unpackedSize === "number") {
        packageSizeArr.push([name, bytes.format(unpackedSize)]);
        totalInstallSize += unpackedSize;
      }
    }

    return {
      // state: StateContext.target,
      config: LocalConfig,

      /** 
       * The output and asset files without unnecessary croft, e.g. `.map` sourcemap files 
       */
      contents,

      /**
       * The output and asset files with `.map` sourcemap files 
       */
      outputs,

      packageSizeArr,
      totalInstallSize: bytes.format(totalInstallSize),

      errors: _ctx.errors,
      mangleCache: _ctx.mangleCache,
      metafile: _ctx.metafile,
      outputFiles: _ctx.outputFiles,
      warnings: _ctx.warnings,
    };
  } catch (e) {
    const err = e as Error;
    if (!("msgs" in err)) {
      dispatchEvent(BUILD_ERROR, err);
    }

    throw e;
  }
}