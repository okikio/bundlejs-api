import { TheFileSystem, getFile, setFile } from "@bundle/core";

import { build } from "@bundle/core";
import { compress } from "@bundle/compress";
import { outdent } from "@bundle/utils/outdent";

const fs = await TheFileSystem;

// Overwrite the same file to test caching and tarball extraction behavior across multiple builds
await setFile(fs, "/mod.tsx", "export * from \"@okikio/native\";");
await setFile(fs, "/mod.tsx", "export * from \"jsr:@okikio/sparql\";")
await setFile(fs, "/mod.tsx", "export * from \"https://pkg.pr.new/@tanstack/react-query@7988\"")
await setFile(fs, "/mod.tsx", "export * from 'iconv-lite';\nexport { default } from 'iconv-lite';")
await setFile(fs, "/mod.tsx", "export { debounce } from 'lodash-es';")
await setFile(fs, "/mod.tsx", "export * from '@floating-ui/dom@1.6.13';\nexport { default } from '@floating-ui/dom@1.6.13';")
await setFile(fs, "/mod.tsx", "export * from '@aws-sdk/client-s3';\nexport { default } from '@aws-sdk/client-s3';")
await setFile(fs, "/mod.tsx", outdent`
  export { useMigrations } from 'https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz';
  export { drizzle } from "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz";
  export { openDatabaseSync } from "https://registry.npmjs.org/expo-sqlite/-/expo-sqlite-16.0.10.tgz";
`)

// Overwrite with the final content for the build
await setFile(fs, "/mod.tsx", outdent`
  export { useMigrations } from "npm:drizzle-orm/expo-sqlite/migrator";
  export { drizzle } from "npm:drizzle-orm/expo-sqlite";
  export { openDatabaseSync } from "npm:expo-sqlite";
`);

await setFile(fs, "/index.tsx", outdent`
  export * as Other from "/mod.tsx";
  export * from "@okikio/animate";
`);

await setFile(fs, "/entry.tsx", outdent`
  export * as Other from "/index.tsx";
  export * from "@okikio/emitter";
`);

console.log(
  "\n// filename: /mod.tsx\n" +
  await getFile(fs, "/mod.tsx", "string")
)
console.log(
  "\n// filename: /index.tsx\n" +
  await getFile(fs, "/index.tsx", "string")
)
console.log(
  "\n// filename: /entry.tsx\n" +
  await getFile(fs, "/entry.tsx", "string")
)
console.log("\n")

const result = await build({
  entryPoints: ["/entry.tsx"],
  esbuild: { platform: "node" }
});

const { content: _content, ...size } = await compress(
  result.contents.map(x => x.contents as Uint8Array),
);

console.log({ size });
// Output:
// {
//   size: {
//     type: "gzip",
//     rawUncompressedSize: 2535489,
//     uncompressedSize: "2.54 MB",
//     rawCompressedSize: 815487,
//     compressedSize: "815 kB",
//     size: "815 kB (gzip)"
//   }
// }

if (globalThis?.Deno) {
  globalThis?.Deno?.exit?.();
} else {
  // @ts-ignore Only for Node
  globalThis?.process?.exit?.();
}


