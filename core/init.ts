import type * as ESBUILD from "esbuild-wasm";
import type { Platform } from "./configs/platform.ts";

import { PLATFORM_AUTO } from "./configs/platform.ts";
import { Context, fromContext, toContext } from "./context/context.ts";

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
  try {
    if (!fromContext("initialized")) {
      dispatchEvent(INIT_START);

      const version = await getEsbuildVersion(_version);
      const esbuild = await getEsbuild(platform, version);
      toContext("esbuild", Context.opaque(esbuild));
      
      if (
        platform !== "node" &&
        platform !== "deno"
      ) {
        if ("wasmModule" in opts) {
          await esbuild.initialize(opts);
        } else if ("wasmURL" in opts) { 
          await esbuild.initialize(opts);
        } else if (version === defaultVersion) {
          const { default: ESBUILD_WASM } = await import("./wasm.ts");
          await esbuild.initialize({
            wasmModule: new WebAssembly.Module(await ESBUILD_WASM() as BufferSource),
            ...opts
          });
        } else {
          await esbuild.initialize(opts);
        }
      }

      dispatchEvent(INIT_COMPLETE);
      toContext("initialized", true);
    }

    return fromContext("esbuild");
  } catch (e) {
    const error = e as Error | unknown;
    dispatchEvent(INIT_ERROR, error as Error);
    console.error(error);

    toContext("initialized", false);
    toContext("esbuild", null);
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