import { base64, ascii85 } from "@bundle/utils/encoding";
import { outdent } from "@bundle/utils/outdent";

import { bytes } from "@bundle/utils/fmt";
import { dirname, join } from '@bundle/utils/path';

import { compress as lz4, decompress as unlz4 } from "../deno/lz4/mod.ts";
import { compress as gzip, decompress as gunzip } from "../deno/gzip/mod.ts";
import { compress as brotli, decompress as unbrotli } from "../deno/brotli/mod.ts";
import { compress as zstd, decompress as unzstd } from "../deno/zstd/mod.ts";

const encoder = new TextEncoder();

const compression = {
  "gzip": "@bundle/compress/gzip",
  "brotli": "@bundle/compress/brotli",
  "zstd": "@bundle/compress/zstd",
  "lz4": "@bundle/compress/lz4",
} as const;

export async function build(
  [mode = "zstd", encoding = "base64"]: Partial<[keyof typeof compression, "base64" | "ascii85"]> = [], 
  src: string | URL | Uint8Array | Promise<string | Uint8Array>, 
  _target = "deno/zstd/zstd.encoded.wasm.ts", 
  importsPaths?: Partial<Record<keyof typeof compression, string>>
) {
  const value = await src;

  if (typeof value === "string") console.log(`\n- Source file: ${value}`);
  const res = typeof value === "string" || value instanceof URL ? await Deno.readFile(value) : value;
  const wasm = new Uint8Array(res);
  console.log(`- Read WASM (size: ${bytes.format(wasm.length)})`);

  console.time("Compression time")
  let compressed: Uint8Array<ArrayBuffer> = wasm;
  if (mode === "zstd") {
    compressed = await zstd(wasm, 22);
  } else if (mode === "brotli") {
    compressed = await brotli(wasm);
  } else if (mode === "gzip") {
    compressed = await gzip(wasm);
  } else if (mode === "lz4") {
    compressed = await lz4(wasm);
  }
  console.timeEnd("Compression time")

  console.time("Decompression time")
  if (mode === "zstd") {
    await unzstd(compressed);
  } else if (mode === "brotli") {
    await unbrotli(compressed);
  } else if (mode === "gzip") {
    await gunzip(compressed);
  } else if (mode === "lz4") {
    await unlz4(wasm);
  }
  console.timeEnd("Decompression time")

  console.log(
    `- Compressed WASM using ${mode} (reduction: ${bytes.format(wasm.length - compressed.length)}, size: ${bytes.format(compressed.length)})`,
  );

  const encoded = JSON.stringify(
    encoding === "ascii85" 
      ? ascii85.encodeAscii85(compressed) 
      : base64.encodeBase64(compressed)
  );
  console.log(
    `- Encoded WASM using ${encoding}, (increase: ${bytes.format(encoded.length -
      compressed.length)}, size: ${bytes.format(encoded.length)})`,
  );

  console.log("- Inlining wasm code in js");
  const compressionModuleImportPath = ({
    ...compression,
    ...importsPaths
  })[mode];

  const commonReturn = outdent`
    const { decompress } = await import(\"${compressionModuleImportPath}\");
    return await decompress(uint8arr);
  `;

  const modeReturns = ({
    "gzip": outdent`
      const cs = new DecompressionStream('gzip');
      const decompressedStream = new Blob([uint8arr]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(decompressedStream).arrayBuffer());
    `,
    "brotli": commonReturn,
    "lz4": commonReturn,
    "zstd": commonReturn,
  })[mode] ?? `return uint8arr;`;

  const source = outdent`
    ${encoding === "ascii85" ? `import { ascii85 } from "@bundle/utils/encoding";` : ""}
    export const source = async () => {
      const uint8arr = (${encoding === "ascii85" ? 
        `ascii85.decodeAscii85(\n\t${encoded}\n)`  : 
        `Uint8Array.from(atob(${encoded}), c => c.charCodeAt(0))`
      });
      ${modeReturns}
    };
    export default source;
  `;

  const targetPath = join(import.meta.dirname, "..", _target);
  const targetDir = dirname(targetPath);
  console.log({
    target: targetPath,
    targetDir,
  })

  console.log(`- Writing output to file (${targetPath})`);
  await Promise.all([
    Deno.writeFile(targetPath, encoder.encode(source)),
  ]);

  const outputFile = await Deno.stat(targetPath);
  console.log(
    `- Output file (${targetPath}), final size is: ${bytes.format(outputFile.size)}\n`
  );
}

await build(["gzip", "ascii85"], "./deno/zstd/zstd.wasm", "deno/zstd/zstd.encoded.wasm.ts");
await build(["gzip", "ascii85"], "./deno/lz4/deno_lz4_bg.wasm", "deno/lz4/wasm.ts");
await build(["zstd", "ascii85"], "./deno/brotli/deno_brotli_bg.wasm", "deno/brotli/wasm.ts", {
  "zstd": "../zstd/mod.ts"
});
