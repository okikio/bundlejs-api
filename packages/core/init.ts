import type * as ESBUILD from "esbuild-wasm";
import type { Platform } from "./configs/platform.ts";

import { PLATFORM_AUTO } from "./configs/platform.ts";
import { type GlobalState, Context, fromContext, toContext } from "./context/context.ts";

import { defaultVersion, getEsbuild, getEsbuildVersion } from "./utils/get-esbuild.ts";
import { INIT_COMPLETE, INIT_ERROR, INIT_START, dispatchEvent } from "./configs/events.ts";

/**
 * Configures how esbuild running in wasm is initialized 
 */
export interface InitOptions extends ESBUILD.InitializeOptions {
  platform?: Platform,
  version?: string
}

export async function init(opts: Partial<ESBUILD.InitializeOptions> | null = {}, [platform = PLATFORM_AUTO, _version = defaultVersion]: Partial<[Platform, string]> = []) {
  opts ??= {};

  // If already fully initialized, fast-path return.
  if (fromContext("initialized")) {
    return fromContext("esbuild");
  }

  // If initialization is already in progress (from a concurrent caller),
  // reuse the same promise to avoid calling esbuild.initialize() twice.
  const inflight = fromContext("initPromise");
  if (inflight) {
    return inflight;
  }

  // Use Promise.withResolvers so we can store the promise in context
  // *synchronously* before any `await` yields control — this ensures
  // every concurrent caller that arrives before the first `await` sees
  // the in-flight promise and joins it instead of racing.
  const { promise, resolve, reject: _reject } = Promise.withResolvers<GlobalState["esbuild"]>();
  toContext("initPromise", promise);

  try {
    dispatchEvent(INIT_START);

    const version = await getEsbuildVersion(_version);
    const esbuild = await getEsbuild(platform, version);
    toContext("esbuild", Context.opaque(esbuild));

    if (
      platform !== "node" &&
      platform !== "deno"
    ) {
      if ("wasmModule" in opts!) {
        await esbuild.initialize(opts!);
      } else if ("wasmURL" in opts!) {
        await esbuild.initialize(opts!);
      } else if (version === defaultVersion) {
        const { default: ESBUILD_WASM } = await import("./wasm.ts");
        await esbuild.initialize({
          wasmModule: new WebAssembly.Module(await ESBUILD_WASM() as BufferSource),
          ...opts
        });
      } else {
        await esbuild.initialize(opts!);
      }
    }

    dispatchEvent(INIT_COMPLETE);
    toContext("initialized", true);

    const result = fromContext("esbuild");
    resolve(result);
    return result;
  } catch (e) {
    const error = e as Error | unknown;
    dispatchEvent(INIT_ERROR, error as Error);
    console.error(error);

    toContext("initialized", false);
    toContext("esbuild", null);

    // Resolve (not reject) with null so concurrent waiters get a
    // clean signal rather than unhandled-rejection noise — the caller
    // that actually kicked off init already sees the error above.
    resolve(null);
  } finally {
    // Clear the in-flight promise so a subsequent init() call
    // (e.g. after stop() resets state) starts a fresh initialization.
    toContext("initPromise", null);
  }
}

/**
 * Tears down the esbuild WASM worker and resets global init state.
 *
 * After calling this, any subsequent `build()` / `transform()` / `context()`
 * call will re-run `init()` and spin up a fresh worker.
 *
 * Safe to call multiple times — no-ops if esbuild was never initialized
 * or has already been stopped.
 *
 * @example Standalone cleanup
 * ```ts
 * const result = await build({ entryPoints: ["/mod.tsx"] });
 * // … use result …
 * await stop(); // release WASM worker
 * ```
 *
 * @example With explicit resource management (automatic)
 * ```ts
 * // build() and context() dispose automatically via AsyncDisposableStack,
 * // which includes calling stop(). Manual calls are only needed for
 * // transform() or standalone usage.
 * ```
 */
export async function stop(): Promise<void> {
  // Prevent any in-flight init from writing back initialized=true / esbuild
  // after we tear everything down.
  toContext("initPromise", null);

  const esbuild = fromContext("esbuild");
  if (!esbuild) return;

  // esbuild's stop() terminates the WASM worker thread and resets
  // internal init state. The cast is needed because the type declarations
  // don't always include `stop` — but it's present at runtime on every
  // platform skew (Deno WASM, browser WASM, native Node).
  const maybeStop = (esbuild as Record<string, unknown>).stop;
  if (typeof maybeStop === "function") {
    await (maybeStop as () => Promise<void>)();
  }

  toContext("initialized", false);
  toContext("esbuild", null);
}