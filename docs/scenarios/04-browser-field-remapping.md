# Scenario 04 — Browser Field Remapping

> Tests the `browser` field in its **object form** — a remapping layer that rewrites internal module paths for browser environments. This is distinct from the string form (which replaces the entry point).

The object-form browser field is one of npm's most inconsistent conventions. It was [defined by the bundler community](https://github.com/nicolo-ribaudo/tc39-proposal-pkgjson-exports/blob/main/PRIOR-ART.md#browser) (Browserify, webpack) and is applied as a post-resolution remapping layer.

Two things happen with the object form:
1. **Path remapping** — `"./lib/node.js"` → `"./lib/browser.js"` (swap implementation)
2. **Exclusion** — `"fs"` → `false` (exclude module entirely)


## 4.1 — Internal path remapping (Node → browser implementation)

**What it tests:** Relative paths inside a package are rewritten to browser-specific alternatives.

**Package:** `readable-stream@4.7.0`

```json
{
  "main": "./lib/ours/index.js",
  "browser": {
    "util": "./lib/ours/util.js",
    "./lib/ours/index.js": "./lib/ours/browser.js"
  }
}
```

**Browser build:**

```
/?q=readable-stream@4.7.0
```

Expected resolution:
1. No `exports` → legacy resolution → `main` is `./lib/ours/index.js`
2. `browser` is an object → it is a remapping layer, NOT an entry point
3. The remapping maps `./lib/ours/index.js` → `./lib/ours/browser.js`
4. Entry point becomes `./lib/ours/browser.js` after remapping

**Node build:**

```
/?q=readable-stream@4.7.0&config={"esbuild":{"platform":"node"}}
```

Expected: browser field ignored → `main` → `./lib/ours/index.js` (no remapping).

**Regression signal:** If the browser build loads `./lib/ours/index.js` (the Node entry), the entry-point remapping is not being applied. If it tries to use the object keys as entry points (a common bug), resolution is fundamentally broken.


## 4.2 — Bare module exclusion (`false` mapping)

**What it tests:** The browser field maps a bare module name to `false`, meaning "excluded for browser environments."

**Package:** `@noble/hashes@1.7.1`

```json
{
  "browser": {
    "./crypto": "./crypto.js",
    "node:crypto": false
  },
  "exports": {
    "./crypto": {
      "node": { "import": "./esm/cryptoNode.js", "default": "./cryptoNode.js" },
      "import": "./esm/crypto.js",
      "default": "./crypto.js"
    }
  }
}
```

> **Note:** This package has `exports`, so the `browser` field remapping only applies if the resolver specifically consults it for internal imports. The `exports` field handles the primary entry point resolution.

For a targeted test of `false` exclusion, use `axios`:

**Package:** `axios@1.7.9`

```json
{
  "main": "index.js",
  "browser": {
    "./lib/adapters/http.js": "./lib/helpers/null.js",
    "./lib/platform/node/index.js": "./lib/platform/browser/index.js",
    "./lib/platform/node/classes/FormData.js": "./lib/helpers/null.js"
  }
}
```

```
/?q=axios@1.7.9
```

Expected: When axios code internally imports `"./lib/platform/node/index.js"`, the browser field remaps it to `"./lib/platform/browser/index.js"`. The Node HTTP adapter goes to `./lib/helpers/null.js` (a stub). The bundle should contain browser platform code, not Node.js `http` module usage.

**Regression signal:** If the bundle contains references to Node.js `http`, `https`, or `node:` builtins from axios internals, the browser field remapping for internal paths is not being applied.


## 4.3 — Remapping with `./` prefix variants

**What it tests:** The browser field uses various path formats (`"./foo"`, `"foo"`, `"/foo"`) and the resolver must normalize and match them.

The `applyPathRemapping()` function in `cdn-resolution.ts` tries multiple path variants:
- `resolvedPath` (as-is)
- Without `./` prefix
- With `./` prefix added
- Without leading `/`

**Synthetic test:**

```json
{
  "browser": {
    "lib/node.js": "./lib/browser.js",
    "./utils/fs": false
  }
}
```

When internal code imports `"./lib/node.js"`, the resolver must match against the key `"lib/node.js"` (no `./` prefix) by trying the variant without `./`.

When internal code imports `"./utils/fs"`, it must match the key `"./utils/fs"` and return `false` (excluded).

**Regression signal:** If remappings only work when the import path exactly matches the key format (e.g., only `./`-prefixed or only bare), packages with mixed key formats break.


## 4.4 — Browser field with all-`false` mappings

**What it tests:** A browser field where EVERY value is `false` — the package is entirely excluded for browsers.

**Synthetic test:**

```
/?q=test-all-false&config={"package.json":{"name":"test-all-false","version":"1.0.0","main":"./index.js","browser":{"./index.js":false,"./lib/core.js":false}}}
```

Expected: The `browser` field object has all `false` values → `resolveLegacy()` detects this (`allFalse` check) → module is excluded with reason `"browser"`.

**Regression signal:** If the resolver falls through and returns `./index.js` anyway, the all-false exclusion check is broken.


## 4.5 — Browser field does NOT apply on non-browser platforms

**What it tests:** The browser field object remappings are ignored when the platform is `node` or `neutral`.

**Package:** `readable-stream@4.7.0`

```
/?q=readable-stream@4.7.0&config={"esbuild":{"platform":"node"}}
```

Expected: `browserField` is `false` → `resolveLegacy()` is called with `{ browser: false }` → remapping layer is skipped → entry is `./lib/ours/index.js` (from `main`).

```
/?q=readable-stream@4.7.0&config={"esbuild":{"platform":"neutral"}}
```

Expected: same — `neutral` does not enable browser field.

**Regression signal:** If the node build gets `./lib/ours/browser.js`, the browser field is leaking into non-browser builds.


## 4.6 — Edge runtimes: `browser` condition active but `browserField` disabled

**What it tests:** Cloudflare Workers and similar runtimes include `"browser"` in their exports conditions but do NOT apply the legacy `browser` field remappings.

This is a deliberate bundlejs design choice: edge runtimes want browser-optimized code paths from `exports` conditions, but should not get Node.js polyfill swaps from the legacy `browser` field.

```
/?q=readable-stream@4.7.0&config={"resolve":{"runtime":"workerd"}}
```

Expected: `getRuntimeDefaults("workerd")` returns `{ conditions: ["workerd", "worker", "browser"], browserField: false }`. The `"browser"` condition is present for `exports` resolution, but the `browser` field object remappings are NOT applied.

```
/?q=readable-stream@4.7.0&config={"resolve":{"runtime":"edge-light"}}
```

Expected: `getRuntimeDefaults("edge-light")` returns `{ conditions: ["edge-light", "worker", "browser"], browserField: true }`. Edge Light (Vercel Edge) DOES enable `browserField`.

**Regression signal:** If Cloudflare Workers builds get browser field remappings applied, the `browserField: false` override is not working. If Vercel Edge builds do NOT get remappings, the `browserField: true` setting is being ignored.


## 4.7 — Browser field remapping for relative imports (HttpPlugin)

**What it tests:** The HttpPlugin applies browser field remappings to relative imports *within* a package, not just at entry point resolution.

> **This is the scenario that caught the original bug.** The CdnPlugin resolved the entry point correctly, but relative imports inside the package were not being remapped.

**Package:** `@exodus/bytes@1.13.0`

```json
{
  "main": "./index.js",
  "browser": {
    "./fallback/platform.js": "./fallback/platform.browser.js",
    "./fallback/utf8.auto.js": "./fallback/utf8.auto.browser.js"
  }
}
```

```
/?q=@exodus/bytes@1.13.0
```

When `utf8.js` internally imports `"./fallback/platform.js"`:

1. CdnPlugin resolves the entry point (`./index.js` from `main`, since `browser` is an object)
2. CdnPlugin passes `packageBaseUrl` in `pluginData`
3. HttpPlugin resolves the relative import: `urlJoin(parentUrl, "../", "./fallback/platform.js")`
4. HttpPlugin strips `packageBaseUrl` → gets `"./fallback/platform.js"`
5. `applyManifestRemappings()` checks `browser` field → remaps to `"./fallback/platform.browser.js"`
6. URL is reconstructed with the remapped path

**Expected:** The final fetched URL is `https://unpkg.com/@exodus/bytes@1.13.0/fallback/platform.browser.js`, not `platform.js`.

**Regression signal:** If the bundle contains `platform.js` instead of `platform.browser.js`, relative import remapping is broken. This was the **exact bug** that prompted the remapping feature — logs showed `./fallback/platform.js` being fetched directly without the browser field being consulted.


## 4.8 — Browser field exclusion for relative imports

**What it tests:** When a browser field maps an internal relative import to `false`, the HttpPlugin returns an error.

**Synthetic test:** A package whose browser field excludes an internal file:

```json
{
  "browser": {
    "./lib/native-impl.js": false
  }
}
```

When internal code does `import impl from "./lib/native-impl.js"`:

Expected: `applyManifestRemappings()` returns `{ excluded: true, matchedField: "browser" }` → HttpPlugin returns an esbuild error: `"Module "./lib/native-impl.js" excluded by "browser" field"`.

**Regression signal:** If the excluded file is silently fetched (and probably 404s or returns wrong content), the `false` exclusion for relative imports is not being enforced.
