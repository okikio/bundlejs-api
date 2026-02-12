# Scenario 01 — Conditional Exports

> Tests the modern `exports` field with nested conditions, multiple subpaths, and platform-specific branching.

The `exports` field ([Node.js docs: conditional exports](https://nodejs.org/api/packages.html#conditional-exports)) is the primary resolution mechanism for modern packages. Each key is a *subpath* (like `"."` or `"./utils"`), and each value is either a file path or a nested object whose keys are *conditions*. The runtime walks conditions in definition order and picks the **first match**.

bundlejs uses the [`resolve.exports`](https://www.npmjs.com/package/resolve.exports) library to implement the full algorithm, including nested conditions, pattern matching, and `null` exclusions.


## 1.1 — Simple conditional exports (browser vs node)

**What it tests:** The resolver picks the correct entry from a flat condition map based on platform.

**Package:** `preact@10.25.4`

```json
{
  "exports": {
    ".": {
      "types": "./src/index.d.ts",
      "import": "./dist/preact.mjs",
      "browser": "./dist/preact.module.js",
      "require": "./dist/preact.js"
    }
  }
}
```

**Default browser build:**

```
/?q=preact@10.25.4
```

Expected resolution: conditions `["import", "browser", "module", "default"]` → `"browser"` matches first → `./dist/preact.module.js`.

**Node build:**

```
/?q=preact@10.25.4&config={"esbuild":{"platform":"node"}}
```

Expected resolution: conditions `["import", "node", "module", "default"]` → no `"browser"` condition → `"import"` matches → `./dist/preact.mjs`.

**Regression signal:** If the browser build loads `preact.mjs` instead of `preact.module.js`, condition ordering is broken. If the node build loads `preact.module.js`, the `"browser"` condition is leaking into non-browser platforms.


## 1.2 — Deeply nested conditions

**What it tests:** Three levels of nesting — the resolver walks `".".browser.development.import` correctly.

**Package:** `solid-js@1.9.4`

```json
{
  "exports": {
    ".": {
      "deno": { "import": "./dist/server.js", "require": "./dist/server.cjs" },
      "node": { "import": "./dist/server.js", "require": "./dist/server.cjs" },
      "worker": { "import": "./dist/server.js", "require": "./dist/server.cjs" },
      "browser": {
        "development": {
          "import": "./dist/dev.js",
          "require": "./dist/dev.cjs"
        },
        "import": "./dist/solid.js",
        "require": "./dist/solid.cjs"
      },
      "import": "./dist/solid.js",
      "require": "./dist/solid.cjs"
    }
  }
}
```

**Browser build (production):**

```
/?q=solid-js@1.9.4
```

Expected: `"browser"` matches → inner object → `"development"` is NOT active by default → `"import"` matches → `./dist/solid.js`.

**Browser build with development condition:**

```
/?q=solid-js@1.9.4&config={"esbuild":{"conditions":["development"]}}
```

Expected: `"browser"` → `"development"` now active → `"import"` → `./dist/dev.js`.

**Deno build:**

```
/?q=solid-js@1.9.4&config={"resolve":{"runtime":"deno"}}
```

Expected: `"deno"` matches first → `"import"` → `./dist/server.js`. The `"browser"` branch is never entered.

**Regression signal:** If the deno build resolves to `./dist/solid.js`, the `"deno"` condition is being skipped. If the development-flagged browser build gets `./dist/solid.js` instead of `./dist/dev.js`, nested condition walking is broken.


## 1.3 — Node-specific condition nesting with CJS/ESM split

**What it tests:** The `require` vs `import` dimension inside a `node` condition block.

**Package:** `vue@3.5.13`

```json
{
  "exports": {
    ".": {
      "import": {
        "node": "./index.mjs",
        "types": "./dist/vue.d.mts",
        "default": "./dist/vue.runtime.esm-bundler.js"
      },
      "require": {
        "node": {
          "production": "./dist/vue.cjs.prod.js",
          "development": "./dist/vue.cjs.js",
          "default": "./index.js"
        },
        "types": "./dist/vue.d.ts",
        "default": "./index.js"
      }
    }
  }
}
```

**Browser ESM build:**

```
/?q=vue@3.5.13
```

Expected: `"import"` matches → inner object → no `"node"` condition → `"default"` → `./dist/vue.runtime.esm-bundler.js`.

**Node ESM build:**

```
/?q=vue@3.5.13&config={"esbuild":{"platform":"node"}}
```

Expected: `"import"` → inner object → `"node"` matches → `./index.mjs`.

**Node CJS build:**

```
/?q=vue@3.5.13&config={"esbuild":{"platform":"node","format":"cjs"}}
```

Expected: `"require"` matches → inner object → `"node"` → inner object → `"default"` → `./index.js`.

**Regression signal:** If the browser build gets `./index.mjs`, the `"node"` condition leaked. If CJS node build gets the ESM path, the `import`/`require` dimension is not computed from format correctly.


## 1.4 — 2×2 matrix: format × platform

**What it tests:** A package with four distinct builds — CJS-node, ESM-node, CJS-browser, ESM-browser. The resolver must pick the right quadrant.

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

| API URL | Expected entry |
|:--------|:---------------|
| `/?q=uuid@11.0.5` (browser ESM) | `./dist/esm-browser/index.js` |
| `/?q=uuid@11.0.5&config={"esbuild":{"platform":"node"}}` | `./dist/esm/index.js` |
| `/?q=uuid@11.0.5&config={"esbuild":{"platform":"node","format":"cjs"}}` | `./dist/cjs/index.js` |
| `/?q=uuid@11.0.5&config={"esbuild":{"platform":"browser","format":"cjs"}}` | `./dist/cjs-browser/index.js` |

**Regression signal:** Any cell in the 2×2 matrix resolving to the wrong quadrant means the `import`/`require` × `browser`/`node` dimensions are not being composed correctly.


## 1.5 — Single-string exports

**What it tests:** The `exports` field as a plain string (no conditions) — the simplest case.

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

Expected: `exports` is a string → resolve directly to `./source/index.js`. No condition walking needed.

**Regression signal:** If this fails, the resolver cannot handle the degenerate case of a non-object `exports` value.


## 1.6 — Exports with array fallbacks

**What it tests:** Array entries in `exports` — the resolver picks the first matching element.

**Package:** `yargs@17.7.2`

```json
{
  "exports": {
    ".": [
      { "import": "./index.mjs", "require": "./index.cjs" },
      "./index.cjs"
    ],
    "./yargs": [
      { "import": "./yargs.mjs", "require": "./yargs" },
      "./yargs"
    ]
  }
}
```

```
/?q=yargs@17.7.2
```

Expected: first array element is tried → `"import"` matches → `./index.mjs`. The string fallback `"./index.cjs"` is only used if no conditions match the object.

**Regression signal:** If the resolver returns `./index.cjs` for an ESM build, it skipped the conditional object and went straight to the fallback string.


## 1.7 — `exports` with explicit `null` exclusion

**What it tests:** A subpath that maps to `null` produces a hard resolution error, not a fallback.

> **Spec note:** When `exports` maps a subpath to `null`, Node.js treats it as **explicitly excluded** — `import "pkg/internal"` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Bundlers should do the same.

Real-world packages rarely use `null` in exports. To test, construct a synthetic manifest:

```
/?q=my-pkg&config={"package.json":{"name":"my-pkg","version":"1.0.0","exports":{".":"./index.js","./internal":null}}}
```

With entry code: `export * from "my-pkg"; export * from "my-pkg/internal";`

Expected: `my-pkg` resolves normally. `my-pkg/internal` produces a resolution error.

**Regression signal:** If `my-pkg/internal` silently resolves (e.g., falls through to a literal path), the `null` exclusion is not being enforced.
