# Scenario 20 — Flow Type Stripping

> Tests that JavaScript files containing Flow type annotations are detected and stripped before esbuild processes them, preventing parse errors from Flow-specific syntax.


## Background: What Is Flow?

**Flow** is a **static type checker for JavaScript**, created by **Meta (Facebook)** in 2014. Like TypeScript, it adds type annotations to JavaScript — but unlike TypeScript, Flow annotations are *not* valid JavaScript or TypeScript syntax. They must be removed before any standard JavaScript engine or bundler can process the file.

> **Mental model:** TypeScript *replaces* JavaScript's type story. Flow *annotates* JavaScript without changing the language identity. A `.js` file with Flow annotations is still considered a JavaScript file — it just has extra annotations that Flow-aware tooling reads and everyone else must strip.

### Flow vs TypeScript — Key Differences

| Aspect | Flow | TypeScript |
|:-------|:-----|:-----------|
| **File extension** | `.js` (same as JavaScript) | `.ts` / `.tsx` |
| **Syntax identity** | Annotations in JS files; not valid JS | Superset of JS; not valid JS either |
| **Pragma** | `// @flow` at top of file | None required |
| **Type stripping** | Requires dedicated tooling (`flow-remove-types`, Babel) | esbuild, `tsc`, SWC, OXC all handle it |
| **Ecosystem** | React Native, Metro, Expo, Meta OSS | Broadly adopted across web ecosystem |
| **Spec status** | No TC39 proposal; Meta-proprietary syntax | No TC39 proposal either; Microsoft-backed |
| **Tooling** | `hermes-parser`, `flow-remove-types`, Babel plugin | esbuild, SWC, OXC, `tsc` |

> **Important distinction:** TypeScript type stripping is widely supported by modern bundlers (esbuild, SWC, OXC). Flow type stripping is **not**. esbuild has no Flow support. OXC explicitly rejects Flow — its parser detects `@flow` pragmas and emits "Flow is not supported". This is why bundlejs needs a dedicated Flow stripping layer.

### Flow Syntax That Breaks Standard Parsers

Flow introduces syntax forms that are **unambiguously invalid** in both JavaScript and TypeScript:

```js
// @flow

// 1. import typeof — imports the *type* of a value binding
import typeof ActionSheetIOS from './ActionSheetIOS';

// 2. Opaque types — types visible only within the defining module
opaque type Token = string;

// 3. Flow utility types — $-prefixed built-in type operators
type Props = $Exact<{ name: string }>;
type Diff = $Diff<Full, Partial>;
type Mapped = $ObjMap<Obj, <V>(V) => Array<V>>;

// 4. Type annotations on parameters (shared with TS, but in .js files)
function greet(name: string): void { }

// 5. Type cast expressions (non-standard)
const x = (value: any);

// 6. Declare statements
declare module 'react-native' { }
declare export default class Foo { }
```

The syntax that most commonly causes esbuild failures is **`import typeof`** (form 1), because esbuild encounters it at the top level during initial parsing:

```
✘ [ERROR] Unexpected "typeof"
    react-native@1000.0.0/index.js:14:7:
      14 │ import typeof ActionSheetIOS from './Libraries/ActionSheetIOS/ActionSheetIOS';
         │        ~~~~~~
```


### Why Packages Ship Raw Flow

In the **React Native / Metro / Expo ecosystem**, shipping `.js` files with raw Flow annotations is the **convention**, not the exception. Here's why:

1. **Metro bundler** (React Native's default bundler) has native Flow support. It strips types as part of its Babel pipeline (`@babel/plugin-transform-flow-strip-types`), so packages never need to pre-compile.

2. **React Native itself** (`react-native` on npm) ships its entire source as Flow-annotated `.js` files. The `index.js` entry point is full of `import typeof` statements.

3. **Expo SDK packages** follow the same pattern. They compile TypeScript to JavaScript but may retain Flow annotations from React Native dependencies.

4. **fbjs**, **react-native-web**, and other Meta OSS packages also ship raw Flow.

This creates a problem for **any bundler that isn't Metro**: the published npm package contains syntax that no standard JavaScript parser understands. esbuild, webpack (without Babel), Rollup, and Vite all cannot parse these files.

```
Metro Bundler (React Native)          bundlejs / esbuild / webpack
┌──────────────────────────┐          ┌──────────────────────────┐
│ .js with Flow annotations│          │ .js with Flow annotations│
│          │                │          │          │                │
│          ▼                │          │          ▼                │
│ Babel @flow strip plugin  │          │ ??? → parse error        │
│          │                │          │                          │
│          ▼                │          │ (need: flow-remove-types) │
│ Valid JavaScript          │          │          │                │
│          │                │          │          ▼                │
│          ▼                │          │ Valid JavaScript          │
│ Bundle output             │          │          │                │
└──────────────────────────┘          │          ▼                │
                                      │ esbuild continues         │
                                      └──────────────────────────┘
```

> **The TC39 connection:** There is an active [TC39 Type Annotations proposal](https://github.com/tc39/proposal-type-annotations) (Stage 1) that would allow JavaScript engines to natively ignore type annotations. If this proposal advances, Flow annotations in `.js` files would become valid JavaScript and no stripping would be needed. Until then, stripping is required.


## How bundlejs Implements Flow Stripping

### The Tool: `flow-remove-types`

bundlejs uses **[`flow-remove-types`](https://github.com/facebook/flow/tree/main/packages/flow-remove-types)** — the official type-stripping tool maintained by the Flow team. Key facts:

- Built on **`hermes-parser`** — Meta's Hermes JavaScript engine parser compiled to WASM
- Understands **all** Flow syntax (not just common patterns)
- Replaces type annotations with whitespace, preserving **source positions** (line/column numbers remain stable)
- Zero configuration — no Babel, no plugins, no `.flowconfig`

**Why not alternatives?**

| Tool | Why not |
|:-----|:--------|
| OXC (`oxc-transform`) | Explicitly rejects Flow. Parser emits "Flow is not supported" on `@flow` pragma |
| Babel + `@babel/plugin-transform-flow-strip-types` | Heavy dependency chain. Needs `@babel/core` + parser + plugin. Startup cost too high for per-request bundling |
| SWC | No built-in Flow support |
| Manual regex | Cannot handle all Flow syntax. Used only as a last-resort fallback |

### Architecture

Source: [core/utils/flow-strip.ts](../../core/utils/flow-strip.ts)

The implementation has three layers:

```
                    Flow Stripping Pipeline

  ┌──────────────────────────────────────────────────────────┐
  │  Layer 1: Detection — containsFlow(content, opts?)       │
  │                                                          │
  │  1a. Known-package fast path (Set lookup)                │
  │  1b. URL heuristic (/react-native/ in URL)               │
  │  1c. @flow pragma scan (first 4 KB)                      │
  │  1d. Syntax pattern scan (import typeof, opaque type, $) │
  │                                                          │
  │  → false? Return content unchanged. Zero overhead.       │
  └──────────────────────┬───────────────────────────────────┘
                         │ true
                         ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Layer 2: Full stripping — flow-remove-types             │
  │                                                          │
  │  Lazy-loaded on first Flow file. Uses hermes-parser      │
  │  (WASM) for complete AST-based type removal.             │
  │  Replaces annotations with whitespace.                   │
  │                                                          │
  │  → success? Return cleaned source.                       │
  │  → unavailable or parse error? Fall through.             │
  └──────────────────────┬───────────────────────────────────┘
                         │ fallback
                         ▼
  ┌──────────────────────────────────────────────────────────┐
  │  Layer 3: Regex fallback — regexStripFlow()              │
  │                                                          │
  │  Best-effort removal of:                                 │
  │  • @flow pragmas                                         │
  │  • import typeof → import                                │
  │  • import type { ... } from '...' → whitespace           │
  │  • export type { ... } → whitespace                      │
  │                                                          │
  │  ⚠ Will NOT handle all Flow syntax. Complex patterns     │
  │    (opaque type bodies, inline casts, generics) will     │
  │    still fail at esbuild parse time.                     │
  └──────────────────────────────────────────────────────────┘
```

### Detection Strategy — `containsFlow()`

Detection is ordered by cost (cheapest first):

1. **Known-package lookup** — a `Set` of package names known to ship Flow source. Currently contains `"react-native"`. This check is O(1) and avoids scanning content entirely when the URL or package name matches.

2. **URL heuristic** — scans the URL for known-package names (e.g., `/react-native/` or `/react-native@`). Catches files loaded via CDN where the package name is embedded in the URL path.

3. **`@flow` pragma** — scans the first 4 KB of the file for `// @flow` or `/* @flow */`. Most properly authored Flow files include this pragma in their first comment block.

4. **Syntax pattern scan** — tests the full content against three unambiguous Flow patterns:
   - `/\bimport\s+typeof\b/` — `import typeof X from '...'` (invalid in JS and TS)
   - `/\bopaque\s+type\b/` — `opaque type Foo = ...` (Flow-only keyword combination)
   - `/\$(?:Exact|Diff|ObjMap|...)\b/` — Flow utility types (`$Exact`, `$Diff`, `$ObjMap`, etc.)

**Why these patterns have near-zero false positives:**

- `import typeof` is syntactically invalid in both JavaScript (no `typeof` after `import`) and TypeScript (uses `import type` instead).
- `opaque type` as two consecutive tokens does not appear in JS or TS. TypeScript has `type` declarations but not `opaque type`.
- `$Exact`, `$Diff`, etc. are Flow-specific built-in utility types. While `$` is valid in identifiers, the specific `$Exact`/`$Diff` names with the `$` prefix are extremely unlikely outside Flow.

> **Relationship to Scenario 18 (JSX in `.js` files):** Flow detection and JSX detection solve the same category of problem — React Native ecosystem packages shipping non-standard syntax in `.js` files. `containsJSX` (byte-level scan for `</[A-Za-z>]`) detects JSX; `containsFlow` detects Flow annotations. Both run in `onLoad` handlers and are additive: a file can trigger both JSX loader upgrade and Flow stripping.


### Integration Points

Flow stripping hooks into esbuild's `onLoad` phase — after content is fetched/read but before esbuild parses it:

**PackagePlugin** ([core/plugins/package.ts](../../core/plugins/package.ts)) — the sole `onLoad` handler for **both** namespaces:

**HTTP namespace** (CDN-fetched files):
```
  CDN fetch → raw bytes (via determineExtension)
       │
       ▼
  maybeStripFlow(content, { url })
       │
       ├─ Flow detected → strip → return cleaned string
       └─ No Flow → return original bytes
       │
       ▼
  esbuild parse (with inferred loader)
```

**VFS namespace** (tarball-extracted and user-authored files):
```
  VFS getFile() → raw bytes
       │
       ▼
  maybeStripFlow(content, { url: args.path })
       │
       ├─ Flow detected → strip → return cleaned string
       └─ No Flow → return original bytes
       │
       ▼
  esbuild parse (with inferred loader)
```

**ExternalPlugin** does **not** need Flow stripping — it returns a static `export default {}` stub for builtin modules and excluded-module stubs.

> **Ordering with JSX detection:** Flow stripping runs *before* loader inference. The result (cleaned source) is then passed to `inferLoader()`, which may upgrade the loader from `ts` to `tsx` if JSX is detected in the (now Flow-free) content. This ordering is correct: Flow type annotations could theoretically mask JSX patterns, so stripping first ensures accurate JSX detection.


### Lazy Loading

`flow-remove-types` (which bundles `hermes-parser` WASM) is **not** imported at startup. It's loaded lazily on first encountering a Flow file:

```typescript
// First Flow file triggers the import:
const mod = await import("flow-remove-types");
_flowRemoveTypes = mod.default ?? mod;

// Subsequent calls use the cached reference:
if (_flowRemoveTypes) return _flowRemoveTypes;
```

A parallel-import guard (`_flowRemoveTypesLoading` promise) prevents multiple simultaneous imports if several Flow files are detected concurrently.

If the import fails (e.g., dependency not available), `_flowRemoveTypesAvailable` is set to `false` and all subsequent calls skip the import attempt, falling through to the regex fallback.


### Deviations from Standard Flow

bundlejs's Flow handling intentionally differs from how the Flow type checker and Metro bundler handle Flow files:

| Aspect | Standard Flow / Metro | bundlejs |
|:-------|:---------------------|:---------|
| **Detection** | Requires `@flow` pragma | Also detects via syntax patterns and known-package list (many RN files lack pragmas) |
| **Stripping tool** | Babel pipeline (`@babel/plugin-transform-flow-strip-types`) | `flow-remove-types` (lighter, zero-config) |
| **Fallback** | No fallback — Babel either works or fails | Regex fallback for partial stripping when `flow-remove-types` unavailable |
| **Scope** | Metro strips all `.js` files through Babel regardless | bundlejs only strips files where Flow is *detected* (opt-in per file) |
| **Coverage** | Complete — all Flow syntax handled | `flow-remove-types` is complete; regex fallback handles only common patterns |
| **`.flow.js` convention** | Some tools look for `.flow.js` suffix | Not currently detected — could be added to known-patterns |

**Key deviation:** Metro applies Babel's Flow plugin to *every* `.js` file in its pipeline unconditionally. bundlejs is selective — it only strips files where `containsFlow()` returns `true`. This is a deliberate efficiency choice: most npm packages do not contain Flow, and running `flow-remove-types` on every file would add unnecessary latency. The trade-off is that a Flow file with no pragma, no known-package match, and no detected syntax patterns could slip through unstripped. In practice, this gap is very small because the syntax patterns catch the constructs that actually cause parse failures.

**Known limitation — regex fallback coverage:**

The regex fallback (`regexStripFlow`) only handles:
- `@flow` pragma removal
- `import typeof` → `import` rewrite
- `import type { ... } from '...'` removal
- `export type { ... }` removal

It does **not** handle:
- Inline type annotations (`function foo(x: string) {}`)
- Type cast expressions (`(value: Type)`)
- Opaque type declarations (`opaque type Token = string`)
- Generic type parameters in Flow syntax
- `declare` statements

If `flow-remove-types` is unavailable and the file uses these advanced patterns, esbuild will still produce parse errors. This is an acceptable trade-off: `flow-remove-types` is listed as an explicit dependency in [core/deno.jsonc](../../core/deno.jsonc) and should always be available in normal operation.


---

## Scenarios


### 20.1 — `@flow` pragma triggers detection

**What it tests:** A file with `// @flow` pragma at the top is detected as Flow.

```js
// @flow
import React from 'react';
const App = () => <div />;
export default App;
```

Expected: `containsFlow(content)` → `true`.

**Regression signal:** Flow files with pragma aren't stripped → esbuild parse errors.


### 20.2 — `import typeof` triggers detection (no pragma)

**What it tests:** A file using `import typeof` without a `@flow` pragma is still detected via syntax patterns.

```js
import typeof ActionSheetIOS from './Libraries/ActionSheetIOS/ActionSheetIOS';
import typeof AlertManager from './Libraries/Alert/AlertManager';
export { ActionSheetIOS, AlertManager };
```

Expected: `containsFlow(content)` → `true`.

**Regression signal:** `Unexpected "typeof"` error from esbuild — the original bug that motivated this feature.


### 20.3 — `opaque type` triggers detection

**What it tests:** Flow-only `opaque type` keyword pair is detected.

```js
opaque type Token = string;
opaque type UserID: number = number;
export type { Token, UserID };
```

Expected: `containsFlow(content)` → `true`.


### 20.4 — Flow utility types trigger detection

**What it tests:** Flow `$`-prefixed utility types are detected.

```js
type ExactProps = $Exact<{ name: string, age: number }>;
type Difference = $Diff<Full, Partial>;
type MappedObj = $ObjMap<Obj, <V>(V) => Array<V>>;
```

Expected: `containsFlow(content)` → `true`.


### 20.5 — Known-package fast path (`react-native`)

**What it tests:** A file from `react-native` is detected as Flow without scanning content — the package name alone triggers detection.

```js
// Ordinary-looking JS, no Flow syntax visible
module.exports = {};
```

Expected: `containsFlow(content, { packageName: "react-native" })` → `true`.

**Regression signal:** If the known-package check is removed, detection relies on content scanning — slower and could miss files with annotations deep in the source (past the 4 KB pragma window).


### 20.6 — URL heuristic detects react-native in CDN paths

**What it tests:** The URL pattern `/react-native/` or `/react-native@` triggers the known-package fast path even without an explicit `packageName` option.

Expected: `containsFlow(content, { url: "https://esm.sh/react-native@0.74.0/index.js" })` → `true`.


### 20.7 — Non-Flow `.js` file is not detected

**What it tests:** Ordinary JavaScript without Flow syntax returns `false`. No stripping overhead.

```js
import { useState } from 'react';
export const useCounter = () => {
  const [count, setCount] = useState(0);
  return { count, increment: () => setCount(c => c + 1) };
};
```

Expected: `containsFlow(content)` → `false`, `maybeStripFlow(content)` → `{ wasStripped: false }`.

**Regression signal:** If detection is too aggressive, non-Flow files get unnecessarily processed, adding latency.


### 20.8 — TypeScript `import type` is not misidentified

**What it tests:** TypeScript's `import type { X } from '...'` syntax does NOT trigger Flow detection (it's valid TypeScript, not Flow-specific).

```ts
import type { ReactNode } from 'react';
import type { FC } from 'react';
export type Props = { children: ReactNode };
```

Expected: `containsFlow(content)` → `false`.

**Regression signal:** TS `import type` (common in every TS codebase) would trigger unnecessary Flow stripping.


### 20.9 — Full stripping via `flow-remove-types`

**What it tests:** `stripFlowTypes` successfully removes all Flow annotations using `flow-remove-types`.

```js
// @flow
import typeof ActionSheetIOS from './ActionSheetIOS';
opaque type Token = string;
function greet(name: string): void {
  console.log(name);
}
type Props = $Exact<{ name: string }>;
```

Expected: Output contains no Flow annotations. `import typeof` → `import`, type annotations → whitespace, `opaque type` → removed. The resulting code is valid JavaScript that esbuild can parse.


### 20.10 — Regex fallback handles `import typeof`

**What it tests:** When `flow-remove-types` is unavailable, the regex fallback still handles the most common failure case.

Input: `import typeof Foo from './Foo';`
Expected output: `import        Foo from './Foo';` (typeof replaced with spaces, preserving column positions).


### 20.11 — `maybeStripFlow` conditional processing

**What it tests:** `maybeStripFlow` only runs the stripping logic when Flow is detected. Non-Flow content passes through as the original `Uint8Array`.

Expected: Non-Flow → `{ contents: Uint8Array, wasStripped: false }`. Flow → `{ contents: string, wasStripped: true }`.


### 20.12 — PackagePlugin strips Flow from CDN content

**What it tests:** End-to-end: a Flow-annotated file fetched from a CDN is stripped before esbuild parses it.

```
GET https://esm.sh/react-native@0.74.0/index.js
→ Response contains `import typeof ...`
→ PackagePlugin.onLoad (HTTP namespace) calls maybeStripFlow({ url: "https://esm.sh/react-native@0.74.0/index.js" })
→ Flow detected (URL heuristic) and stripped
→ Clean JS returned to esbuild
```

**Regression signal:** `Unexpected "typeof"` error from esbuild when bundling react-native.


### 20.13 — PackagePlugin strips Flow from tarball-extracted content

**What it tests:** Flow annotations in files extracted from tarballs (via TarballPlugin → VFS) are stripped by PackagePlugin's `onLoad` handler for the VFS namespace.

Expected: `maybeStripFlow` is called in PackagePlugin's VFS `onLoad`, Flow content from tarball-extracted `.js` files is cleaned before esbuild receives it.


### 20.14 — Lazy loading of `flow-remove-types`

**What it tests:** `flow-remove-types` is not imported until the first Flow file is encountered.

Expected: If no Flow files are processed during a build, `flow-remove-types` is never loaded. On first Flow file, the import occurs. Subsequent Flow files use the cached reference.

**Regression signal:** Startup time regression if `flow-remove-types` is eagerly imported for every build.


### 20.15 — Block comment `@flow` pragma

**What it tests:** `/* @flow */` block comment pragma is detected, not just `// @flow` line comments.

```js
/* @flow */
import React from 'react';
```

Expected: `containsFlow(content)` → `true`.


### 20.16 — Flow + JSX co-occurrence

**What it tests:** A file with both Flow annotations and JSX syntax is handled correctly — Flow is stripped first, then JSX loader upgrade applies.

```js
// @flow
import React from 'react';
function App(props: { name: string }): React$Node {
  return <div>{props.name}</div>;
}
```

Expected: Flow stripping removes type annotations. The cleaned content still contains JSX (`<div>`), so `inferLoader` upgrades the loader to `tsx`. esbuild parses successfully.

**Regression signal:** If Flow stripping or JSX detection order is wrong, either Flow annotations break parsing or JSX is missed.


### 20.17 — Source map generated when sourcemaps enabled

**What it tests:** When `build.initialOptions.sourcemap` is truthy, `maybeStripFlow()` produces an inline `//# sourceMappingURL=data:...` comment in the returned contents that maps the stripped code back to the original Flow source.

```js
// @flow
import typeof ActionSheetIOS from './ActionSheetIOS';
function greet(name: string): string { return name; }
```

Expected: When `sourceMap: true` is passed, the returned `.contents` string ends with `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,<payload>`. Decoding the payload yields a v3 source map with `version: 3`, `sources` containing the original URL, `sourcesContent` containing the original (pre-strip) source text, and non-empty `mappings`.

**Regression signal:** If the inline source map comment is missing or malformed, esbuild will not fold the Flow transformation map into the final bundle map, and devtools will show the stripped intermediate instead of the original Flow source.


### 20.18 — No source map when sourcemaps disabled

**What it tests:** When `build.initialOptions.sourcemap` is falsy (the default: `false`), `maybeStripFlow()` does **not** generate or embed a source map — zero additional overhead.

```js
// @flow
opaque type Token = string;
export const TOKEN: Token = 'abc';
```

Expected: When `sourceMap: false` (or omitted), the returned `.contents` string does **not** contain `//# sourceMappingURL`. The output is stripped code only.

**Regression signal:** An unconditional source map generation would add latency to every Flow-containing file even when the build doesn't produce maps.


### 20.19 — Regex fallback produces no source map

**What it tests:** When `flow-remove-types` is unavailable and the regex fallback is used, no source map is generated regardless of the `sourceMap` option.

```js
// @flow
import typeof Foo from './Foo';
```

Expected: If `flow-remove-types` throws (simulated), the regex fallback strips `typeof` and pragma. The returned result has no `sourceMap` field, and the `.contents` string has no `//# sourceMappingURL` comment.

**Regression signal:** Attempting to generate a source map from the regex fallback would be incorrect (no offset tracking) and would add complexity to what is meant to be a lightweight safety net.


### 20.20 — Source map contains original source content

**What it tests:** The generated source map includes `sourcesContent` with the original (pre-strip) Flow source and `sources` with the original file URL, so devtools can display the original code without fetching it.

```js
// @flow
import typeof Foo from './Foo';
type Props = $Exact<{ name: string }>;
```

Expected: The embedded map's `sourcesContent[0]` is the exact original source text (including Flow annotations). `sources[0]` is the URL/path passed as `sourceFileName` (e.g., `https://esm.sh/react-native@0.74.0/Libraries/ActionSheetIOS.js`).

**Regression signal:** If `sourcesContent` is missing, devtools may fail to show the original source. If `sources` has a generic name like `"source.js"`, devtools won't associate the map with the correct file.


## Reference

### Flow Language Specification

- **Flow documentation:** https://flow.org/en/docs/
- **Flow GitHub:** https://github.com/facebook/flow
- **`flow-remove-types` package:** https://github.com/facebook/flow/tree/main/packages/flow-remove-types
- **Hermes parser:** https://github.com/nicolo-ribaudo/hermes-parser-wasm (WASM build)

### Related Standards and Proposals

- **TC39 Type Annotations proposal (Stage 1):** https://github.com/tc39/proposal-type-annotations — if adopted, would make type annotations ignorable by JS engines, eliminating the need for stripping.
- **Node.js `--experimental-strip-types`:** https://nodejs.org/api/cli.html#--experimental-strip-types — Node.js 22+ can strip TypeScript types natively (via `amaro`/SWC). Does **not** support Flow.

### Related Scenarios

- **[Scenario 18 — JSX in `.js` Files](18-jsx-in-js-files.md):** Sister feature for the same ecosystem problem. Handles JSX syntax detection; Flow stripping handles type annotations. Both target React Native packages.
- **[Scenario 12 — Runtime Conditions](12-runtime-conditions.md):** The `react-native` runtime condition (12.6) routes resolution to React Native-specific entry points, which are the files most likely to contain Flow annotations.
- **[Scenario 19 — Registry Tarballs](19-registry-tarballs.md):** Tarballs extracted into VFS may contain Flow files. PackagePlugin's VFS `onLoad` handler strips Flow from tarball-extracted content (Scenario 20.13).
