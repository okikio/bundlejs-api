import { encode } from "@bundle/utils/encode-decode";
import { compress } from "./mod.ts";

console.log("\n");
console.log(
  await compress(
    [encode("Lorem Ipsium...Lorem Ipsium...Lorem Ipsium...Lorem Ipsium...")],
    { type: "gzip" }
  )
);

if (globalThis?.Deno) {
  globalThis?.Deno?.exit?.();
}