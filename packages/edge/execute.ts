import ESBUILD_WASM from "@bundle/core/wasm";

import { bundle } from "./bundle.ts";
import type { Config, PreparedBundleRequest } from "./types.ts";

let wasmSource: Uint8Array | undefined;
let compiledWasmModule: WebAssembly.Module | undefined;

export async function getBundleWasmModule(): Promise<WebAssembly.Module> {
	if (!wasmSource) {
		wasmSource = await ESBUILD_WASM();
	}

	if (!compiledWasmModule) {
		compiledWasmModule = new WebAssembly.Module(wasmSource as BufferSource);
	}

	return compiledWasmModule;
}

export async function createBundleConfig(preparedRequest: PreparedBundleRequest): Promise<Config> {
	const wasmModule = await getBundleWasmModule();

	return Object.assign({}, preparedRequest.jsonKeyObject, {
		entryPoints: [`/index.${preparedRequest.bundleKey}${preparedRequest.useTsxEntrypoint ? ".tsx" : ".ts"}`],
		init: {
			...preparedRequest.jsonKeyObject.init,
			wasmModule
		}
	}) as Config;
}

export async function executePreparedBundle(url: URL, preparedRequest: PreparedBundleRequest) {
	const config = await createBundleConfig(preparedRequest);

	return bundle(
		url,
		preparedRequest.initialValue,
		config,
		preparedRequest.versions,
		preparedRequest.modules,
		preparedRequest.query
	);
}