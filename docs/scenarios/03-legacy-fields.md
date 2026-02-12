# Scenario 03 — Legacy Field Resolution

> Tests packages without `exports` that rely on `main`, `module`, `browser` (string form), `unpkg`, `bin`, and `./index.js` fallback.

When a package has no `exports` field, bundlejs falls back to an older, less standardized resolution chain. Different bundlers disagree on the priority and semantics of these fields, so this area is rich with edge cases.

The legacy field priority in bundlejs (from `resolveLegacy()` in `cdn-resolution.ts`):

| Platform | Priority |
|:---------|:---------|
| browser | `browser` → `module` → `main` |
| node | `module` → `main` |
| neutral | `module` → `main` |

If *all* fields are missing: `unpkg` → `bin` → `./index.js`.


## 3.1 — Only `main` field

**What it tests:** The most basic resolution path — `main` is the only entry point field.

**Package:** `isarray@2.0.5`

```json
{
  "name": "isarray",
  "version": "2.0.5",
  "main": "index.js"
}
```

```
/?q=isarray@2.0.5
```

Expected: no `exports`, no `module`, no `browser` → falls to `main` → `./index.js`.

**Regression signal:** If this doesn't resolve, the most fundamental fallback chain is broken.


### 3.1a — Extensionless `main` field

**What it tests:** `main` without a `.js` extension — the resolver must append it.

**Package:** `ms@2.1.3`

```json
{
  "name": "ms",
  "version": "2.1.3",
  "main": "./index"
}
```

```
/?q=ms@2.1.3
```

Expected: `main` is `"./index"` (no extension) → resolver probes for `./index.js` (or the CDN serves it). The final URL should include the `.js` extension.

**Regression signal:** If the CDN 404s because the resolver sends a request for `./index` (without extension), the extensionless `main` field handling is broken.


## 3.2 — `module` field (ESM entry)

**What it tests:** The `module` field — a community convention for ESM entry points.

> **Background:** The `"module"` field was [proposed by Rollup](https://github.com/rollup/rollup/wiki/pkg.module) as a way for packages to expose ESM entry points alongside CJS `main`. Node.js never adopted it, but bundlers (webpack, Rollup, esbuild) all support it.

**Package:** `lodash-es@4.17.21`

```json
{
  "name": "lodash-es",
  "version": "4.17.21",
  "main": "lodash.js",
  "module": "lodash.js",
  "type": "module",
  "sideEffects": false
}
```

```
/?q=lodash-es@4.17.21
```

Expected: no `exports` → browser platform → field priority: `browser` (missing) → `module` → `"lodash.js"`.

**Note:** In this case `main` and `module` point to the same file, but the resolution *path* through the code differs. The resolver should check `module` before `main` for browser platform.

**Regression signal:** If `module` is being skipped and `main` is always preferred, ESM-aware packages lose their intended entry point.


## 3.3 — `browser` field (string form) as entry point

**What it tests:** The `browser` field as a plain string replaces the entry point entirely for browser builds.

**Package:** `signal-exit@4.1.0`

```json
{
  "main": "./dist/cjs/index.js",
  "module": "./dist/mjs/index.js",
  "browser": "./dist/mjs/browser.js",
  "exports": {
    ".": {
      "import": { "types": "./dist/mjs/index.d.ts", "default": "./dist/mjs/index.js" },
      "require": { "types": "./dist/cjs/index.d.ts", "default": "./dist/cjs/index.js" }
    }
  }
}
```

> **Note:** `signal-exit` has both `exports` AND legacy fields. Since `exports` exists, modern resolution takes precedence. To test the string-form `browser` field in isolation, use a package without `exports`, or construct a synthetic manifest.

**Synthetic test:**

```
/?q=my-signal-exit&config={"package.json":{"dependencies":{"my-signal-exit":"npm:signal-exit@4.1.0"}}}&treeshake=[*]
```

Or synthesize the manifest directly:

```
/?q=test-pkg&config={"package.json":{"name":"test-pkg","version":"1.0.0","main":"./dist/cjs/index.js","module":"./dist/mjs/index.js","browser":"./dist/mjs/browser.js"}}
```

**Browser build:** Expected entry: `./dist/mjs/browser.js` (string browser field takes priority).

**Node build:** Expected entry: `./dist/mjs/index.js` (browser field ignored, `module` wins).

**Regression signal:** If the browser build loads `./dist/mjs/index.js` instead of `./dist/mjs/browser.js`, the string-form browser field is being ignored.


## 3.4 — No entry point fields at all

**What it tests:** The last-resort fallback chain when no `main`, `module`, or `browser` exist.

**Synthetic test:**

```
/?q=test-bare&config={"package.json":{"name":"test-bare","version":"1.0.0"}}
```

Expected: no `exports`, no `main`, no `module`, no `browser` → try `unpkg` (missing) → try `bin` (missing) → last resort: `./index.js`.

**Regression signal:** If the resolver errors out instead of trying `./index.js`, the last-resort fallback is missing.


## 3.5 — `unpkg` and `jsdelivr` CDN fields

**What it tests:** CDN-specific entry point fields that serve as last-resort fallbacks.

**Package:** `vue@3.5.13`

```json
{
  "unpkg": "dist/vue.global.js",
  "jsdelivr": "dist/vue.global.js",
  "main": "index.js",
  "module": "dist/vue.runtime.esm-bundler.js",
  "exports": { /* complex conditional */ }
}
```

Vue has `exports`, so for normal resolution the `unpkg` field is never consulted. But test the fallback path with a synthetic manifest:

```
/?q=test-cdn-fields&config={"package.json":{"name":"test-cdn-fields","version":"1.0.0","unpkg":"dist/global.js"}}
```

Expected: no `main`, no `module`, no `browser` → falls to `unpkg` → `./dist/global.js`.

**Regression signal:** If the resolver skips straight to `./index.js` without checking `unpkg`, the CDN field fallback is missing.


## 3.6 — `type: "module"` affects `main` field behavior

**What it tests:** When `"type": "module"` is set, the `main` field points to an ESM file. The resolver should not treat it as CJS.

> **Spec background:** Node.js uses `"type": "module"` in `package.json` to declare that `.js` files in the package are ESM, not CJS. This affects how the `main` field is interpreted — `main` can now point to an ESM entry.

**Package:** `chalk@5.4.1`

```json
{
  "type": "module",
  "exports": "./source/index.js"
}
```

Since chalk has `exports`, `type` does not affect resolution. But for the general case, construct:

```
/?q=test-esm-main&config={"package.json":{"name":"test-esm-main","version":"1.0.0","type":"module","main":"./index.js"}}
```

Expected: `main` resolves to `./index.js`, and the loader should treat it as ESM (`.js` + `type: "module"`).

**Regression signal:** If the file is loaded with a CJS loader, `type: "module"` is being ignored.


## 3.7 — `jsnext:main` (extremely legacy)

**What it tests:** The `jsnext:main` field — a predecessor to `module`, rarely seen in modern packages.

**Package:** `moment@2.30.1`

```json
{
  "name": "moment",
  "main": "./moment.js",
  "jsnext:main": "./dist/moment.js"
}
```

```
/?q=moment@2.30.1
```

Expected: bundlejs does **not** recognize `jsnext:main` (esbuild also ignores it). Resolution falls to `main` → `./moment.js`.

> **Note:** This is a known limitation, not a bug — `jsnext:main` was never standardized and only a handful of packages use it. The `module` field superseded it.

**Regression signal:** If this somehow resolves to `./dist/moment.js`, the resolver is reading a field it should not be checking.


## 3.8 — Dual CJS/ESM via `exports` (modern) vs legacy fields

**What it tests:** When both `exports` and legacy fields exist, `exports` takes absolute precedence. The legacy fields are ignored even if they point to different files.

**Package:** `signal-exit@4.1.0`

```json
{
  "main": "./dist/cjs/index.js",
  "module": "./dist/mjs/index.js",
  "browser": "./dist/mjs/browser.js",
  "exports": {
    ".": {
      "import": { "default": "./dist/mjs/index.js" },
      "require": { "default": "./dist/cjs/index.js" }
    }
  }
}
```

```
/?q=signal-exit@4.1.0
```

Expected: `exports` exists → modern resolution → `"import"` → `./dist/mjs/index.js`. The `browser` field (`./dist/mjs/browser.js`) is **not** consulted because `exports` takes precedence.

**Regression signal:** If the resolver returns `./dist/mjs/browser.js`, it is falling through to legacy resolution even though `exports` exists and resolves successfully.
