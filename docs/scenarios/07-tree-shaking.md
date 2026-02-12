# Scenario 07 — Tree-Shaking and Side Effects

> Tests how bundlejs reads the `sideEffects` field and passes it to esbuild for dead code elimination.

Tree-shaking removes unused exports from the bundle. The `sideEffects` field ([webpack convention](https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free)) tells bundlers which files are safe to discard when their exports are unused. Without it, the bundler conservatively keeps everything.


## 7.1 — `sideEffects: false` (entire package is tree-shakeable)

**What it tests:** The bundler aggressively removes all unused modules from the package.

**Package:** `lodash-es@4.17.21`

```json
{
  "sideEffects": false,
  "module": "lodash.js",
  "type": "module"
}
```

**Full import (no tree-shaking):**

```
/?q=lodash-es@4.17.21
```

Expected: large bundle (entire lodash included).

**Selective import (tree-shaking active):**

```
/?q=lodash-es@4.17.21&treeshake=[{debounce}]
```

Expected: dramatically smaller bundle — only `debounce` and its dependencies are included. The size difference should be 10× or more.

**Regression signal:** If the tree-shaken bundle is close to the full bundle size, `sideEffects: false` is not being passed to esbuild, or `treeshake` parameter parsing is broken.


## 7.2 — `sideEffects` with glob patterns

**What it tests:** Only files matching the glob pattern are treated as having side effects; everything else is tree-shakeable.

**Package:** `three@0.171.0`

```json
{
  "sideEffects": ["./src/nodes/**/*"]
}
```

Expected: files under `src/nodes/` are retained even when their exports are unused. All other files are tree-shakeable.

The glob pattern `./src/nodes/**/*` should be normalized and matched against resolved file paths. `computeEsbuildSideEffects()` in `side-effects.ts` handles this.

**Regression signal:** If the bundler treats the entire package as side-effect-free (incorrect — `src/nodes/` should be kept), glob matching is broken. If it treats the entire package as having side effects (incorrect — only `src/nodes/` should), the glob is not being applied at all.


## 7.3 — Extension-based glob pattern

**What it tests:** A glob pattern that matches by file extension.

```json
{
  "sideEffects": ["*.css"]
}
```

Expected: `.css` files are retained (they apply styles as a side effect). JS/TS files are tree-shakeable.

**Implementation note:** bundlejs normalizes `*.css` to `**/*.css` to match files at any depth. Only JS-like files (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.mts`, `.cts`, or no extension) have `sideEffects: false` applied. CSS files are intentionally excluded from the optimization — marking CSS as side-effect-free is a common footgun.

**Regression signal:** If CSS files disappear from the bundle when `sideEffects: ["*.css"]` is set, the CSS exclusion from `sideEffects: false` application is broken.


## 7.4 — Explicit file list in `sideEffects`

**What it tests:** Exact file paths in the `sideEffects` array.

**Package:** `react-native-reanimated@3.16.7`

```json
{
  "sideEffects": [
    "./lib/module/layoutReanimation/animationsManager.js",
    "./lib/module/core.js",
    "./lib/module/initializers.js",
    "./lib/module/index.js"
  ]
}
```

Expected: exactly these four files are flagged as having side effects. All other files in the package are tree-shakeable.

**Regression signal:** If the file list is not matched (all files treated as side-effect-free or all as having effects), exact-path matching is broken.


## 7.5 — No `sideEffects` field (conservative default)

**What it tests:** When `sideEffects` is absent, the bundler assumes *all* files have side effects.

**Package:** `moment@2.30.1`

```json
{
  "name": "moment",
  "main": "./moment.js"
}
```

```
/?q=moment@2.30.1&treeshake=[{format}]
```

Expected: even though only `format` is imported, the bundle cannot aggressively tree-shake because `sideEffects` is not declared. The bundle size should be close to the full bundle.

**Regression signal:** If the bundle is dramatically smaller, the resolver is applying `sideEffects: false` by default (it should not).


## 7.6 — `sideEffects` interacts with conditional exports

**What it tests:** The `sideEffects` value is resolved from the correct manifest and applied to the condition-resolvedentry point.

**Package:** `solid-js@1.9.4`

```json
{
  "sideEffects": false,
  "exports": {
    ".": {
      "browser": { "import": "./dist/solid.js" },
      "import": "./dist/solid.js"
    }
  }
}
```

```
/?q=solid-js@1.9.4&treeshake=[{createSignal}]
```

Expected: `sideEffects: false` + tree-shaking → only `createSignal` and its dependencies included. The `exports` resolution finds the entry, and the `sideEffects` flag lets esbuild eliminate everything else.

**Regression signal:** If tree-shaking does not work despite `sideEffects: false` being present, the side-effects metadata is not being propagated through the `onResolve` return value.


## 7.7 — Side effects only applied to JS-like files

**What it tests:** The `sideEffects: false` optimization is only applied to JavaScript/TypeScript files, not CSS or other assets.

When a package has `sideEffects: false` and includes CSS imports:

```javascript
import "./styles.css";        // This CSS MUST be kept (side-effectful)
import { utils } from "./utils.js";  // This CAN be tree-shaken
```

Expected: `styles.css` is retained in the bundle even though `sideEffects: false` is set. The CSS file is excluded from the optimization because CSS must execute (apply styles) to work.

**Regression signal:** If CSS imports disappear from the bundle when the package has `sideEffects: false`, the JS-only filtering is broken.
