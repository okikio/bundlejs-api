# Scenario 10 — Dual Package Hazard, Format, and Platform Matrix

> Tests packages that ship both CJS and ESM, the `type: "module"` flag, and the interaction between `format` and `platform` settings.


## The Dual Package Hazard

> **Spec background:** The [dual package hazard](https://nodejs.org/api/packages.html#dual-package-hazard) occurs when the same package is loaded as *both* CJS and ESM within a single program — creating two separate module instances. This can break singletons, shared state, and `instanceof` checks. Modern packages mitigate this with conditional exports (`"import"` vs `"require"`) that point to distinct files.


## 10.1 — CJS vs ESM via conditional exports

**What it tests:** The resolver picks the correct file based on the `import` vs `require` context, determined by the `format` option.

**Package:** `uuid@11.0.5`

```json
{
  "exports": {
    ".": {
      "node": {
        "import": "./dist/esm/index.js",
        "require": "./dist/cjs/index.js"
      },
      "browser": {
        "import": "./dist/esm-browser/index.js",
        "require": "./dist/cjs-browser/index.js"
      },
      "default": "./dist/esm-browser/index.js"
    }
  }
}
```

| Config | Expected entry |
|:-------|:---------------|
| Browser + ESM (default) | `./dist/esm-browser/index.js` |
| Browser + CJS (`format:"cjs"`) | `./dist/cjs-browser/index.js` |
| Node + ESM (`platform:"node"`) | `./dist/esm/index.js` |
| Node + CJS (`platform:"node", format:"cjs"`) | `./dist/cjs/index.js` |

```
/?q=uuid@11.0.5&config={"esbuild":{"format":"cjs","platform":"node"}}
```

**Regression signal:** Any cell resolving to the wrong quadrant means the `import`/`require` dimension is not being computed correctly from `format`.


## 10.2 — `type: "module"` pure ESM package

**What it tests:** A package with `"type": "module"` and no CJS fallback.

**Package:** `chalk@5.4.1`

```json
{
  "type": "module",
  "exports": "./source/index.js"
}
```

```
/?q=chalk@5.4.1
```

Expected: ESM entry resolved. Since there is no `"require"` condition in exports, the compatibility fallback (`require: true` retry) should either succeed by treating the single string as universal, or accept the ESM path.

```
/?q=chalk@5.4.1&config={"esbuild":{"format":"cjs"}}
```

Expected: bundlejs uses `unsafe: true` and retries with `require: true` if ESM fails. The single-string exports `"./source/index.js"` should resolve regardless of format. The esbuild output wraps it in CJS format using `module.exports`.

**Regression signal:** If CJS format fails to resolve (error: no `require` condition), the compatibility fallback is broken.


## 10.3 — Legacy dual package (main + module)

**What it tests:** A package without `exports` that uses `main` for CJS and `module` for ESM.

**Package:** `events@3.3.0`

Actually, `events` only has `main`. Better example — synthetic:

```
/?q=test-dual&config={"package.json":{"name":"test-dual","version":"1.0.0","main":"./dist/cjs/index.js","module":"./dist/esm/index.js"}}
```

**Browser ESM (default):** Expected: `module` has higher priority than `main` for browser → `./dist/esm/index.js`.

**Browser CJS:** Legacy field priority: `browser` (missing) → `module` → `main`. The `module` field wins even in CJS context (this is a bundler convention — `module` is preferred for tree-shaking).

**Node ESM:** `module` → `main` → `./dist/esm/index.js`.

**Regression signal:** If `main` is always preferred over `module`, the legacy field priority is inverted.


## 10.4 — Output format affects esbuild wrapping

**What it tests:** Different `format` values produce structurally different output.

```
/?q=preact@10.25.4&config={"esbuild":{"format":"esm"}}
```

Expected output: `export { ... }` syntax.

```
/?q=preact@10.25.4&config={"esbuild":{"format":"cjs"}}
```

Expected output: `module.exports = { ... }` or `exports.xxx = ...` syntax.

```
/?q=preact@10.25.4&config={"esbuild":{"format":"iife"}}
```

Expected output: `(function() { ... })()` wrapper.

**Regression signal:** If all formats produce the same output structure, the `format` option is not being passed to esbuild.


## 10.5 — Platform affects define replacements

**What it tests:** The `define` configuration changes with platform, affecting dead code elimination.

bundlejs defines `"process.env.NODE_ENV": "\"production\""` and `"__NODE__": "false"` by default.

```
/?q=react@19.0.0
```

Expected: production defines → React's development-only code is eliminated → smaller bundle.

```
/?q=react@19.0.0&config={"esbuild":{"define":{"process.env.NODE_ENV":"\"development\""}}}
```

Expected: development defines → React includes development warnings, propType checks → larger bundle.

**Regression signal:** If the production and development bundles are the same size, `define` is not being applied or dead code elimination is not working.


## 10.6 — Target affects output syntax

**What it tests:** The `target` option affects which JavaScript syntax features are used in the output.

```
/?q=preact@10.25.4&config={"esbuild":{"target":["es2015"]}}
```

Expected: output uses ES2015 syntax (no optional chaining `?.`, no nullish coalescing `??`, template literals converted to concatenation in some cases).

```
/?q=preact@10.25.4&config={"esbuild":{"target":["esnext"]}}
```

Expected: output uses latest syntax (optional chaining, nullish coalescing, etc.). Should be smaller than es2015 output.

**Regression signal:** If both targets produce identical output, the `target` option is not being passed to esbuild.


## 10.7 — Minification toggle

**What it tests:** The `minify` option controls whether the output is minified.

```
/?q=preact@10.25.4&config={"esbuild":{"minify":false}}
```

Expected: unminified output with original variable names, whitespace, and comments. Larger uncompressed size.

```
/?q=preact@10.25.4
```

Expected: minified output (default `minify: true`). Shorter variable names, no whitespace. Smaller uncompressed size.

**Regression signal:** If both produce the same output, `minify` is not being passed to esbuild.
