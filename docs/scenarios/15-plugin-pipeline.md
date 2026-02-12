# Scenario 15 — Plugin Pipeline Correctness

## What this covers

The bundlejs esbuild pipeline registers **six plugins in a fixed order**:

```
AliasPlugin → ExternalPlugin → TarballPlugin → VFSPlugin → HttpPlugin → CdnPlugin
```

Registration order is load-bearing: esbuild calls `onResolve` / `onLoad` handlers
in registration order, and the **first handler to return a result wins**. This
document explains the key invariants each plugin must uphold and how they interact.

## Plugin responsibilities

| Plugin | Namespace | Core job |
|---|---|---|
| **AliasPlugin** | `alias-globals` | Rewrites import paths before any other resolution. Strips `node:` prefix, checks `isAlias()`. |
| **ExternalPlugin** | `external-globals` | Marks Node.js builtins as external (empty export) or redirects to polyfills when `polyfill: true`. |
| **TarballPlugin** | `tarball-url` | Detects and extracts tarball archives (HTTP URLs, VFS paths) via `archive-detect` delegation. Handles pkg.pr.new, registry tarballs, GitHub releases, and VFS `.tgz` files. Must run before VFS. |
| **VFSPlugin** | `virtual-filesystem` | Serves in-memory files (entry points, user code). Scoped handlers prevent accidental VFS intercepts of HTTP-relative imports. |
| **HttpPlugin** | `http-url` | Fetches HTTP URLs, probes extensions, applies browser-field / manifest remapping on relative imports. |
| **CdnPlugin** | `cdn-url` | Catch-all for bare npm imports. Resolves versions, fetches package.json, computes entry point, and hands off to HttpPlugin. |

## Key invariants tested

### 1. Extension probing (`AllEndingVariants`)

`HttpPlugin` tries 18 path+extension combinations when probing for a file on a CDN.
The variants are the cross-product of `FilePaths = ["", "/index"]` and
`FileEndings = ["", ".js", ".mjs", ".ts", ".tsx", ".cjs", ".jsx", ".mts", ".cts"]`.
The **first variant is `""`** — exact match — so we never probe unnecessarily.

### 2. External package detection

`isExternal(id, customExternals)` normalizes `node:` prefixes, matches exact names,
and supports subpath matching (`fs/promises` → `fs`). Custom externals follow the
same rules. The function returns the **matched pattern**, not the input — so
`isExternal("node:fs/promises")` returns `"fs"`, not `"node:fs/promises"`.

`ExternalPackages` includes all Node.js builtins **plus** deprecated APIs
(`v8/tools/codemap`, `_http_agent`, etc.).

### 3. Polyfill map shape

`PolyfillMap` maps each builtin to a browser-compatible npm package:
- `path` → `path-browserify`
- `buffer` → `buffer`
- `events` → `events`
- `crypto` → `crypto-browserify`

When `polyfill: true`, builtins route through `CdnResolution` with the polyfill
package name instead of returning an empty export.

### 4. Alias guard (`isAlias`)

The guard rejects:
- **Relative paths** (`./ ../`) — returns `false` immediately
- **URLs** — parsed by `parsePackageName`, which won't match alias keys

The guard allows:
- **Bare imports** (`react`, `@scope/pkg`)
- **`node:` prefixed** — stripped before matching (`node:fs` → checks `fs`)
- **`#` imports** — pass through to alias lookup
- **JSR specs** (`jsr:@std/path`) — pass through (but `parsePackageName` extracts a non-matching name, so they typically return `undefined`)

**Edge case:** `isAlias("", ...)` throws because `parsePackageName("")` rejects empty strings.

### 5. VFS namespace scoping

The VFS plugin registers three handlers with different filters:

1. **VFS-prefixed paths** (`vfs:|virtual:`) — matches from **any** namespace
2. **Absolute paths** (`/`) — matches from **any** namespace  
3. **Relative paths** (`./|../`) — matches from **VFS namespace only**

Handler 3's namespace scoping is critical: without it, relative imports inside
HTTP-fetched modules would incorrectly match VFS instead of resolving against
the CDN URL. This is the boundary between "user code" and "CDN code".

### 6. Tarball entry resolution

`resolvePackageEntry` (tar.ts version) follows this fallback chain:
1. Modern `exports` field (via `resolve.exports`)
2. Require fallback (retry with `require: true` conditions)
3. Legacy fields (`browser` → `module` → `main` → `unpkg` → `bin`)
4. Direct subpath (if one was requested)
5. `/index.js` (last resort)

### 7. `pluginData` contract

Plugins communicate via the `pluginData` object on resolve/load results:

| Field | Set by | Used by | Purpose |
|---|---|---|---|
| `url` | HttpPlugin (onLoad) | HttpPlugin (onResolve) | Base for relative import resolution (post-redirect URL) |
| `manifest` | CdnPlugin | HttpPlugin | Package.json for browser-field remapping |
| `packageBaseUrl` | CdnPlugin | HttpPlugin | Strip prefix to get package-relative path for remapping |

### 8. CDN style routing

`getCDNStyle()` classifies URLs into routing categories:

| Input pattern | Style | Plugin |
|---|---|---|
| `https://unpkg.com/...` | `npm` | HttpPlugin |
| `https://pkg.pr.new/...` | `tarball` | TarballPlugin |
| `jsr:@std/...` | `jsr` | CdnPlugin (JSR path) |
| `github:user/repo` | `github` | HttpPlugin |
| `react` (bare import) | `other` | CdnPlugin |

## Integration test scenarios

| Scenario | What it validates |
|---|---|
| VFS → CDN handoff | Bare import in VFS entry routes through CdnPlugin |
| VFS-only build | No network when code has no external imports |
| Builtin exclusion | `import 'fs'` → empty export, no errors |
| `node:` prefix handling | `import 'node:path'` → excluded correctly |
| Alias rewrite | `alias: { react: "preact" }` → preact fetched from CDN |
| Polyfill mode | `polyfill: true` + `import 'path'` → real code from `path-browserify` |
| Browser field remapping | `@exodus/bytes` resolves browser-specific relative imports |
| Conditional exports | preact ESM, solid-js nested conditions |
| Tree-shaking | rxjs barrel vs single export — significant size reduction |
| JSR resolution | `jsr:@std/path@1.0.0` bundles correctly |
| Tarball extraction | `pkg.pr.new` URL → TarballPlugin → working bundle |
| Platform-specific | browser vs node conditions produce valid builds |
| CJS / IIFE format | Output contains expected format wrappers |
| VFS state isolation | Separate `buildWithEntry` calls don't leak state |

## Test file

[`core/tests/15-plugin-pipeline.test.ts`](../../core/tests/15-plugin-pipeline.test.ts)
— 110 tests covering unit, behavioral, and integration layers.
