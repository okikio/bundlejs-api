# Scenario 09 — Node.js Builtins and Polyfills

> Tests how bundlejs handles Node.js built-in modules (`fs`, `path`, `crypto`, etc.) and the `node:` prefix.


## 9.1 — Builtin exclusion (default behavior)

**What it tests:** With `polyfill: false` (the default), Node.js builtins are excluded from the bundle with an empty `export default {}`.

**Package:** Any package that imports Node.js builtins.

```
/?q=fs-extra@11.2.0
```

Expected: `fs-extra` imports `fs`, `path`, `os`, etc. With polyfill disabled (default), the ExternalPlugin catches these before CdnPlugin → returns empty modules → bundle size reflects only the non-builtin code.

**Regression signal:** If the resolver tries to fetch `fs` from npm (which does not exist) or errors out, the ExternalPlugin is not intercepting builtins.


## 9.2 — Builtin polyfill mode

**What it tests:** With `polyfill: true`, Node.js builtins are rewritten to browser polyfills.

```
/?q=fs-extra@11.2.0&polyfill
```

Expected: `import "fs"` → rewritten to `import "memfs"` → falls through to CdnPlugin → fetched from CDN. The bundle includes the polyfill code, increasing size significantly.

| Builtin | Polyfill |
|:--------|:---------|
| `fs` | `memfs` |
| `path` | `path-browserify` |
| `crypto` | `crypto-browserify` |
| `stream` | `stream-browserify` |
| `buffer` | `buffer` |
| `events` | `events` |

**Regression signal:** If the bundle size with `&polyfill` is the same as without, the polyfill rewriting is not working.


## 9.3 — `node:` prefix stripping

**What it tests:** The `node:` prefix (e.g., `import "node:fs"`) is stripped before matching against the builtin list.

**Package:** `@noble/hashes@1.7.1`

```json
{
  "browser": {
    "node:crypto": false
  }
}
```

Source code uses `import crypto from "node:crypto"`.

```
/?q=@noble/hashes@1.7.1
```

Expected: `"node:crypto"` → `node:` prefix stripped → matches builtin `"crypto"` → excluded (ExternalPlugin, default polyfill=false).

In the browser field context: the `"node:crypto": false` mapping explicitly excludes it. The ExternalPlugin handles the exclusion regardless of the browser field.

**Regression signal:** If `"node:crypto"` is not recognized as a builtin (treated as an npm package `node:crypto`), the `node:` prefix stripping is broken.


## 9.4 — Both `"fs"` and `"node:fs"` resolve to the same target

**What it tests:** Whether the import uses `"fs"` or `"node:fs"`, the result is the same.

```
/?q=events@3.3.0
```

The `events` package is both a Node.js builtin AND an npm package. The resolution depends on context:
- As a bare import in user code → ExternalPlugin catches it as a builtin → excluded (or polyfilled)
- If the user explicitly requests the npm package → CdnPlugin resolves it from CDN

```
/?q=events@3.3.0&polyfill
```

Expected with polyfill: `"events"` → polyfill mapping → `"events"` (builtins.ts maps it to itself, since the npm `events` package IS the polyfill) → CdnPlugin fetches it.

**Regression signal:** If `events` is excluded when polyfill is enabled (should be fetched as its own polyfill), the polyfill mapping for `events` is incorrect.


## 9.5 — Builtin inside CDN-fetched module

**What it tests:** When a CDN-fetched module imports a builtin, the ExternalPlugin still intercepts it.

**Package:** `axios@1.7.9`

```
/?q=axios@1.7.9
```

When axios code internally imports `"http"` or `"https"`:

Expected: goes through the plugin chain inside HttpResolution → the bare import `"http"` is delegated to CdnResolution → ExternalPlugin catches it → excluded (default) or polyfilled.

**Regression signal:** If the bundler tries to fetch `"http"` from the CDN (which may 404 or return a wrong package), the ExternalPlugin is not catching builtins inside transitive dependencies.


## 9.6 — Polyfill output format compatibility

**What it tests:** Polyfills work correctly across output formats (ESM, CJS, IIFE).

```
/?q=path@0.12.7&config={"esbuild":{"format":"cjs"}}
```

Expected: the `path-browserify` polyfill (or the npm `path` package) is bundled with CJS format. The output uses `module.exports` instead of `export`.

```
/?q=path@0.12.7&config={"esbuild":{"format":"iife"}}
```

Expected: IIFE format wraps the polyfill in an immediately-invoked function.

**Regression signal:** If format-specific output is broken for polyfills, the esbuild format option is not being passed through correctly.
