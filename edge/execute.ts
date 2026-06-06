import ESBUILD_WASM from "@bundle/core/wasm";

import { bundle } from "./bundle.ts";
import type { PreparedBundleRequest } from "./request.ts";
import type { Config } from "./types.ts";

let WASM_BYTES: Uint8Array | undefined;
let WASM_MODULE: WebAssembly.Module | undefined;

export type ExecutePreparedBundleOptions = {
  wasmModule?: WebAssembly.Module;
};

/**
 * Execute a previously prepared bundle request.
 *
 * Responsibilities:
 * - Lazily initialize/cached esbuild's wasm bytes and `WebAssembly.Module`.
 * - Inject the `wasmModule` into the config's init block.
 * - Generate a stable entrypoint filename using `prepared.bundleKey`.
 *
 * This split lets both Deno Deploy and Workers share the same execution path
 * without importing either runtime's storage/cache layer.
 */
export async function executePreparedBundle(
  url: URL,
  prepared: PreparedBundleRequest,
  options: ExecutePreparedBundleOptions = {}
): Promise<readonly [Response, string]> {
  const wasmModule = options.wasmModule;

  if (wasmModule) {
    WASM_MODULE = wasmModule;
  }

  // Cloudflare Workers does not allow dynamic wasm compilation at runtime.
  // When running in that environment, a precompiled `WebAssembly.Module`
  // should be provided (e.g. via Wrangler `wasm_modules` binding).
  if (!WASM_MODULE) {
    if (!WASM_BYTES) {
      WASM_BYTES = await ESBUILD_WASM();
    }

    WASM_MODULE = new WebAssembly.Module(WASM_BYTES as BufferSource);
  }

  const inputFileHash = prepared.bundleKey;
  const configObj = Object.assign({}, prepared.jsonKeyObj, {
    entryPoints: [`/index.${inputFileHash}${prepared.tsx ? ".tsx" : ".ts"}`],
    init: {
      ...((prepared.jsonKeyObj as Record<string, any>).init ?? {}),
      wasmModule: WASM_MODULE
    }
  }) as unknown as Config;

  const [response, resultText] = await bundle(
    url,
    prepared.initialValue,
    configObj,
    prepared.versions,
    prepared.modules,
    prepared.query
  );

  return [response, resultText] as const;
}
