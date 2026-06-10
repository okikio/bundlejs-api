# Scenario 15 — Plugin Pipeline Correctness

## What this covers

The bundlejs esbuild pipeline registers **seven plugins in a fixed order**:

```
AliasPlugin → ExternalPlugin → TarballPlugin → PackagePlugin → VFSPlugin → HttpPlugin → CdnPlugin
```

Registration order is load-bearing: esbuild calls `onResolve` / `onLoad` handlers
in registration order, and the **first handler to return a result wins**. This
document explains the key invariants each plugin must uphold and how they interact.

## Plugin responsibilities

| Plugin | Namespace | Core job |
|---|---|---|
| **AliasPlugin** | `alias-globals` | Rewrites import paths before any other resolution. Strips `node:` prefix, checks `isAlias()`. |
| **ExternalPlugin** | `external-globals`, `excluded-module` | Marks Node.js builtins as external (empty export) or redirects to polyfills when `polyfill: true`. Serves empty stubs for modules excluded by manifest field remappings. |
| **TarballPlugin** | `tarball-url` | Detects and extracts tarball archives (HTTP URLs, VFS paths) via `archive-detect` delegation. Handles pkg.pr.new, registry tarballs, GitHub releases, and VFS `.tgz` files. Must run before VFS. |
| **PackagePlugin** | `package-features` | Central hub for per-file enrichment and content loading. Owns onResolve for both VFS and HTTP namespaces (sideEffects, manifest remapping). Owns onLoad for both namespaces (fetch/read, Flow stripping, loader inference, asset discovery). |
| **VFSPlugin** | `virtual-filesystem` | Resolve-only: maps VFS-prefixed, absolute, and relative paths to canonical VFS paths. No content loading (PackagePlugin handles onLoad). |
| **HttpPlugin** | `http-url` | Resolve-only: routes HTTP URLs to the `http-url` namespace and resolves relative imports against parent URLs. No content loading or manifest remapping (PackagePlugin handles both). |
| **CdnPlugin** | `cdn-url` | Catch-all for bare npm imports. Resolves versions, fetches package.json, computes entry point, and delegates to PackagePlugin via `build.resolve()`. |

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
5. Implicit package-root fallback (historical marker `./index.js`, then bounded downstream probing)

### 7. `pluginData` contract

Plugins communicate via the `pluginData` object on resolve/load results:

| Field | Set by | Used by | Purpose |
|---|---|---|---|
| `url` | PackagePlugin (onLoad, HTTP) | HttpPlugin (onResolve), PackagePlugin (onResolve) | Base for relative import resolution (post-redirect URL) |
| `manifest` | CdnPlugin, TarballPlugin | PackagePlugin (onResolve, both namespaces) | Package.json for browser-field remapping + sideEffects computation |
| `packageBaseUrl` | CdnPlugin | PackagePlugin (onResolve, HTTP namespace) | Strip prefix to get package-relative path for remapping (HTTP packages) |
| `packageRoot` | TarballPlugin | PackagePlugin (onResolve, VFS namespace) | VFS directory root for computing package-relative paths (tarball packages) |
| `cdnOrigin` | HttpPlugin (onResolve) | CdnPlugin (onResolve) | Preserves CDN-follows-parent behavior when delegating bare imports via `build.resolve()` |
| `excludedBy` | PackagePlugin (exclusion) | ExternalPlugin (onLoad) | Which manifest field caused the exclusion (for diagnostic messages) |
| `suppressWarning` | PackagePlugin (exclusion) | ExternalPlugin (onLoad) | Whether to suppress the stub warning (from `remapFalse.warnOnStubbedRemapFalse`) |
| `importer` | PackagePlugin (onLoad, VFS) | — | The original import path (for debugging/diagnostics) |


### 7a. The `build.resolve()` delegation pattern

> **Why this exists.** esbuild's plugin API is first-match-wins: the first
> `onResolve` handler that returns a non-`undefined` result determines the
> module's path, namespace, and `sideEffects` hint. Before PackagePlugin,
> enrichment (sideEffects + manifest remapping) was split across multiple
> plugins, with gaps — tarball-extracted VFS files got no sideEffects, and
> no browser-field remapping. The fix: transport plugins (Cdn, Tarball, Http)
> resolve paths and then **re-enter the plugin chain** via `build.resolve()`,
> allowing PackagePlugin to intercept and enrich before the final result
> reaches esbuild.

The `build.resolve()` function re-invokes the plugin chain from the current
plugin's position onward. By calling it with the resolved URL/path plus package
context in `pluginData`, the transport plugin hands off to PackagePlugin for
enrichment without duplicating that logic.

**Three delegation sites in the codebase:**

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │  Site 1: CdnPlugin → PackagePlugin (entry-point delegation)        │
  │                                                                    │
  │  CdnPlugin resolves a bare import to an HTTP URL + package.json,   │
  │  then delegates:                                                   │
  │                                                                    │
  │    build.resolve(finalUrl, {                                       │
  │      namespace: "http-url",                                        │
  │      pluginData: {                                                 │
  │        manifest: resolvedManifest,                                 │
  │        packageBaseUrl: "https://unpkg.com/react@19.0.0/"           │
  │      }                                                             │
  │    })                                                              │
  │                                                                    │
  │  PackagePlugin's HTTP onResolve intercepts:                        │
  │    • Computes sideEffects from manifest                            │
  │    • Applies any browser-field remapping                           │
  │    • Returns enriched result                                       │
  └──────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────┐
  │  Site 2: HttpPlugin → CdnPlugin (bare import delegation)           │
  │                                                                    │
  │  When HttpPlugin encounters a bare import within HTTP namespace     │
  │  (e.g., "lodash" imported from a CDN-fetched file), it delegates   │
  │  back through the chain:                                           │
  │                                                                    │
  │    build.resolve("lodash", {                                       │
  │      pluginData: {                                                 │
  │        ...parentPluginData,                                        │
  │        cdnOrigin: "https://esm.sh"  // CDN-follows-parent          │
  │      }                                                             │
  │    })                                                              │
  │                                                                    │
  │  This re-enters the chain from HttpPlugin's position onward.       │
  │  CdnPlugin catches it (catch-all for bare imports) and resolves    │
  │  using the parent's CDN origin, then delegates back to             │
  │  PackagePlugin via Site 1.                                         │
  └──────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────┐
  │  Site 3: CdnPlugin → TarballPlugin (registry mode delegation)      │
  │                                                                    │
  │  When cdn is "npm.registry", CdnPlugin constructs a tarball URL    │
  │  and delegates:                                                    │
  │                                                                    │
  │    build.resolve(tarballUrl, {                                     │
  │      pluginData: args.pluginData                                   │
  │    })                                                              │
  │                                                                    │
  │  TarballPlugin intercepts (it runs before PackagePlugin),          │
  │  extracts the tarball to VFS, and resolves the entry point.        │
  │  The resulting VFS path carries packageRoot + manifest in          │
  │  pluginData, which PackagePlugin's VFS onResolve then enriches     │
  │  on subsequent relative imports.                                   │
  └──────────────────────────────────────────────────────────────────────┘
```

**End-to-end: a CDN bare import through the full delegation chain:**

```
  User code: import { debounce } from "lodash-es"
       │
       ▼  1. AliasPlugin (onResolve)
       No alias match → pass
       │
       ▼  2. ExternalPlugin (onResolve)
       Not a builtin → pass
       │
       ▼  3. TarballPlugin (onResolve)
       Not a tarball URL → pass
       │
       ▼  4. PackagePlugin (onResolve, VFS filter: /^[.\/]/)
       "lodash-es" doesn't match filter → skip
       │
       ▼  4. PackagePlugin (onResolve, HTTP filter: /^(https?:\/\/|[.\/])/)
       "lodash-es" doesn't match filter → skip
       │
       ▼  5. VFSPlugin (onResolve)
       Not a VFS path → pass
       │
       ▼  6. HttpPlugin (onResolve, filter: /^https?:\/\//)
       Not an HTTP URL → skip
       │
       ▼  6. HttpPlugin (onResolve, filter: /.*/, http-url ns)
       Wrong namespace → skip
       │
       ▼  7. CdnPlugin (onResolve)
       Bare import! Resolves:
         a. parsePackageName("lodash-es") → { name, version }
         b. Fetch package.json from CDN
         c. resolvePackageEntry() → "./lodash.js"
         d. Compute entry URL → "https://unpkg.com/lodash-es@4.17.21/lodash.js"
         e. build.resolve(entryUrl, {  ◄── DELEGATION SITE 1
              namespace: "http-url",
              pluginData: { manifest, packageBaseUrl }
            })
       │
       ▼  Re-enters chain from CdnPlugin's position (no earlier plugin sees it)
       │
       ▼  PackagePlugin (onResolve, HTTP namespace)
       packageBaseUrl exists → enrichment activates:
         a. toPackageRelative() → "./lodash.js"
         b. applyManifestRemappings() → no remapping
         c. computeEsbuildSideEffects() → sideEffects: false  (lodash-es declares it)
         d. Returns { path: entryUrl, namespace: "http-url", sideEffects: false }
       │
       ▼  esbuild has the resolved module. Now loads it:
       │
       ▼  PackagePlugin (onLoad, HTTP namespace)
       Only onLoad for http-url (registered first):
         a. determineExtension() → fetch with extension probing
         b. Store in VFS for bundle analyzer
         c. fetchAssets() → discover WASM/Workers
         d. maybeStripFlow() → no Flow in lodash
         e. inferLoader() → "js"
         f. Returns { contents, loader: "js", pluginData: { url: finalUrl } }
       │
       ▼  esbuild parses the JS, finds: import debounce from "./debounce.js"
       │
       ▼  PackagePlugin (onResolve, HTTP namespace)
       resolvedUrl = urlJoin(parentUrl, "../", "./debounce.js")
       → "https://unpkg.com/lodash-es@4.17.21/debounce.js"
       Starts with packageBaseUrl → enrichment:
         sideEffects: false (from lodash-es manifest)
       │
       ▼  PackagePlugin (onLoad, HTTP namespace)
       Fetch, store, infer loader → returns content
       │
       ▼  ... continues for each transitive import ...
```

**End-to-end: a tarball-extracted VFS import through the delegation chain:**

```
  User code: import { sql } from "drizzle-orm"  (with cdn: "npm.registry")
       │
       ▼  7. CdnPlugin (onResolve, REGISTRY_CDN branch)
       Registry mode → construct tarball URL:
         "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz"
       build.resolve(tarballUrl, { pluginData })  ◄── DELEGATION SITE 3
       │
       ▼  3. TarballPlugin (onResolve)
       isTarballUrl() → true → extract to VFS:
         /__tarballs__/<hash>/
       resolvePackageEntry(manifest, "", conditions) → "./dist/index.js"
       Returns {
         path: "/__tarballs__/<hash>/dist/index.js",
         namespace: "virtual-filesystem",
         sideEffects: <computed>,
         pluginData: { packageRoot, manifest }
       }
       │
       ▼  esbuild has the resolved module. Now loads it:
       │
       ▼  4. PackagePlugin (onLoad, VFS namespace)
       Only onLoad for virtual-filesystem:
         a. getFile() → read from VFS
         b. maybeStripFlow() → strip if Flow detected
         c. inferLoader() → "ts" or "tsx"
         d. resolveDir = dirname(args.path)
         e. Returns { contents, loader, resolveDir }
       │
       ▼  esbuild parses, finds: import { Column } from "./column.js"
       │
       ▼  4. PackagePlugin (onResolve, VFS namespace)
       packageRoot exists → enrichment:
         a. resolve(resolveDir, "./column.js")
            → "/__tarballs__/<hash>/dist/column.js"
         b. Starts with packageRoot → enrichment activates
         c. toPackageRelative() → "./dist/column.js"
         d. applyManifestRemappings() → check browser field
         e. resolveVfsPath() → probe extensions in VFS
         f. computeEsbuildSideEffects()
         g. Returns { path, namespace: "virtual-filesystem", sideEffects }
       │
       ▼  4. PackagePlugin (onLoad, VFS namespace)
       Read, strip Flow if needed, infer loader → returns content
       │
       ▼  ... continues for each transitive import ...
```

### 8. CDN style routing

`getCDNStyle()` classifies URLs into routing categories:

| Input pattern | Style | Resolved by | Content loaded by |
|---|---|---|---|
| `https://unpkg.com/...` | `npm` | HttpPlugin (onResolve) | PackagePlugin (onLoad, HTTP) |
| `https://pkg.pr.new/...` | `tarball` | TarballPlugin | PackagePlugin (onLoad, VFS) |
| `jsr:@std/...` | `jsr` | CdnPlugin (JSR path) | PackagePlugin (onLoad, HTTP) |
| `github:user/repo` | `github` | HttpPlugin | PackagePlugin (onLoad, HTTP) |
| `react` (bare import) | `other` | CdnPlugin → PackagePlugin | PackagePlugin (onLoad, HTTP) |
| `npm.registry` (cdn mode) | `registry` | CdnPlugin → TarballPlugin | PackagePlugin (onLoad, VFS) |


### 9. PackagePlugin: the enrichment and content-loading hub

PackagePlugin (`core/plugins/package.ts`) registers **four handlers** — two `onResolve`
(enrichment) and two `onLoad` (content loading) — covering both the VFS and HTTP namespaces.

**Why it exists.** Before PackagePlugin, enrichment and content loading were split across
four plugins with gaps:

| Concern | CDN path (before) | VFS path (before) | After (PackagePlugin) |
|---|---|---|---|
| sideEffects | CdnPlugin (entry only) | ❌ Missing | ✅ Both namespaces |
| Manifest remapping | HttpPlugin (onResolve) | ❌ Missing | ✅ Both namespaces |
| Flow stripping | HttpPlugin (onLoad) | VFSPlugin (onLoad) | ✅ PackagePlugin (onLoad) |
| Content loading | HttpPlugin (onLoad) | VFSPlugin (onLoad) | ✅ PackagePlugin (onLoad) |

**Handler registration order within PackagePlugin:**

```
  PackagePlugin.setup(build) registers:
       │
       ├── 1. onResolve (VFS namespace, filter: /^[.\/]/)
       │      Enriches relative/absolute imports within tarball packages
       │
       ├── 2. onResolve (HTTP namespace, filter: /^(https?:\/\/|[.\/])/)
       │      Enriches URL imports within CDN packages
       │
       ├── 3. onLoad (VFS namespace, filter: /.*/)
       │      Reads VFS content, Flow stripping, loader inference
       │
       └── 4. onLoad (HTTP namespace, filter: /.*/)
              Extension probing, HTTP fetch, VFS storage, asset discovery,
              Flow stripping, loader inference
```

Because PackagePlugin is registered **before** VFSPlugin and HttpPlugin, its
handlers take priority. When PackagePlugin's `onResolve` returns `undefined`
(no package context), the downstream plugin handles the import.

#### 9a. VFS onResolve: tarball package enrichment

**Activation condition:** `pluginData.packageRoot` AND `pluginData.manifest` both exist
(set by TarballPlugin during entry-point resolution).

```
  Relative import from tarball-extracted file
  e.g., import "./lib/stream.js" from /__tarballs__/<hash>/index.js
       │
       ▼  Resolve candidate path
       resolve(resolveDir, "./lib/stream.js")
       → "/__tarballs__/<hash>/lib/stream.js"
       │
       ▼  Check: candidate starts with packageRoot?
       "/__tarballs__/<hash>/lib/stream.js".startsWith("/__tarballs__/<hash>/")
       → yes → enrichment activates
       │
       ▼  Compute package-relative path
       toPackageRelative(candidate, packageRoot)
       → "./lib/stream.js"
       │
       ▼  Apply manifest field remappings
       applyManifestRemappings("./lib/stream.js", manifest, conditions)
       │
       ├── browser: { "./lib/stream.js": "./lib/stream-browser.js" }
       │   → remapped! New path: "./lib/stream-browser.js"
       │
       ├── browser: { "./lib/stream.js": false }
       │   → excluded! Return buildExclusionResult()
       │   │
       │   ▼  Check remapFalse.importRemapFalse policy:
       │     "stub"     → namespace: "excluded-module" (ExternalPlugin serves empty export)
       │     "error"    → esbuild build error
       │     "external" → mark as external (preserved in output)
       │
       └── No match → path unchanged
       │
       ▼  Probe VFS for actual file
       resolveVfsPath(FileSystem, finalCandidate, resolveExtensions)
       → tries: exact, .js, .mjs, .ts, .tsx, /index.js, etc.
       → "/__tarballs__/<hash>/lib/stream-browser.js"
       │
       ▼  Compute sideEffects
       computeEsbuildSideEffects(manifest, "/lib/stream-browser.js", { cache })
       │
       ├── sideEffects: false → return false (entire package tree-shakeable)
       ├── sideEffects: ["./src/nodes/**/*"] → glob match → true or false
       └── sideEffects absent → return undefined (conservative default)
       │
       ▼  Return enriched result
       {
         path: "/__tarballs__/<hash>/lib/stream-browser.js",
         namespace: "virtual-filesystem",
         sideEffects: false,
         pluginData: { packageRoot, manifest, importer }
       }
```

**When PackagePlugin returns `undefined` (no enrichment):**
- No `pluginData.packageRoot` → user-authored VFS file, not a package
- Import escapes the package root (e.g., `../../outside.js`)
- `resolveVfsPath()` can't find the file → VFSPlugin may resolve differently

#### 9b. HTTP onResolve: CDN package enrichment

**Activation condition:** `pluginData.packageBaseUrl` AND `pluginData.manifest` both exist
(set by CdnPlugin during entry-point resolution via `build.resolve()` delegation).

```
  Relative import from CDN-fetched file
  e.g., import "./lib/stream.js" from https://unpkg.com/readable-stream@4.0.0/index.js
       │
       ▼  Determine resolved URL
       ├── Full HTTP URL (from build.resolve delegation)
       │   → use directly: "https://unpkg.com/readable-stream@4.0.0/lib/stream.js"
       ├── Absolute path ("/lib/stream.js")
       │   → resolve against parent URL origin
       └── Relative path ("./lib/stream.js")
           → urlJoin(parentUrl, "../", "./lib/stream.js")
           → "https://unpkg.com/readable-stream@4.0.0/lib/stream.js"
       │
       ▼  Check: resolved URL starts with packageBaseUrl?
       "https://unpkg.com/readable-stream@4.0.0/lib/stream.js"
         .startsWith("https://unpkg.com/readable-stream@4.0.0/")
       → yes → enrichment activates
       │
       ▼  Compute package-relative path
       toPackageRelative(resolvedUrl, packageBaseUrl)
       → "./lib/stream.js"
       │
       ▼  Apply manifest field remappings
       applyManifestRemappings("./lib/stream.js", manifest, conditions)
       → (same logic as VFS — remapping, exclusion, or pass-through)
       │
       ▼  Compute sideEffects
       computeEsbuildSideEffects(manifest, "/lib/stream.js", { cache })
       │
       ▼  Return enriched result
       {
         path: "https://unpkg.com/readable-stream@4.0.0/lib/stream-browser.js",
         namespace: "http-url",
         sideEffects: false,
         pluginData: { manifest, packageBaseUrl, url }
       }
```

**When PackagePlugin returns `undefined` (no enrichment):**
- No `pluginData.packageBaseUrl` → direct URL fetch without package context
- URL escapes the package base URL → cross-package import (handled by HttpPlugin)

#### 9c. VFS onLoad: content preprocessing for virtual filesystem

**Always activates** — this is the sole `onLoad` handler for the VFS namespace.

```
  esbuild needs content for "/__tarballs__/<hash>/lib/stream.js"
       │
       ▼  Read from VFS
       getFile(FileSystem, args.path, "buffer")
       → Uint8Array of file content
       │
       ├── null? → return undefined (esbuild reports missing file)
       │
       ▼  Flow type stripping
       maybeStripFlow(content, { url: args.path, sourceMap: enableSourceMaps })
       │
       ├── containsFlow() → false? → pass through (zero overhead, ~4KB scan)
       └── containsFlow() → true?
           │
           ▼  flow-remove-types (lazy-loaded WASM)
           Strip type annotations, preserve source positions
           If sourceMap enabled → inline source map appended
           │
           ▼  Return stripped content as string
       │
       ▼  Loader inference
       inferLoader(args.path, undefined, content)
       │
       ├── Extension-based: .ts → "ts", .tsx → "tsx", .css → "css"
       ├── JSX upgrade: .js with JSX patterns → "tsx"
       └── Default: "ts" (esbuild strips TS annotations for free)
       │
       ▼  Return loaded content
       {
         contents: processedContent,
         loader: "tsx",
         resolveDir: dirname(args.path),  // ← enables relative imports
         pluginData: { ...inherited, importer: args.path }
       }
```

> **Why `resolveDir`?** Without setting `resolveDir` to the file's parent
> directory, esbuild would resolve relative imports like `"./column.js"`
> against the build's working directory (`/`), not the file's location.
> This is critical for tarball-extracted packages where files live deep
> in `/__tarballs__/<hash>/dist/`.

#### 9d. HTTP onLoad: content fetching and preprocessing for CDN files

**Always activates** — this is the sole `onLoad` handler for the HTTP namespace.

```
  esbuild needs content for "https://unpkg.com/lodash-es@4.17.21/debounce.js"
       │
       ▼  Extension probing + fetch
       determineExtension(args.path, { headersOnly: false, StateContext })
       │
       ├── Try exact URL → 200? Use it
       ├── Try .js, .mjs, .ts, ... → first 200 wins
       ├── Try /index.js, /index.mjs, ... → first 200 wins
       └── All 18 variants 404 → throw (build error)
       │
       ▼  returns { url: finalUrl, content: Uint8Array, contentType }
       │
       ▼  Store in VFS
       setFile(FileSystem, toURLPath(url), content)
       (for bundle analyzer and install-size reporting)
       │
       ▼  Asset discovery
       fetchAssets(url, content, StateContext)
       │
       ├── Scan for `new URL("./worker.js", import.meta.url)` patterns
       ├── Scan for `new URL("./module.wasm", import.meta.url)` patterns
       └── Fetch discovered assets → append to Assets array
       │
       ▼  Flow type stripping (same as VFS onLoad)
       │
       ▼  Loader inference (same as VFS onLoad)
       │
       ▼  Return loaded content
       {
         contents: processedContent,
         loader: "js",
         pluginData: {
           ...inherited,
           url: finalUrl  // ← CRITICAL: post-redirect URL for relative resolution
         }
       }
```

> **Why `pluginData.url`?** CDN URLs often redirect: `unpkg.com/react@latest`
> → `unpkg.com/react@19.0.0/index.js`. The post-redirect URL is stored in
> `pluginData.url` so that when esbuild encounters `import "./scheduler"` inside
> that file, HttpPlugin resolves it against `https://unpkg.com/react@19.0.0/`
> (the real location), not `https://unpkg.com/react@latest/` (the alias).


### 10. Shared helpers exported by PackagePlugin

| Export | Purpose |
|---|---|
| `createPluginContext()` | Extracts `config`, `effectiveResolveOpts`, and `sideEffectsMatchersCache` from `StateContext`. Eliminates repeated initialization boilerplate across plugins. |
| `toPackageRelative()` | Converts an absolute path/URL to a `"./"` prefixed package-relative path. Used by both VFS and HTTP enrichment. Returns `null` if the path is outside the package. |
| `packageIdFrom()` | Builds a stable `name@version` cache key from a manifest. Used for sideEffects matcher caching. |
| `buildExclusionResult()` | Constructs the esbuild `onResolve` return for per-module exclusions. Respects `remapFalse.importRemapFalse` policy (`"stub"` / `"error"` / `"external"`). |
| `PACKAGE_NAMESPACE` | The plugin name string (`"package-features"`). For identification only — the plugin resolves into VFS and HTTP namespaces, not its own. |


## Integration test scenarios

| Scenario | What it validates |
|---|---|
| VFS → CDN handoff | Bare import in VFS entry routes through CdnPlugin, sideEffects populated by PackagePlugin |
| VFS-only build | No network when code has no external imports |
| Builtin exclusion | `import 'fs'` → empty export stub via ExternalPlugin, no errors |
| `node:` prefix handling | `import 'node:path'` → excluded correctly |
| Alias rewrite | `alias: { react: "preact" }` → preact fetched from CDN |
| Polyfill mode | `polyfill: true` + `import 'path'` → real code from `path-browserify` |
| Browser field remapping | `@exodus/bytes` resolves browser-specific relative imports via PackagePlugin |
| Conditional exports | preact ESM, solid-js nested conditions |
| Tree-shaking | rxjs barrel vs single export — sideEffects from PackagePlugin enables significant size reduction |
| JSR resolution | `jsr:@std/path@1.0.0` bundles correctly |
| Tarball extraction | `pkg.pr.new` URL → TarballPlugin → working bundle, content served by PackagePlugin |
| Platform-specific | browser vs node conditions produce valid builds |
| CJS / IIFE format | Output contains expected format wrappers |
| VFS state isolation | Separate `buildWithEntry` calls don't leak state |
| Flow stripping (HTTP) | React Native from CDN → PackagePlugin strips Flow in onLoad |
| Flow stripping (VFS) | React Native from tarball → PackagePlugin strips Flow in onLoad |
| Per-module exclusion | `browser: { "./server.js": false }` → PackagePlugin stubs via ExternalPlugin |
| `build.resolve()` delegation | CdnPlugin → PackagePlugin enrichment round-trip preserves pluginData |

## Test file

[`core/tests/15-plugin-pipeline.test.ts`](../../core/tests/15-plugin-pipeline.test.ts)
— 110 tests covering unit, behavioral, and integration layers.
