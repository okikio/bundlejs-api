import { build } from "@bundle/core";
import { compress } from "@bundle/compress";
import { outdent } from "@bundle/utils/outdent";

const result = await build({
  entryPoints: [],
  esbuild: {
    stdin: {
      contents: outdent`
        // Click Build for the Bundled, Minified & Compressed package size
        export { useMigrations } from "npm:drizzle-orm/expo-sqlite/migrator";
        export { drizzle } from "npm:drizzle-orm/expo-sqlite";
        export { openDatabaseSync } from "npm:expo-sqlite";
      `,
      loader: 'tsx',
      resolveDir: ".",
    },
    platform: "node",
  }
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