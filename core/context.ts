import type { BuildConfig, ESBUILD, LocalState } from "./types.ts";
import type { DisposableBuildResult } from "./build.ts";

import { VirtualFileSystemPlugin } from "./plugins/fs.ts";
import { ExternalPlugin } from "./plugins/external.ts";
import { TarballPlugin } from "./plugins/tar.ts";
import { PackagePlugin } from "./plugins/package.ts";
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

/**
 * Long-lived build context with Explicit Resource Management support.
 *
 * Extends esbuild's `BuildContext` with `Disposable` and `AsyncDisposable`,
 * enabling `using` / `await using` for automatic cleanup of the esbuild
 * context, per-build abort controller, and registered scope resources.
 *
 * @example
 * ```ts
 * await using ctx = await context({ entryPoints: ["/index.tsx"] });
 * const r1 = await rebuild(ctx);
 * // … modify VFS …
 * const r2 = await rebuild(ctx);
 * // ← esbuild context disposed, background fetches aborted at end of scope
 * ```
 */
export interface BuildContext extends ESBUILD.BuildContext, AsyncDisposable, Disposable {
  state: Context<LocalState>;
};

export async function context(opts: BuildConfig = {}, filesystem = TheFileSystem): Promise<BuildContext> {
  if (!fromContext("initialized"))
    dispatchEvent(INIT_LOADING);

  // -- Per-build resource lifecycle -------------------------------------------
  // Create (or reuse) per-build resources, and ensure abort fires on dispose.
  //
  // IMPORTANT — registration order matters for LIFO disposal:
  //   1. Plugins `scope.adopt(bgPromise, awaiter)` during rebuild  (registered mid-rebuild)
  //   2. `defer(() => abortController.abort())`                    (registered LAST, below)
  //
  // LIFO disposal runs #2 first (abort cancels in-flight fetches),
  // then #1 (awaiters drain settling promises incl. cache.put ops).
  const disposables = new AsyncDisposableStack();
  const abortController = new AbortController();

  // NOTE: abort is registered AFTER context creation (see below)
  // so it sits at the TOP of the LIFO stack → fires FIRST on dispose.

  const StateContext = new Context<LocalState>({
    filesystem: Context.opaque(await filesystem),
    assets: [],
    config: Context.opaque(createConfig("build", opts)),

    scope: Context.opaque(disposables),
    abort: Context.opaque(abortController),

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
          TarballPlugin(StateContext),
          PackagePlugin(StateContext),
          VirtualFileSystemPlugin(StateContext),
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

    // Register abort as the LAST item on the stack so LIFO disposal
    // fires it FIRST — cancelling in-flight fetches before we await
    // background promises adopted during rebuilds.
    //
    // The defer is async with a microtask yield so Deno's runtime has a
    // chance to clean up internal `fetchCancelHandle` resources.
    disposables.defer(async () => {
      abortController.abort();
      await Promise.resolve();
    });

    return {
      state: StateContext,
      ...context_result,

      /**
       * Synchronous dispose — fires cleanup without awaiting.
       * Prefer `await using` for complete cleanup.
       */
      [Symbol.dispose]() {
        void dispose(this as BuildContext);
      },

      /**
       * Async dispose — awaits full cleanup (esbuild context + abort + scope).
       * Used by `await using ctx = await context(...)`.
       */
      async [Symbol.asyncDispose]() {
        await dispose(this as BuildContext);
        // Yield a macrotask for Deno runtime resource finalization.
        await new Promise<void>(r => setTimeout(r, 0));
      },
    }
  } catch (e) {
    // Context creation failed — abort explicitly since defer(abort) wasn't registered yet.
    abortController.abort();
    // Caller won't receive a disposable context — clean up before re-throwing.
    try { await disposables.disposeAsync(); } catch { /* don't mask the original error */ }

    const err = e as Error;
    if (!("msgs" in err)) {
      dispatchEvent(BUILD_ERROR, err);
    }

    throw e;
  }
}

export async function rebuild(ctx: BuildContext): Promise<DisposableBuildResult> {
  const { state: StateContext } = ctx;
  let build_result: ESBUILD.BuildResult;

  const disposables = fromContext("scope", StateContext);

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

    const formatted = await formatBuildResult({
      state: StateContext,
      ...build_result
    });

    // Disposal is idempotent — safe to call multiple times.
    // The flag prevents double-dispose if the caller calls both
    // `[Symbol.dispose]()` and later `[Symbol.asyncDispose]()`.
    return Object.assign(formatted, {
      [Symbol.dispose]() { void disposables.disposeAsync() },
      [Symbol.asyncDispose]() { return disposables.disposeAsync() },
    });
  } catch (e) {
    // Caller won't receive a disposable result — clean up before re-throwing.
    try { await disposables.disposeAsync(); } catch { /* don't mask the original error */ }

    const err = e as Error;
    if (!("msgs" in err)) {
      dispatchEvent(BUILD_ERROR, err);
    }

    throw e;
  }
}

export async function cancel(ctx: BuildContext): Promise<void> {
  try {
    try {
      await ctx.cancel();

      // Dispose per-build resources (aborts background fetches, etc.)
      const disposables = fromContext("scope", ctx.state);
      if (disposables) {
        await disposables.disposeAsync();
      }
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

export async function dispose(ctx: BuildContext): Promise<void> {
  try {
    try {
      await ctx?.dispose?.();

      // Dispose per-build resources (aborts background fetches, etc.)
      const disposables = fromContext("scope", ctx.state);
      if (disposables) {
        await disposables.disposeAsync();
      }
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
