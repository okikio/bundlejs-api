# Scenario 18 — JSX in `.js` Files (React Native / Expo Ecosystem)

> Tests that `.js` files containing JSX syntax are correctly parsed by upgrading the esbuild loader from `ts` to `tsx` based on content detection.


## Background

In the React Native and Expo ecosystems, it is common for published npm packages to ship **`.js` files that contain JSX syntax**. This happens because:

1. **Metro bundler** (React Native's default bundler) treats all `.js` files as JSX-capable by default.
2. **Expo SDK packages** (e.g., `expo-sqlite`, `expo-asset`) are compiled from TypeScript but their `build/` output retains JSX in `.js` files.
3. **Babel with `@babel/preset-react`** is assumed as part of the Metro pipeline, so JSX in `.js` is the norm — not the exception.

esbuild's `ts` loader (which bundlejs uses for `.js` files) does **not** parse JSX. Only the `tsx` loader handles JSX. Without content-aware loader selection, these files produce parse errors like:

```
✘ [ERROR] Expected ">" but found "{"
    hooks.js:19:39:
      19 │ ...return <SQLiteProviderSuspense {...props}>{children}</SQLitePro...
         │                                   ^
```


## Why This Is Safe

Upgrading `ts` → `tsx` for `.js` files is safe because:

- **No TypeScript generics ambiguity**: `.js` files don't contain TypeScript type syntax like `fn<T>()`, which the `tsx` loader would misparse as JSX. The ambiguity only exists in `.ts` files.
- **No false-positive harm**: Even if the JSX detector has a false positive (e.g., `</` in a template literal), the `tsx` loader parses the file correctly — it won't try to interpret string contents as JSX.
- **Restricted scope**: Only files with extensions that map to the `ts` loader (`.js`, `.mjs`, `.cjs`) are candidates for upgrade. Actual `.ts` files are left alone.


## Detection Strategy

The `containsJSX` function uses a byte-level scan for the sequence `</` followed by an ASCII letter (`A-Z`, `a-z`) or `>`. This matches:

- **Closing JSX tags**: `</div>`, `</Component>`, `</SQLiteProvider>`
- **JSX fragment closings**: `</>`

This pattern has near-zero false positives in non-JSX JavaScript because `</[A-Za-z]` does not appear in normal JS syntax. The only theoretical false positive is `</` inside a string or template literal, which is harmless (see "Why This Is Safe" above).

For `Uint8Array` input, the scan operates directly on bytes without decoding to string, keeping overhead minimal.

```
  Byte scan pattern:
  ┌──────┬──────┬──────────────────────┐
  │ 0x3C │ 0x2F │ 0x41–5A / 61–7A / 3E │
  │  <   │  /   │  A-Z  /  a-z  /  >   │
  └──────┴──────┴──────────────────────┘
```


---

## Scenarios


### 18.1 — JSX in `.js` file gets `tsx` loader

**What it tests:** A `.js` file with JSX closing tags triggers `containsJSX` → loader upgraded to `tsx`.

```js
// hooks.js — shipped by expo-sqlite
import React from 'react';
const App = () => <div>{children}</div>;
export default App;
```

Expected: `inferLoader("hooks.js", null, content)` → `"tsx"` (not `"ts"`).

**Regression signal:** esbuild parse error: `Expected ">" but found "{"`.


### 18.2 — JSX in `.mjs` file gets `tsx` loader

**What it tests:** `.mjs` with JSX content is also upgraded.

```js
// component.mjs
export const Greeting = ({ name }) => <h1>Hello {name}</h1>;
```

Expected: `inferLoader("component.mjs", null, content)` → `"tsx"`.


### 18.3 — JSX in `.cjs` file gets `tsx` loader

**What it tests:** `.cjs` with JSX content is also upgraded.

Expected: `inferLoader("component.cjs", null, content)` → `"tsx"`.


### 18.4 — Plain `.js` without JSX stays `ts`

**What it tests:** A `.js` file without JSX is not upgraded.

```js
// utils.js
export const add = (a, b) => a + b;
```

Expected: `inferLoader("utils.js", null, content)` → `"ts"`.

**Regression signal:** If all `.js` files get `tsx`, TypeScript generics in transpiled output could break (unlikely for `.js`, but the principle matters).


### 18.5 — `.jsx` stays `tsx` regardless of content

**What it tests:** Files with explicit `.jsx` extension already get `tsx` — no regression.

Expected: `inferLoader("file.jsx")` → `"tsx"` (unchanged).


### 18.6 — `.ts` stays `ts` even with JSX-like content

**What it tests:** Actual `.ts` files should NEVER be upgraded to `tsx`. TypeScript generics like `Array<T>` would be misparsed as JSX.

```ts
// generic.ts — contains </T> which looks like a closing tag
const fn = <T>(x: T): Array<T> => [x];
```

Expected: `inferLoader("generic.ts", null, content)` → `"ts"`.

**Regression signal:** TypeScript generic code breaks with parse errors about unclosed JSX tags.


### 18.7 — JSX fragment syntax detected

**What it tests:** JSX fragments (`<>...</>`) trigger detection via the `</>` pattern.

```js
// fragment.js
const Fragment = () => <><span>a</span></>;
```

Expected: `containsJSX(content)` → `true`, loader → `"tsx"`.


### 18.8 — Content with `</` in string does not cause harm

**What it tests:** False positive from `</` inside a template literal. The `tsx` loader still parses correctly.

```js
// template.js
const html = `<div></div>`;
export default html;
```

Expected: `containsJSX(content)` → `true` (false positive), `inferLoader` → `"tsx"`. But the file parses correctly because esbuild doesn't interpret strings as JSX.


### 18.8a — Content with `</` in comments does not cause harm

**What it tests:** False positive from `</tag>` inside a JS comment (line or block). The `tsx` loader still parses correctly because esbuild ignores comment contents.

The same logic as 18.8 applies: `containsJSX` does not distinguish between code, strings, and comments. Any occurrence of `</[A-Za-z>]` triggers detection. This is by design — stripping comments before scanning would add parsing complexity for zero practical benefit.

```js
// layout.js — only comments mention JSX
// See </div> for layout info
export const layout = "flex";
```

```js
// mod.js — block comment with closing tag
/* Renders </Component> internally */
module.exports = {};
```

Expected: `containsJSX(content)` → `true` (false positive), `inferLoader` → `"tsx"`. File parses correctly under the `tsx` loader.

**Why not strip comments first?** Stripping comments requires a partial parse — essentially what we're trying to avoid. The cost of the false positive (using `tsx` instead of `ts` loader) is zero because `tsx` is a strict superset of `ts` for `.js` files (no TypeScript generics ambiguity).


### 18.9 — Uint8Array content detection

**What it tests:** `containsJSX` works on raw `Uint8Array` input (byte-level scan without string decoding).

Expected: Same detection results as string input.


### 18.10 — Content-less call preserves original behavior

**What it tests:** `inferLoader` without content argument behaves identically to before — no regression.

Expected: `inferLoader("file.js")` → `"ts"`, `inferLoader("file.jsx")` → `"tsx"`, etc.


### 18.11 — Real-world: expo-sqlite hooks.js

**What it tests:** Integration test — the actual expo-sqlite hooks.js file (which contains JSX like `<SQLiteProvider>`) parses successfully through the build pipeline.

```
export { openDatabaseSync } from "expo-sqlite";
```

Expected: Build succeeds (may have other errors from React Native deps, but no JSX parse error from hooks.js).

**Regression signal:** `Expected ">" but found "{"` error on the hooks.js file.
