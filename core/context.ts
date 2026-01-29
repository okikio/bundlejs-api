import type { BuildConfig, ESBUILD, LocalState } from "./types.ts";
import type { BuildResult } from "./build.ts";

import { VirtualFileSystemPlugin } from "./plugins/fs.ts";
import { ExternalPlugin } from "./plugins/external.ts";
import { TarballPlugin } from "./plugins/tar.ts";
import { AliasPlugin } from "./plugins/alias.ts";
import { HttpPlugin } from "./plugins/http.ts";
import { CdnPlugin } from "./plugins/cdn.ts";

import { createConfig } from "./configs/config.ts";
import { Context, fromContext, toContext, withContext } from "./context/context.ts";

import { createNotice } from "./utils/create-notice.ts";
import { TheFileSystem, formatBuildResult } from "./build.ts";
import { init } from "./init.ts";

import { BUILD_ERROR, INIT_LOADING, LOGGER_ERROR, dispatchEvent } from "./configs/events.ts";
import { DEFAULT_CDN_HOST, getCDNUrl } from "./utils/cdn-format.ts";

export interface BuildContext extends ESBUILD.BuildContext {
  state: Context<LocalState>
};

export async function context(opts: BuildConfig = {}, filesystem = TheFileSystem): Promise<BuildContext> {
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
  let context_result: ESBUILD.BuildContext;

  try {
    if (!esbuild?.context)
      throw new Error("Initialization failed, couldn't access esbuild.context(...) function");

    try {
      context_result = await esbuild.context({
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

    return {
      state: StateContext,
      ...context_result
    }
  } catch (e) {
    const err = e as Error;
    if (!("msgs" in err)) {
      dispatchEvent(BUILD_ERROR, err);
    }

    throw e;
  }
}

export async function rebuild(ctx: BuildContext): Promise<BuildResult> {
  const { state: StateContext } = ctx;
  let build_result: ESBUILD.BuildResult;

  try {
    try {
      // Clear the assets, failedExtensionChecks, and failedManifestUrls
      ctx.state.target.assets.length = 0;
      ctx.state.target.failedExtensionChecks.clear();
      ctx.state.target.failedManifestUrls.clear();
      ctx.state.target.sideEffectsMatchersCache.clear();
      // ctx.state.target.filesystem?.clear?.();
      // ctx.state.target.packageManifests.clear();

      build_result = await ctx.rebuild();
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

export async function cancel(build_ctx: BuildContext): Promise<void> {
  try {
    try {
      await build_ctx.cancel();
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
  } catch (e) {
    const err = e as Error;
    if (!("msgs" in err)) {
      dispatchEvent(BUILD_ERROR, err);
    }

    throw e;
  }
}

export async function dispose(build_ctx: BuildContext): Promise<void> {
  try {
    try {
      await build_ctx.dispose();
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
  } catch (e) {
    const err = e as Error;
    if (!("msgs" in err)) {
      dispatchEvent(BUILD_ERROR, err);
    }

    throw e;
  }
}
