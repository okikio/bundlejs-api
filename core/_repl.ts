import type { TarStreamEntry } from "@bundle/utils/tar";
import { UntarStream } from "@bundle/utils/tar";
import { normalize, join } from "@bundle/utils/path";

import { getFile, setFile, PLATFORM_AUTO, TheFileSystem } from "./mod.ts";
import { context, cancel, dispose, rebuild, } from "./mod.ts";

const fs = await TheFileSystem;


// const response = await fetch("https://pkg.pr.new/@tanstack/react-query@7988");
// const content = await response.arrayBuffer();

// const contentType = response.headers.get("content-type");


// if (contentType?.trim()?.toLowerCase() === "application/tar+gzip") {
//   // const blob = new Blob([content]);
//   const stream = new Blob([content]).stream()
//     .pipeThrough<Uint8Array>(new DecompressionStream("gzip"))
//     .pipeThrough(new UntarStream());

//   // Create a reader from the stream
//   const reader = stream.getReader();

//   console.log({
//     stream,
//     reader
//   })

//   // Get the stream as an async iterable
//   const iterableStream = {
//     async *[Symbol.asyncIterator]() {
//       try {

//         console.log({
//           result: "result"
//         })

//         while (true) {
//           const result = await reader.read();
//           if (result.done) break;
//           yield result.value;
//         }

//         console.log({
//           result_POLL: "result"
//         })
//       } finally {
//         reader.releaseLock();
//       }
//     }
//   };

//   for await (const entry of iterableStream) {
//       // console.log({
//       //     entry
//       // })
//       const path = normalize(entry.path);
//       // await Deno.mkdir(dirname(path));

//       // Convert the stream into a Blob
//       const blob = await new Response(entry.readable).blob();

//       // Convert the Blob to an ArrayBuffer and then into a Uint8Array
//       const arrayBuffer = await blob.arrayBuffer();

//       const uint8arr = new Uint8Array(arrayBuffer);
//       console.log({
//         path: join("./", path)
//       })
//       setFile(fs, join("./tar/", path), uint8arr);
//   }

// }





// console.log({
//   version: await resolveVersion(`esbuild@0.18`)
// })
console.log("\n");
// await setFile(fs, "/index.tsx", `\
// export * as Other from "/new.tsx";
// export * from "@okikio/animate";`);
// await setFile(fs, "/new.tsx", "export * from \"@okikio/native\";");
await setFile(fs, "/new.tsx", "export * from \"https://pkg.pr.new/@tanstack/react-query@7988\"")
// await setFile(fs, "/other.tsx", `\
// export * as Other from "/index.tsx";
// export * from "@okikio/emitter";`);

// console.log(await getFile(fs, "/index.tsx", "string") )

console.log(await getFile(fs, "/new.tsx", "string") )
console.log(fs)

const ctx = await context({
  // "/index.tsx",
  entryPoints: ["/new.tsx"],
  esbuild: {
    treeShaking: true,
    splitting: true,
    format: "esm"
  },
  init: {
    // platform: "node",
    // version: "0.17",
    // wasm
  }
});
const result = await rebuild(ctx);

console.log({
  result,
  // packageManifests: result.state.packageManifests,
  //   // await compress(
  //   //   result.contents.map((x: any) => x?.contents),
  //   //   { type: "gzip" }
  //   // )
});


// await setFile(fs, "/index.tsx", `\
//   export * as Other from "/new.tsx";
//   export * from "spring-easing";`);
// const result2 = await rebuild(ctx);


// console.log({
//   result2,
//   // packageManifests: result2.state.packageManifests,
//   //   // await compress(
//   //   //   result.contents.map((x: any) => x?.contents),
//   //   //   { type: "gzip" }
//   //   // )
// });

await cancel(ctx);
await dispose(ctx);
if (PLATFORM_AUTO === "deno") {
  globalThis?.Deno?.exit?.();
} else {
  // @ts-ignore Only for Node
  globalThis?.process?.exit?.();
}


// import { resolveVersion } from "./src/utils/npm-search";
// console.log(await resolveVersion("@okikio/animate@>=1 <2"))

