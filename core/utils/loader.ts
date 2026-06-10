import type { Loader } from "esbuild-wasm";
import { extname } from "@bundle/utils/path";
import { extension } from "@bundle/utils/media-types";

/** Based on https://github.com/egoist/play-esbuild/blob/main/src/lib/esbuild.ts */
export const RESOLVE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".css", ".json"];

/**
 * Implicit package-entry probing modeled after Node's CommonJS `require()`.
 *
 * Confirmed automatic fallbacks in Node's documented resolver are:
 * - `.js`
 * - `.json`
 * - `.node`
 *
 * bundlejs intentionally omits `.node` here because native addons are not
 * loadable in this browser-oriented bundling flow. Files like `.cjs` or `.mjs`
 * are still supported when they are referenced explicitly by the import
 * specifier or by manifest metadata, but they are not part of implicit
 * fallback probing.
 */
export const PACKAGE_ENTRY_RESOLVE_EXTENSIONS = [".js", ".json"];

export const _knownExtensions = [
  // Remove period `.tsx` -> `tsx`
  ...RESOLVE_EXTENSIONS.map(x => x.slice(1)),
  "mjs", "cjs", "mts", "cts", "node", "scss",
  "png", "jpeg", "ttf", "svg",
  "html", "txt", "wasm"
];

/**
 * Lightweight heuristic to detect JSX syntax in source content.
 *
 * Scans for byte sequences that are unambiguously JSX and would not
 * appear in regular JavaScript/TypeScript:
 *
 * - Closing JSX tags: `</Component>`, `</div>`
 * - JSX fragment closings: `</>`
 *
 * The pattern `</` followed by an ASCII letter or `>` has near-zero
 * false positives in non-JSX code. The only theoretical false positive
 * is `</` inside a string or template literal, which is harmless — the
 * `tsx` loader still parses the file correctly because esbuild doesn't
 * interpret string contents as JSX.
 *
 * Accepts both `string` and `Uint8Array`/`ArrayBuffer` input. For binary
 * input, operates directly on bytes without decoding for performance.
 *
 * ```
 *   Byte scan pattern:
 *   ┌──────┬──────┬──────────────────────┐
 *   │ 0x3C │ 0x2F │ 0x41–5A / 61–7A / 3E │
 *   │  <   │  /   │  A-Z  /  a-z  /  >   │
 *   └──────┴──────┴──────────────────────┘
 * ```
 *
 * @param content Source code as a string or binary buffer
 * @returns true if the content likely contains JSX syntax
 */
export function containsJSX(content: string | Uint8Array | ArrayBufferLike): boolean {
  // String path: quick regex test
  if (typeof content === "string") {
    return /<\/[A-Za-z>]/.test(content);
  }

  // Binary path: byte-level scan without string decoding
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  const len = bytes.length;

  for (let i = 0; i < len - 2; i++) {
    // Match: `<` (0x3C), `/` (0x2F), then A-Z / a-z / `>` (0x3E)
    if (bytes[i] === 0x3C && bytes[i + 1] === 0x2F) {
      const next = bytes[i + 2];
      if (
        (next >= 0x41 && next <= 0x5A) || // A-Z
        (next >= 0x61 && next <= 0x7A) || // a-z
        next === 0x3E                      // >
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Based on the file extension, determine the esbuild loader to use.
 *
 * When `content` is provided and the extension maps to the `ts` loader
 * (i.e. `.js`, `.mjs`, `.cjs`), the content is scanned for JSX syntax.
 * If JSX is detected, the loader is upgraded to `tsx`.
 *
 * This handles the React Native / Expo ecosystem convention where `.js`
 * files ship JSX (since Metro bundler treats all `.js` as JSX-capable).
 *
 * **Why only `.js`/`.mjs`/`.cjs`?** Actual `.ts` files are not upgraded
 * because TypeScript generics (e.g. `Array<T>`) would be misparsed as
 * JSX by the `tsx` loader.
 */
export const inferLoader = (
  urlStr: string,
  contentType?: string | null,
  content?: string | Uint8Array | ArrayBufferLike,
): Loader => {
  const ext = extname(urlStr);
  if (RESOLVE_EXTENSIONS.includes(ext)) {
    // Resolve all .js and .jsx files to .ts and .tsx files
    const loader = (/\.js(x)?$/.test(ext) ? ext.replace(/^\.js/, ".ts") : ext).slice(1) as Loader;

    // Upgrade ts → tsx when .js content contains JSX
    // (common in React Native ecosystems like Expo where .js files ship JSX)
    if (loader === "ts" && content && containsJSX(content)) return "tsx";

    return loader;
  }

  if (ext === ".mjs" || ext === ".cjs") {
    // Upgrade ts → tsx when .mjs/.cjs content contains JSX
    if (content && containsJSX(content)) return "tsx";
    return "ts"; // "js"
  }
  if (ext === ".mts" || ext === ".cts") return "ts";

  if (ext === ".scss") return "css";

  if (ext === ".png" || ext === ".jpeg" || ext === ".ttf") return "dataurl";
  if (ext === ".svg" || ext === ".html" || ext === ".txt") return "text";
  if (ext === ".wasm") return "file";

  if (contentType) {
    const _ext = extension(contentType);
    if (_ext && _knownExtensions.includes(_ext))
      return inferLoader(urlStr + `.${_ext}`, undefined, content);
  }

  return ext.length ? "text" : "ts";
};