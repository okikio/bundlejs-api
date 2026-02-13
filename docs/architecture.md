# bundlejs: Architecture & Usage Guide

> *Bundle anywhere. Bundle everywhere.*

bundlejs is a JavaScript/TypeScript bundling service that runs **[esbuild](https://esbuild.github.io/)** — a blazing-fast bundler written in Go — entirely in **WebAssembly (WASM)**. No native binaries, no filesystem, no local install. You give it package names (or raw code), and it returns *minified, tree-shaken bundles* with compressed size measurements.

It works three ways:

- **HTTP API** — deployed on **[Deno Deploy](https://deno.com/deploy)** (a serverless edge runtime for JavaScript/TypeScript)
- **Embeddable library** — import `@bundle/core` in *any* JavaScript runtime
- **Web UI** — the engine behind [bundlejs.com](https://bundlejs.com) for quick, visual package size checks

The problem it solves:

> *"How big will this dependency be in my production bundle?"*
>
> Answered in seconds, from anywhere, with **real esbuild output** rather than estimates.

Unlike tools that guess sizes from package metadata, bundlejs runs a *real* bundler — performing actual **tree-shaking** (removing unused code), dead code elimination, scope hoisting, and minification. It then compresses the result and reports the exact size.

> **What bundlejs is *not*:** It is not a replacement for your local build tool (webpack, Vite, Rollup). It does not manage `node_modules`, does not install packages to disk, and does not run your code. Everything is fetched over HTTP, held in memory, bundled, measured, and discarded.


## Getting Started

**Prerequisites:** [Deno](https://deno.land/) installed. Deno is a modern JavaScript/TypeScript runtime (like Node.js, but with built-in TypeScript support, web-standard APIs, and secure-by-default permissions). bundlejs is a **Deno workspace** — a monorepo where each package has its own `deno.jsonc` config.

```sh
git clone https://github.com/okikio/bundlejs-api.git
cd bundlejs-api
deno serve -A --watch edge/mod.ts
```

The API is now running at `http://localhost:8000`. Try the simplest invocation:

```
http://localhost:8000/?q=react
```

This returns JSON with the bundle size of `react`:

```json
{
  "query": "?q=react",
  "version": "react@19.0.0",
  "modules": [["react@19.0.0", "export"]],
  "size": {
    "type": "gzip",
    "compressedSize": "2.34 kB",
    "uncompressedSize": "6.72 kB"
  },
  "time": "in 1.2 seconds",
  "input": "export * from \"react\";\nexport { default as reactDefault } from \"react\";"
}
```

> **⚠️ Three early mistakes to avoid:**
>
> 1. **Forgetting env vars** — `UPSTASH_URL` and `UPSTASH_TOKEN` are needed for Redis caching. Without them, every request triggers a fresh build.
> 2. **Expecting filesystem imports** — `import "./my-file.ts"` only works if that file exists *in the VFS*. bundlejs resolves everything over HTTP.
> 3. **Assuming Node.js** — this is a Deno project. Use `deno` commands, not `npm`/`node`.


## How to Think About bundlejs

At the highest level, bundlejs is an **adapter layer** that makes esbuild work *without a filesystem*.

esbuild is extremely fast, but it assumes local files exist on disk. bundlejs intercepts every module resolution and file read that esbuild attempts, then redirects them to:

- **CDN fetches** — downloading packages from a Content Delivery Network (CDN) like [unpkg.com](https://unpkg.com) or [esm.sh](https://esm.sh)
- **Tarball extraction** — unpacking `.tgz` archives from services like [pkg.pr.new](https://pkg.pr.new)
- **In-memory VFS** — a Virtual File System held entirely in RAM

…and hands the results back to esbuild *as if they were local files*.

> **The division of labor:** esbuild does the heavy lifting — parsing, linking, tree-shaking, minification, code generation. bundlejs does the plumbing — figuring out *where* modules live, fetching them, and presenting them to esbuild as local.
>
> In short: *"esbuild, plus a portable module system implemented as plugins and shared resolvers."*

```
                          bundlejs Pipeline

  ┌─────────────────────────────────────────────────────────────┐
  │  User Query                                                 │
  │  URL params: ?q=react&treeshake=[{useState}]                │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Edge Function (@bundle/edge — Deno Deploy)                 │
  │  Parses query, builds config, checks Redis cache            │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Core Engine (@bundle/core — esbuild-wasm + 6 plugins)      │
  │  Resolves imports via CDN, fetches packages over HTTP,      │
  │  bundles in-memory with virtual filesystem                  │
  └──────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  Compression (@bundle/compress — gzip / brotli / zstd / lz4)│
  └──────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  JSON Response                                              │
  │  { size, input, config, time, modules, ... }                │
  └─────────────────────────────────────────────────────────────┘
```

No local filesystem exists at any stage. Every file — entry points, npm packages, transitive dependencies — lives in the **VFS** or arrives over **HTTP** from a CDN.

| ❌ Does not | Why |
|:-----------|:----|
| Install packages to disk | Everything is fetched and held *in memory* |
| Run your code | It only bundles and measures |
| Support `git:` / `workspace:` / `link:` specs | Only registry, URL, and JSR specifiers |
| Persist VFS between requests | Each bundle starts with a *fresh* build context |


## The Four Modules

bundlejs is a Deno workspace with four packages. Dependencies flow strictly downward.

```
bundlejs-api/
├── edge/      @bundle/edge       HTTP API layer (Deno Deploy)
├── core/      @bundle/core       The bundler engine (esbuild + plugins)
├── compress/  @bundle/compress   Compression algorithms (gzip/brotli/zstd/lz4)
└── utils/     @bundle/utils      Shared utilities (parsing, fetching, resolution)
```

```
  @bundle/edge
    ├── uses ──▶ @bundle/core       (build, transform, init)
    ├── uses ──▶ @bundle/compress   (compress bundled output)
    └── uses ──▶ @bundle/utils      (parsing, version resolution)

  @bundle/core
    └── uses ──▶ @bundle/utils      (npm resolution, fetch, path, conditions)

  @bundle/compress
    └── uses ──▶ @bundle/utils      (encoding, formatting)
```

`@bundle/utils` is the **foundation** — zero internal dependencies. It wraps **Web APIs** (not Node.js APIs) so the same code runs in Deno Deploy, browsers, Cloudflare Workers, *and* Node.js without platform-specific shims. Key utilities are described inline where the plugin pipeline first uses them, but the major modules are:

- **Package parsing** — [utils/parse-package-name.ts](../utils/parse-package-name.ts) and [utils/npm-spec.ts](../utils/npm-spec.ts) split specifiers and classify them as *semver*, *tag*, *URL*, *alias*, *JSR*, or *unsupported*
- **Export/import resolution** — [utils/resolve-exports-imports.ts](../utils/resolve-exports-imports.ts) and [utils/resolve-conditions.ts](../utils/resolve-conditions.ts) implement the Node.js exports/imports resolution algorithm and compute condition sets for 10+ runtime profiles
- **npm registry API** — [utils/npm-search.ts](../utils/npm-search.ts) wraps the npm REST API: version resolution, packument fetching, tarball URL construction
- **`.npmrc` parsing** — [utils/npmrc.ts](../utils/npmrc.ts) extracts registry configuration from `.npmrc` content — scoped registries, default overrides, and opt-in auth token extraction via `parseNpmrc(content, { extractAuth: true })`
- **Archive detection** — [utils/archive-detect.ts](../utils/archive-detect.ts) identifies archive formats from any source using URL extensions, HTTP headers, Content-Disposition, magic bytes, and tar confirmation
- **Caching fetch** — [utils/fetch-and-cache.ts](../utils/fetch-and-cache.ts) wraps `fetch()` with multi-tier caching (LRU + Cache API)
- **Builtin catalogs** — [utils/runtime-builtins.ts](../utils/runtime-builtins.ts) maps ~50 Node.js builtins to their browser polyfills


## The Plugin Pipeline

The core architectural insight: **six esbuild plugins** registered in a specific order in [core/build.ts](../core/build.ts). This order is *load-bearing* — esbuild evaluates `onResolve` callbacks in registration order, and the **first plugin that returns a result wins**. Returning `undefined` passes control to the next plugin.

> **esbuild plugins** intercept two phases of module handling: **`onResolve`** (map an import specifier to a path + namespace) and **`onLoad`** (return a file's source code + loader type). A module's identity in esbuild is the tuple *(namespace, path)* — two modules with the same path but different namespaces are distinct files. bundlejs uses namespaces to distinguish VFS files, HTTP-fetched modules, tarball-extracted files, and CDN-resolved packages.

```typescript
plugins: [
  AliasPlugin(StateContext),              // 1. Alias rewrites
  ExternalPlugin(StateContext),           // 2. External marking / polyfills
  TarballPlugin(StateContext),            // 3. Tarball URL extraction
  VirtualFileSystemPlugin(StateContext),  // 4. In-memory files
  HttpPlugin(StateContext),               // 5. HTTP URL resolution and loading
  CdnPlugin(withContext({ origin: host }, StateContext)),  // 6. Bare import → CDN URL
]
```

Here is what happens when esbuild encounters `import "react"`:

```
import "react"
   │
   ▼
AliasPlugin      Is "react" aliased to something else?       ── NO ──▶ pass
   │
   ▼
ExternalPlugin   Is "react" a Node.js builtin?               ── NO ──▶ pass
   │
   ▼
TarballPlugin    Is "react" a tarball URL or VFS tarball?    ── NO ──▶ pass
   │
   ▼
VFSPlugin        Is "react" in the virtual filesystem?        ── NO ──▶ pass
   │                (no "." or "/" prefix — skip bare imports)
   ▼
HttpPlugin       Is "react" an HTTP URL?                      ── NO ──▶ pass
   │
   ▼
CdnPlugin        Bare import → resolve from CDN               ── YES ── handle it
                  1. parsePackageName("react")
                  2. Fetch package.json from CDN
                  3. Resolve entry via exports field
                  4. Return CDN URL in http-url namespace
```

Each plugin has one job; complex behavior emerges from their composition.

---

### 1. AliasPlugin — *Rewrite import paths before resolution*

> **Source:** [core/plugins/alias.ts](../core/plugins/alias.ts)

Runs first because aliases must rewrite the import path *before* any other plugin tries to resolve it.

- If config specifies `{ alias: { "fs": "memfs" } }`, transforms `import "fs"` → `import "memfs"`
- Also handles **npm-style aliases** from `package.json` dependencies (e.g., `"react": "npm:preact@10"`)
- By running first, ensures all subsequent resolution operates on the *intended* package name

**Concrete trace — aliasing React to Preact:**

```typescript
// User config:
{ alias: { "react": "preact/compat", "react-dom": "preact/compat" } }

// Source code:
import { useState } from "react";            // ← esbuild calls AliasPlugin.onResolve

// AliasPlugin sees "react" matches alias table → rewrites to "preact/compat"
// Returns: { path: "preact/compat", namespace: "" }
// esbuild re-enters plugin chain with "preact/compat" → CdnPlugin handles it
```

> **Think of it like a mail forwarding service.** A letter addressed to "react" arrives, the alias table says "forward all react mail to preact/compat", so the letter is re-addressed and re-delivered. The downstream plugins never know the original name.

---

### 2. ExternalPlugin — *Handle Node.js builtins*

> **Source:** [core/plugins/external.ts](../core/plugins/external.ts)

Runs second to catch Node.js built-in modules (like `fs`, `path`, `crypto`) *before* the CDN plugin tries to fetch them from npm. Behavior depends on the **`polyfill`** setting:

| `polyfill` value | What happens to `import "fs"` |
|:-----------------|:-----------------------------|
| `false` *(default)* | Marked **external** — excluded from bundle with empty `export default {}` |
| `true` | Rewritten to a browser polyfill (e.g., `fs` → `memfs`, `path` → `path-browserify`), then falls through to CdnPlugin |

Polyfill mappings come from [utils/runtime-builtins.ts](../utils/runtime-builtins.ts). The `node:` prefix (e.g., `import "node:fs"`) is stripped before matching.

**Concrete trace — `polyfill: true` for `crypto`:**

```
import { createHash } from "crypto";
   │
   ▼  ExternalPlugin.onResolve
   Is "crypto" in NODE_BUILTINS?  → YES
   Is polyfill enabled?           → YES
   │
   ▼  Look up polyfill mapping:
   builtinMap["crypto"] = "crypto-browserify"
   │
   ▼  Rewrite:
   Return { path: "crypto-browserify", namespace: "" }
   │
   ▼  esbuild re-enters plugin chain → CdnPlugin resolves "crypto-browserify"
      from CDN → fetches browser-compatible implementation
```

With `polyfill: false` (default), the same import returns `{ external: true }` — esbuild emits a bare `import "crypto"` in the output, and the ExternalPlugin's `onLoad` serves `export default {}` so references don't break.

---

### 3. TarballPlugin — *Extract packages from `.tgz` archives (HTTP + VFS)*

> **Source:** [core/plugins/tar.ts](../core/plugins/tar.ts)

Handles tarball-based package sources from **three branches**:
1. **HTTP tarball URLs** — `pkg.pr.new`, npm registry tarballs (`registry.npmjs.org/…/-/….tgz`), GitHub release tarballs, or any URL whose pathname contains a tarball extension
2. **VFS tarball paths** — absolute paths in the in-memory filesystem (e.g., `/packages/my-lib.tgz`)
3. **Self-reference imports** — when code *inside* an extracted tarball imports its own package name, resolves against the tarball's manifest instead of fetching from CDN

**Concrete example — self-reference inside a tarball:**

```
  Tarball: @tanstack/react-query@7988 extracted to /__tarballs__/abc123/

  Inside /__tarballs__/abc123/src/core.js:
    import { QueryClient } from "@tanstack/react-query";  ← self-reference!
       │
       ▼  TarballPlugin.onResolve detects:
       Importer is inside /__tarballs__/abc123/
       tarballMounts has entry for abc123 with name "@tanstack/react-query"
       The import specifier matches the tarball's own package name!
       │
       ▼  Resolve against the tarball's own manifest’s exports
       (instead of fetching from CDN — avoids version mismatch)
       │
       ▼  Return: /__tarballs__/abc123/dist/index.js (VFS path)
```

> **Why this matters:** Without self-reference handling, a tarball-extracted package that imports itself by name would trigger a CDN fetch for the *published* version — potentially a different version than the tarball. This causes subtle inconsistencies.

**Must be registered before VFS.** Without this ordering, a file like `/packages/my-lib.tgz` would be claimed by the VirtualFileSystemPlugin as a raw blob before the TarballPlugin could intercept and extract it.

**Detection** is delegated to [utils/archive-detect.ts](../utils/archive-detect.ts):
- `isTarballUrl()` checks for CDN-style origins (`getCDNStyle() === "tarball"`) *or* delegates to `isTarballPath()` for extension-based detection
- `findTarballSplitInPathname()` walks pathname segments via `detectArchiveFromPathHint()` — the first tarball-like segment is the split point between tarball fetch path and subpath

The tar plugin has **zero extension-matching logic of its own** — add a new tarball extension to `archive-detect` and it's automatically recognized.

**Concrete example — URL splitting for a `pkg.pr.new` tarball:**

```
Input URL: https://pkg.pr.new/@tanstack/react-query@7988

  findTarballSplitInPathname("/tanstack/react-query@7988")
       │
       ▼  Walk each segment:
       "tanstack"         → detectArchiveFromPathHint() → null  (not a tarball)
       "react-query@7988" → getCDNStyle() checks origin → "tarball" ✓
       │
       ▼  Split result:
       tarballPath = "https://pkg.pr.new/@tanstack/react-query@7988"
       subpath     = "/"     (nothing after the tarball segment)

Input URL: https://registry.npmjs.org/react/-/react-19.0.0.tgz/package/index.js

       "react"            → null
       "react-19.0.0.tgz" → isTarballPath() → ".tgz" extension ✓
       │
       ▼  Split result:
       tarballPath = "https://registry.npmjs.org/react/-/react-19.0.0.tgz"
       subpath     = "/package/index.js"
```

**Extraction pipeline:**
- `fetchAndExtractTarball(source, …)` accepts both HTTP URLs (fetched via `fetchWithCache`) and VFS paths (read via `getFile`, wrapped in `new Response()`)
- Archive format detection uses `detectArchiveFromResponse()` (multi-signal: extension, headers, magic bytes, ustar signature)
- Extracts into VFS under `/__tarballs__/<sha256-hash>/`
- **Content-addressed caching** via `getTarballKey()` (SHA-256 of the source, first 16 hex chars) ensures the same tarball is fetched only once per build

**Concrete example — VFS state after extracting `react-19.0.0.tgz`:**

```
  VFS contents after extraction:
  ┌──────────────────────────────────────────────────────┐
  │  /__tarballs__/a1b2c3d4e5f6g7h8/                     │
  │    ├── package.json          (manifest)              │
  │    ├── index.js              (entry from "main")     │
  │    ├── jsx-runtime.js                                │
  │    ├── jsx-dev-runtime.js                            │
  │    ├── cjs/                                          │
  │    │   ├── react.production.js                       │
  │    │   └── react.development.js                      │
  │    └── LICENSE                                       │
  └──────────────────────────────────────────────────────┘

  Hash: SHA-256("https://registry.npmjs.org/react/-/react-19.0.0.tgz")
        → first 16 hex chars → "a1b2c3d4e5f6g7h8"
```

> **Like a zip file mounted as a drive.** The tarball is fetched once, unpacked into a virtual directory, and from that point on every file read is a fast in-memory lookup — no more network requests for that package.

**Entry point resolution** uses the shared `resolveAndProbeEntry()` function — a two-step pipeline that combines `resolvePackageEntry()` (from [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts)) with VFS extension probing via `resolveVfsPath()`:

```
  Subpath + manifest
       │
       ▼
  resolvePackageEntry()       ← modern exports → legacy fallback → literal → /index.js
       │
       ▼
  resolveVfsPath()            ← exact match → extension probing → index.* fallback
       │
       ▼
  Final VFS path (or exclusion result)
```

An edge-case guard handles manifests with `main: "."` — after `normalizeResolvedPath(".")` produces `"/."`, `resolvePackageEntry()` maps `"/"` and `"/."` to `"/index.js"` instead of allowing esbuild to try reading a directory.

**Exclusion behavior:** When `resolveAndProbeEntry()` reports an exclusion (a field-remapping set a package entry to `false`), the TarballPlugin respects the `remapFalse.packageRemapFalse` config: `"error"` (default) produces a build error; `"stub"` routes to an empty export via `EXCLUDED_MODULE_NAMESPACE`. See [Remapping and Exclusion Behavior](#remapping-and-exclusion-behavior).

---

### 4. VirtualFileSystemPlugin — *In-memory file layer*

> **Source:** [core/plugins/fs.ts](../core/plugins/fs.ts)

Provides the in‑memory filesystem. This is how the **entry point** (the code the user provides) and any local files are made available to esbuild.

The plugin registers three `onResolve` handlers with carefully scoped filters:

```
┌────────────────────┬─────────────┬──────────────────────────────────┐
│ Filter             │ Namespace   │ Catches                          │
├────────────────────┼─────────────┼──────────────────────────────────┤
│ /^(vfs:|virtual:)/ │ any         │ VFS-prefixed paths from anywhere │
│ /^\//              │ any         │ Absolute paths from anywhere     │
│ /^\.\.?\//         │ VFS only    │ Relative paths from VFS modules  │
└────────────────────┴─────────────┴──────────────────────────────────┘
```

**Why this scoping matters:**

- Relative path handling is limited to **VFS-namespace importers** — avoids intercepting relative imports inside HTTP-fetched modules (those belong to HttpPlugin)
- **Bare imports** (no `.` or `/` prefix) skip this plugin entirely → fall through to CDN

**Concrete example — resolving `./utils` inside a tarball-extracted package:**

Imagine this VFS state after extracting a tarball:

```
  /__tarballs__/a1b2c3d4/
    ├── package.json
    ├── index.ts               ← entry point
    ├── utils.ts               ← what we want to find
    └── helpers/
        └── index.tsx
```

```
  import "./utils" from index.ts
     │
     ▼  resolveVfsPath("/__tarballs__/a1b2c3d4/utils")
     │
     Step 1: Exact match ─ does "/utils" exist?      → NO
     Step 2: Extension probing:
             /utils.tsx ?                              → NO
             /utils.ts  ?                              → YES ✓
             │
             ▼  Return "/__tarballs__/a1b2c3d4/utils.ts"

  import "./helpers" from index.ts
     │
     ▼  resolveVfsPath("/__tarballs__/a1b2c3d4/helpers")
     │
     Step 1: Exact match ─ does "/helpers" exist?     → NO  (it's a directory)
     Step 2: Extension probing ─ /helpers.tsx? .ts?    → all NO
     Step 3: Index fallback:
             /helpers/index.tsx ?                       → YES ✓
             │
             ▼  Return "/__tarballs__/a1b2c3d4/helpers/index.tsx"
```

**Extension probing** in `resolveVfsPath()` follows a three-step algorithm:

1. **Exact match** — if the file exists at the given path, return it
2. **Extension probing** — append each of `RESOLVE_EXTENSIONS` (`.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json`). This triggers **not only for extensionless imports** but also for **suffix-style imports** where the extension is *not* a known resolvable one. For example, `./Expo.fx` has extension `.fx` which is not in `RESOLVE_EXTENSIONS`, so probing appends `.ts` → `./Expo.fx.ts` ✓. But `./index.ts` has `.ts` which *is* in `RESOLVE_EXTENSIONS`, so no further probing occurs.
3. **Index fallback** — try `<path>/index.{tsx,ts,jsx,js,css,json}`

> **Why suffix-style probing matters:** The React Native / Expo ecosystem uses non-standard suffixes like `.fx`, `.types`, and `.native` where the real files have an additional `.ts` or `.js` extension. Without this probing, imports like `./Expo.fx` produce `Could not resolve` errors because esbuild trusts the VFS plugin to handle resolution.

**Content pre-processing** runs in the `onLoad` handler: **Flow type stripping** (removes Flow annotations from React Native ecosystem files) and **JSX loader upgrade** (detects JSX in `.js` files). See [Content Pre-Processing](#content-pre-processing-flow-type-stripping).

---

### 5. HttpPlugin — *Fetch and resolve HTTP/HTTPS URLs*

> **Source:** [core/plugins/http.ts](../core/plugins/http.ts)

The workhorse for all HTTP/HTTPS resolution and loading. Serves **five roles**:

1. **Direct URL imports** — handles `import "https://esm.sh/react"` directly
2. **Relative import resolution** — resolves paths like `"./jsx-runtime.js"` against the **final URL** after redirects (critical because CDNs redirect `react@latest` → `react@19.0.0`)
3. **Manifest field remapping** — applies platform-specific path rewrites from `package.json` fields (`"browser"`, `"react-native"`, `"electron"`) to relative imports *within* a package, using the `packageBaseUrl` passed from CdnPlugin. See [Manifest Field Remapping](#manifest-field-remapping-for-relative-imports).
4. **Extension probing** — when a relative import has no extension, tries **18 combinations** (2 path variants × 9 extensions). Failed probes are cached in `failedExtensionChecks`.
5. **Registry mode propagation** — when the configured CDN host is a *registry*, bare imports encountered inside HTTP-fetched files are resolved through the registry rather than following the parent file's CDN origin.

**Concrete trace — resolving a relative import after a CDN redirect:**

```
  CdnPlugin resolves "react" → https://unpkg.com/react@19.0.0/index.js
     │
     ▼  HttpPlugin.onLoad fetches the URL
     HTTP 302: https://unpkg.com/react@19.0.0/index.js
              → https://unpkg.com/react@19.0.0/cjs/react.production.min.js
     │
     ▼  Store final URL in pluginData.url
     pluginData.url = "https://unpkg.com/react@19.0.0/cjs/react.production.min.js"
     │
     ▼  Inside that file: import "../jsx-runtime"
     HttpPlugin.onResolve receives { path: "../jsx-runtime", pluginData }
     │
     ▼  Resolve relative to FINAL url (not original!):
     urlJoin("...cjs/react.production.min.js", "../", "jsx-runtime")
     = "https://unpkg.com/react@19.0.0/jsx-runtime"
     │
     ▼  No extension? Extension probing begins:
     /jsx-runtime.js    → 200 ✓  (first hit wins)
     │
     ▼  Return { path: "https://unpkg.com/react@19.0.0/jsx-runtime.js",
              namespace: "http-url" }
```

> **Why the final URL matters:** If we resolved against the *original* URL (`/index.js`), the `../` would navigate wrong. CDN redirects can change directory depth, so we must track where we actually ended up.

**Concrete trace — manifest field remapping to `false`:**

```json
// readable-stream's package.json:
{ "browser": { "util": false, "./lib/stream.js": "./lib/stream-browser.js" } }
```

```
  Inside readable-stream: import "util"
     │
     ▼  HttpPlugin.onResolve
     applyManifestRemappings("util", manifest) → false
     │
     ▼  Check remapFalse.importRemapFalse (default: "stub")
     │
     ▼  Return { path: "util", namespace: "excluded-module" }
     │
     ▼  HttpPlugin.onLoad for excluded-module namespace:
     Return { contents: "export default {}", loader: "js" }
     + emit warning: "Module 'util' excluded via browser field"

  Inside readable-stream: import "./lib/stream.js"
     │
     ▼  applyManifestRemappings("./lib/stream.js", manifest)
     → "./lib/stream-browser.js"  (remapped, not excluded)
     │
     ▼  Fetch the browser-specific file instead
```

**Per-module exclusion handling:** When a manifest field remapping maps a module to `false`, the HttpPlugin respects `remapFalse.importRemapFalse`:

| Policy | Behavior |
|:-------|:---------|
| `"stub"` *(default)* | Return empty export via `EXCLUDED_MODULE_NAMESPACE` — spec-compliant, matches webpack/rollup |
| `"error"` | Produce a build error |
| `"external"` | Mark the import as external (preserved verbatim in output) |

The `onLoad` handler for `EXCLUDED_MODULE_NAMESPACE` serves an empty export (`export default {}`) and emits a warning (unless `warnOnStubbedRemapFalse` is `false`). See [Remapping and Exclusion Behavior](#remapping-and-exclusion-behavior).

**Content pre-processing** in the `onLoad` handler runs the same two transformations as VFSPlugin: Flow stripping and JSX loader upgrade. Also scans fetched source for `new URL("...", import.meta.url)` patterns to discover **WASM files** and **web workers**.

---

### 6. CdnPlugin — *Catch-all for bare npm imports*

> **Source:** [core/plugins/cdn.ts](../core/plugins/cdn.ts)

Runs last — by this point, every other strategy has had a chance. This plugin does the *heaviest* resolution work:

1. Parse the package specifier (name, version, subpath)
2. Fetch `package.json` from the configured CDN
3. Resolve the entry point through **conditional exports** or legacy fields via `resolvePackageEntry()` (from [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts))
4. Compute **side effects** metadata (for tree-shaking)
5. Construct the final CDN URL

Also handles **JSR specifiers** (`jsr:@scope/name`), **npm aliases** (`npm:pkg@version`), and **subpath imports** (`#internal/...`). The full resolution algorithm is detailed in [How Resolution Works](#how-resolution-works).

**Package-level exclusion handling:** When `resolvePackageEntry()` reports a package as excluded (e.g., `browser: false` for the entire package), the CdnPlugin respects `remapFalse.packageRemapFalse`:

| Policy | Behavior |
|:-------|:---------|
| `"error"` *(default)* | Produce a build error with a descriptive message based on `ExclusionReason` |
| `"stub"` | Route to an empty export via `EXCLUDED_MODULE_NAMESPACE` |

See [Remapping and Exclusion Behavior](#remapping-and-exclusion-behavior).

#### Registry Tarball Mode

When the CDN origin is a **registry** (`getCDNStyle(cdn) === "registry"` — triggered by `cdn: "npm"`, `cdn: "npm.registry"`, or `cdn: "https://registry.npmjs.org"`), the CdnPlugin downloads the **entire package tarball** instead of resolving individual files:

```
  ┌───── User code ──────┐            ┌──── Registry ─────┐
  │ import "react"       │──────────▶ │  registry.npmjs   │
  │ import "@scope/pkg"  │            │   .org/react/-    │
  └──────────────────────┘            │  /react-18.tgz    │
                                      └────────┬──────────┘
                                               │ extract
                                               ▼
                                      ┌──── VFS mount ─────┐
                                      │  /__tarballs__/    │
                                      │    <sha256>/...    │
                                      │  resolve via       │
                                      │  exports/main      │
                                      └────────────────────┘
```

The flow: resolve version → fetch manifest → construct tarball URL → route through TarballPlugin (which fetches, extracts to VFS, and resolves the entry point).

**Why registry mode exists:** Large packages with many internal imports (lodash-es, @aws-sdk/*) generate hundreds of individual HTTP fetches in CDN mode. Registry mode collapses this into a single tarball download + local VFS resolution. It also provides exact npm parity and eliminates CDN-specific quirks.

**Transitive dependency propagation.** All bare imports from within extracted tarballs also resolve through the registry via two complementary mechanisms:

1. **Global config** — when the user sets `cdn: "npm.registry"`, the CdnPlugin's origin is the registry for *every* bare import, and the HttpPlugin's `REGISTRY_HOST` check ensures HTTP-loaded files also route their deps through the registry.

2. **`pluginData` propagation** — when entry code uses direct registry tarball URLs (e.g., `https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz`) *without* an explicit `cdn: "npm.registry"` config, the TarballPlugin stores the source URL in `pluginData.tarballUrl`. The CdnPlugin detects this on subsequent bare imports and overrides the CDN origin to the tarball's registry. Because esbuild flows `pluginData` through the VFS `onLoad` → `onResolve` chain, the propagation is **self-sustaining** across the entire transitive dependency tree.

**Concrete trace — pluginData propagation across 3 levels of dependencies:**

```
  Entry code: import "https://registry.npmjs.org/express/-/express-4.21.0.tgz"
     │
     ▼  TarballPlugin extracts to VFS, stores:
     pluginData = { tarballUrl: "https://registry.npmjs.org/express/-/..." }
     │
     ▼  Resolved: /__tarballs__/abc123/index.js  (VFS namespace)
     │
     ▼  VFSPlugin.onLoad reads file, esbuild finds: import "body-parser"
     esbuild calls onResolve with SAME pluginData from parent
     │
     ▼  CdnPlugin.onResolve receives pluginData.tarballUrl
     Detects registry origin → overrides CDN to registry.npmjs.org
     Fetches body-parser tarball (not individual CDN files)
     Stores SAME tarballUrl pattern in new pluginData
     │
     ▼  body-parser's code: import "raw-body"
     Same propagation → raw-body also fetched from registry
     │
     ... and so on through the entire dependency tree
```

> **Like a genetic trait.** The first tarball URL "infects" every descendant import with registry-mode behavior. No global config change needed — the registry preference propagates through esbuild's own pluginData forwarding.

**Scoped registry support.** The CdnPlugin normalizes `BuildConfig.registry` at init time via `normalizeRegistryConfig()` (from [utils/npmrc.ts](../utils/npmrc.ts)). For each bare import, `getRegistryForPackage()` resolves the appropriate registry by scope — e.g., `@jsr/std__path` routes to `https://npm.jsr.io` while `react` routes to the default registry.

**Concrete example — scoped registry config:**

```typescript
// User config:
{
  cdn: "npm.registry",
  registry: {
    defaultRegistry: "https://registry.npmjs.org",
    scopedRegistries: {
      "@jsr":     "https://npm.jsr.io",
      "@myco":    "https://npm.pkg.github.com",
    }
  }
}
```

```
  import "react"          → getRegistryForPackage("react")
                             No scope match → default: registry.npmjs.org

  import "@jsr/std__path" → getRegistryForPackage("@jsr/std__path")
                             Scope "@jsr" matches → npm.jsr.io

  import "@myco/auth"     → getRegistryForPackage("@myco/auth")
                             Scope "@myco" matches → npm.pkg.github.com
```

Alternatively, pass raw `.npmrc` content and let `normalizeRegistryConfig()` parse it:

```typescript
{ registry: "@jsr:registry=https://npm.jsr.io\nregistry=https://registry.npmjs.org" }
```

**Auth tokens.** The `.npmrc` parser supports opt-in auth token extraction via `parseNpmrc(content, { extractAuth: true })`. When enabled, `getAuthHeaderForRegistry(url, config)` resolves a URL to a `Bearer <token>` header using longest-prefix matching. Auth is disabled by default — callers must explicitly opt in.

**Concrete example — auth token resolution:**

```
# .npmrc content:
@myco:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_abc123
```

```typescript
const config = parseNpmrc(npmrcContent, { extractAuth: true });

getAuthHeaderForRegistry("https://npm.pkg.github.com/@myco/auth", config)
  → "Bearer ghp_abc123"   // Longest-prefix match: //npm.pkg.github.com/

getAuthHeaderForRegistry("https://registry.npmjs.org/react", config)
  → undefined              // No matching auth token
```

> **Security boundary:** Auth extraction is off by default because bundlejs is a web-facing service. When embedding `@bundle/core` in a private CI tool, opt in with `{ extractAuth: true }` to authenticate against private registries.


## How Resolution Works

The CdnPlugin and its resolution utilities must faithfully implement the **Node.js module resolution algorithm** — the set of rules Node.js uses to find the actual file behind an `import` statement — but against *CDN-hosted packages* instead of a local `node_modules` directory.

bundlejs supports multiple CDN sources. The `cdn` config option selects which one — each has its own URL format (from [core/utils/cdn-format.ts](../core/utils/cdn-format.ts)):

| Config value | CDN URL | Style |
|:------------|:--------|:------|
| `"unpkg"` (default) | `https://unpkg.com` | npm |
| `"esm.sh"` or `"esm"` | `https://esm.sh` | npm |
| `"skypack"` | `https://cdn.skypack.dev` | npm |
| `"jsdelivr"` | `https://cdn.jsdelivr.net/npm` | npm |
| `"jsr"` | `https://jsr.io` | jsr |
| `"deno"` | `https://deno.land/x` | deno |
| `"github"` | `https://raw.githubusercontent.com` | github |
| `"npm"` or `"npm.registry"` | `https://registry.npmjs.org` | registry |
| Any full URL | Used directly | Detected from URL |


### Bare npm Imports — Conditional Exports

> **Spec:** [Node.js Conditional Exports](https://nodejs.org/api/packages.html#conditional-exports) define a JSON `"exports"` structure where each key is a subpath and each value maps condition names to file paths. The runtime picks the **first matching** condition in definition order.

When you write `import { useState } from "react"`, the CdnPlugin:

1. Parses the specifier → name: `react`, version: `null`, subpath: `null`
2. Resolves exact version via the registry (e.g., `19.0.0`)
3. Fetches `https://unpkg.com/react@19.0.0/package.json`
4. Reads `exports` and resolves `"."` (the root entry point)
5. Returns `https://unpkg.com/react@19.0.0/index.js` in the `http-url` namespace

The **condition priority chain** for bundlejs targeting browsers with ESM is:

```
  import → browser → module → default
  Fallback: require  (some packages only define CJS exports)
```

Conditions come from [utils/resolve-conditions.ts](../utils/resolve-conditions.ts) and vary by platform:

| Runtime | Extra conditions | `browserField`? |
|:--------|:-----------------|:----------------|
| Default (browser) | `["browser", "import", "module", "default"]` | ✅ yes |
| Deno | + `["deno", "node"]` | no |
| Bun | + `["bun", "node"]` | no |
| Node.js | + `["node"]`, no `"browser"` | no |
| Cloudflare Workers | + `["workerd", "worker", "browser"]` | no |
| Edge Light / Vercel | + `["edge-light", "worker", "browser"]` | ✅ yes |
| Electron (renderer) | + `["electron", "browser"]` | ✅ yes |
| React Native | + `["react-native"]` | no |

> **Where bundlejs deviates from Node.js:** The `"module"` condition is an esbuild convention, not part of the Node.js spec. Also, bundlejs passes `unsafe: true` to the resolver and retries with `require: true` as a compatibility fallback for packages that only define CJS exports. This deviates from the spec but dramatically improves compatibility with real-world npm packages.


### Subpath Exports and Imports

> **Spec:** [Subpath exports](https://nodejs.org/api/packages.html#subpath-exports) allow multiple entry points. [Subpath patterns](https://nodejs.org/api/packages.html#subpath-patterns) use `*` as a wildcard. [Subpath imports](https://nodejs.org/api/packages.html#subpath-imports) (keys starting with `#`) are private to the package.

```json
{
  "name": "@ui-lib/components",
  "exports": {
    ".": "./dist/index.js",
    "./*": "./dist/esm/*.js",
    "./features/*": "./dist/features/*/index.js"
  }
}
```

`import { Button } from "@ui-lib/components/button"` → matches `"./*"` → captures `"button"` → `./dist/esm/button.js`.

**Subpath imports** use the `#` prefix. bundlejs detects `#` in the CdnPlugin, looks up the *importer's* manifest, and resolves through `imports`. If resolution fails, it returns a hard error — `#`-prefixed imports are never retried as bare package names.

> **Implementation note:** Export/import matching is delegated to the [`resolve.exports`](https://www.npmjs.com/package/resolve.exports) library by @lukeed, which implements the full Node.js algorithm including pattern matching, `null` entries, and nested condition objects.


### Legacy Resolution — Packages Without `exports`

When no `exports` field exists, the resolver falls back to legacy fields. The fallback chain (from [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts)) depends on the platform:

| Platform | Legacy field priority |
|:---------|:---------------------|
| `browser` | `browser` → `module` → `main` |
| `node` | `module` → `main` |
| `neutral` | `module` → `main` |

> **Spec context:** `main` is the original Node.js field. `module` is a community convention from Rollup for ESM entry points (never part of Node.js). `browser` was [defined by the bundler community](https://github.com/nicolo-ribaudo/tc39-proposal-pkgjson-exports/blob/main/PRIOR-ART.md#browser) (Browserify, webpack) for browser-specific entries or module remappings.

The `browser` field has **two forms** with very different semantics:

- **String form** — replaces the entry point: `"browser": "./lib/browser.js"`
- **Object form** — a remapping layer applied to individual imports within the package, not an entry point itself

```json
{
  "name": "readable-stream",
  "main": "./lib/stream.js",
  "browser": {
    "./lib/internal/streams/pipeline.js": "./lib/internal/streams/pipeline-browser.js",
    "util": false
  }
}
```

With the object form, the entry comes from `main`. The object mappings are remappings — `import "util"` → `false` means **excluded**, `import "./pipeline.js"` → `./pipeline-browser.js`. The resolver checks `typeof browser` to distinguish the two forms.

> **Edge runtime subtlety.** Some edge runtimes (Cloudflare Workers, Vercel Edge) include `"browser"` in their conditions for `exports` but set `browserField: false` — they want browser-optimized code paths from `exports` but not legacy browser field remapping swaps.

If *all* legacy fields are missing, bundlejs applies a last-resort chain: `unpkg` field → `bin` field → `./index.js`.


### Manifest Field Remapping for Relative Imports

After URL resolution but *before* extension probing, the HttpPlugin checks whether a resolved relative path should be **remapped** to a platform-specific alternative. This handles packages that ship different implementations for different runtimes via `package.json` fields.

Three fields follow the same object-mapping pattern, processed in priority order by `applyManifestRemappings()` (from [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts)):

| Field | Convention | Priority |
|:------|:-----------|:---------|
| `"react-native"` | Metro bundler | 1 (highest) |
| `"electron"` | Electron apps | 2 |
| `"browser"` | Browserify / webpack / esbuild | 3 (lowest) |

The `REMAPPING_FIELDS` constant defines this ordering. When both `"browser"` and `"react-native"` conditions are active, the more-specific field wins.

**Concrete trace — platform remapping with priority resolution:**

```json
// Package manifest for "cross-platform-lib":
{
  "main": "./lib/index.js",
  "browser":       { "./lib/net.js": "./lib/net-browser.js" },
  "react-native":  { "./lib/net.js": "./lib/net-native.js" }
}
```

```
  Importing "./lib/net.js" inside cross-platform-lib:
     │
     ▼  applyManifestRemappings("./lib/net.js", manifest, activeConditions)
     │
     Active conditions include both "browser" and "react-native"
     │
     Iterate REMAPPING_FIELDS in priority order:
       1. "react-native" ─ field exists? YES → maps "./lib/net.js"?
          YES → "./lib/net-native.js"  ✂ first match wins
       2. "electron"      ─ (skipped, already found)
       3. "browser"       ─ (skipped, already found)
     │
     ▼  Result: "./lib/net-native.js"  (react-native wins over browser)
```

> **Priority matters in practice:** Without this ordering, a React Native app bundling `readable-stream` would get the browser shim instead of the native implementation — subtly wrong behavior that's hard to debug.

If a remapping maps to `false`, the module is handled by the [exclusion system](#remapping-and-exclusion-behavior) rather than fetched.


### Side Effects and Tree-Shaking

> **Convention:** The `sideEffects` field is a [webpack convention](https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free) adopted by most bundlers. Tree-shaking needs this signal to know which files are safe to discard when their exports are unused.

bundlejs reads `sideEffects` from `package.json` (via [core/utils/side-effects.ts](../core/utils/side-effects.ts)):

| `sideEffects` value | Meaning |
|:----|:----|
| `false` | Entire package is side-effect-free — safe to tree-shake aggressively |
| `["*.css", "./src/init.js"]` | Only listed files have side effects |
| Not present | Assume everything has side effects (conservative) |

Glob patterns are normalized to `**/*.css` to match anywhere in the package tree. Side-effects analysis only applies to **JS-like files** (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.mts`, `.cts`, or no extension) — CSS and asset files are excluded because they *must* execute to have effect.

**Concrete example — tree-shaking `lodash-es`:**

```typescript
// User code:
import { debounce } from "lodash-es";
```

```json
// lodash-es/package.json:
{ "sideEffects": false }
```

```
  lodash-es has 600+ modules.
  sideEffects: false tells esbuild: "every file is safe to remove if unused."

  esbuild resolution:
    "lodash-es" → exports["."] → ./lodash.js  (barrel file re-exporting everything)
     │
     ▼  lodash.js: export { default as debounce } from "./debounce.js";
                  export { default as throttle } from "./throttle.js";
                  export { default as map } from "./map.js";
                  ... 600+ re-exports
     │
     ▼  User only imports { debounce }.
     sideEffects: false → esbuild drops throttle.js, map.js, and 598 others.
     │
     ▼  Final bundle: only debounce.js + its internal deps (~1 kB vs ~80 kB)
```

Without `sideEffects: false`, esbuild must *conservatively assume* every `import` could have side effects (global polyfills, prototype patches, etc.) and include all 600+ modules.


### JSR Modules — Deno's TypeScript-First Registry

> **Spec:** [JSR](https://jsr.io) (JavaScript Registry) is a modern package registry that publishes TypeScript `.ts` source directly — no pre-compiled JS, scoped by default (`@scope/name`), semver-native resolution.

When you write `import { join } from "jsr:@std/path@1.0.0"`, the CdnPlugin:

1. Parses `jsr:` prefix → scope: `std`, name: `path`, version: `1.0.0`
2. If the version is a range → calls `resolveJSRVersion()` against `https://jsr.io/@std/path/meta.json`
3. Fetches version metadata → resolves subpath via `exports` (typically `"."` → `./mod.ts`)
4. Returns `https://jsr.io/@std/path/1.0.0/mod.ts`

If direct JSR resolution fails, bundlejs falls back to `esm.sh`'s JSR proxy.


### npm Aliases

```json
{
  "dependencies": {
    "react": "npm:preact@10.24.0"
  }
}
```

The CdnPlugin detects the `npm:` prefix via `parseNpmSpec()`, unwraps the alias (`effectiveName` = `preact`, `effectiveVersion` = `10.24.0`), and continues resolution normally. Nested aliases (`npm:npm:foo`) are rejected.


### URL Dependencies and Tarball Extraction

npm's `package.json` allows URL-based dependency versions — any `https://` URL pointing to a `.tgz` tarball is valid. The CdnPlugin classifies these as `UrlSpec` and re-enters the plugin chain via `build.resolve()`. The TarballPlugin intercepts and runs:

```
  URL: https://pkg.pr.new/@tanstack/react-query@7988
       │
       ▼
  TarballPlugin detects tarball CDN (getCDNStyle → "tarball")
       │
       ▼
  Hash the URL → SHA-256 → "a1b2c3d4e5f6g7h8" (16 chars)
       │
       ▼
  Check: is /__tarballs__/a1b2c3d4e5f6g7h8/ already in VFS?
       │
    ┌──┴──┐
    │ YES │ → Skip fetch, reuse mount
    │ NO  │ → Fetch .tgz → detect format → decompress → extract
    └──┬──┘
       │
       ▼
  Write all files to VFS → resolveAndProbeEntry() → final VFS path
```

> **Extraction limits:** The extraction path currently supports **gzip-compressed** tars and **uncompressed** tars. Other formats (zstd, xz, bzip2, lz4) are detected but produce a clear error. This is sufficient — npm tarballs are always gzip-compressed.


### Relative Imports and CDN Redirects

CDNs frequently redirect — `react@19.0.0/index.js` might redirect to `react@19.0.0/es2022/index.js`. The HttpPlugin stores the **final URL** in `pluginData.url` and resolves relative imports against it:

```typescript
resolvedPath = urlJoin(args.pluginData?.url, "../", argPath);
```

When a relative import has no extension, up to 18 URL combinations are tried (2 path variants × 9 extensions). This is a pragmatic deviation from Node.js (which does not probe) — many CDN-served packages were built for bundlers that do.

**Why 18 combinations?** Two path interpretations ("/utils" as a file vs. "/utils/index") times 9 possible extensions (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.css`, `.json`, no extension). Each combination is a HEAD or GET request:

```
  import "./utils" (no extension)
     │
     ▼  Extension probing — try as file:
     ./utils.js → 404    ./utils.mjs → 404    ./utils.ts → 404
     ./utils.tsx → 404   ./utils.jsx → 404    ./utils.css → 404
     ./utils.json → 404  ./utils.cjs → 404    ./utils → 404
     │
     ▼  Try as directory (index file):
     ./utils/index.js → 200 ✓  (found!)
```

Failed URLs are cached in `failedExtensionChecks` so the same 404 isn't fetched twice in a build.


### Import Maps

bundlejs supports [WHATWG import maps](https://html.spec.whatwg.org/multipage/webappapis.html#import-maps) through [utils/resolve-import-map.ts](../utils/resolve-import-map.ts). Resolution checks **scopes** first (sorted by key length, per spec), then falls back to top-level **imports**.

**Concrete example — import map with scopes:**

```json
{
  "imports": {
    "lodash": "https://esm.sh/lodash@4.17.21"
  },
  "scopes": {
    "https://unpkg.com/my-lib/": {
      "lodash": "https://esm.sh/lodash@3.10.0"
    }
  }
}
```

```
  import "lodash" from entry code (/index.ts)
     │
     ▼  No scope matches "/index.ts"
     Fall back to top-level imports: "lodash" → https://esm.sh/lodash@4.17.21

  import "lodash" from https://unpkg.com/my-lib/utils.js
     │
     ▼  Scope "https://unpkg.com/my-lib/" matches the importer URL
     Scoped mapping: "lodash" → https://esm.sh/lodash@3.10.0  (older version!)
```

> **Scopes let different parts of your dependency tree use different versions** — like npm's nested `node_modules`, but declarative.


### Unsupported Dependency Types

| Type | Example | Supported? |
|:-----|:--------|:-----------|
| **semver** | `^1.2.3` | ✅ |
| **tag** | `latest`, `next` | ✅ |
| **alias** | `npm:preact@^10` | ✅ |
| **url** | `https://pkg.pr.new/...` | ✅ (via TarballPlugin) |
| **jsr** | `jsr:@std/path@1.0.0` | ✅ (via JSR API) |
| `git` | `github:user/repo#...` | ❌ Error |
| `file` | `file:./local.tgz` | ❌ Use `vfs:`/`virtual:` equivalents |
| `workspace` | `workspace:*` | ❌ Error |
| `link` | `link:../sibling` | ❌ Error |


## Remapping and Exclusion Behavior

Path remapping fields (`browser`, `react-native`, `electron`) can map packages or individual modules to `false`, meaning "this doesn't exist on this platform." The `remapFalse` config controls how the bundler reacts.

### Two Levels of Exclusion

**Package-level exclusion** occurs when the entire package resolves to `false` — e.g., `"browser": false` at the top level, or `exports` conditions that resolve to nothing. Handled by **CdnPlugin** and **TarballPlugin**.

**Per-module exclusion** occurs when a single file inside a package is remapped to `false` — e.g., `"browser": { "./server.js": false }`. Handled by **HttpPlugin**.

**Concrete example — what each policy produces for `import "net"` inside a package with `"browser": { "net": false }`:**

```
  Policy: "stub" (default for importRemapFalse)
  ────────────────────────────────────────
  Build succeeds. The import is replaced with:
    export default {};
  Plus a warning: ⚠ Module 'net' excluded via browser field in <package>
  Result: code that references `net` gets an empty object. Safe for most cases.

  Policy: "error" (default for packageRemapFalse)
  ────────────────────────────────────────
  Build FAILS with:
    ✘ [ERROR] Module 'net' has been excluded (reason: browser-remapping)
  Result: hard failure. Forces user to address the dependency.

  Policy: "external"
  ────────────────────────────────────────
  Build succeeds. The import is preserved verbatim in the output:
    import net from "net";
  Result: deferred to the runtime environment. Useful when deploying to Node.js.
```

### Configuration

```typescript
interface RemapFalseBehavior {
  /** Policy for whole-package exclusions. Default: "error" */
  packageRemapFalse?: "error" | "stub";

  /** Policy for per-module exclusions. Default: "stub" */
  importRemapFalse?: "stub" | "error" | "external";

  /** Emit esbuild warning when stubbing. Default: true */
  warnOnStubbedRemapFalse?: boolean;
}
```

The `BuildConfig.remapFalse` field accepts a `RemapFalseBehavior` object. Defaults:

```typescript
remapFalse: {
  packageRemapFalse: "error",      // Whole-package exclusion → build error
  importRemapFalse: "stub",        // Per-module exclusion → empty export
  warnOnStubbedRemapFalse: true,   // Emit warning on stub
}
```

### Policy Behaviors

| Policy | Effect |
|:-------|:-------|
| `"error"` | Produce a build error with a descriptive message including the exclusion reason (`ExclusionReason`: `"field-remapping"`, `"no-entry-point"`, `"browser"`, or `"browser-remapping"`) |
| `"stub"` | Return an empty export (`export default {}`) via the `EXCLUDED_MODULE_NAMESPACE` — spec-compliant, matches webpack/rollup behavior |
| `"external"` | Mark the import as external (preserved verbatim in output, resolved at runtime). Only available for per-module exclusions. |

When `"stub"` is active and `warnOnStubbedRemapFalse` is `true` (default), the `onLoad` handler for `EXCLUDED_MODULE_NAMESPACE` emits an esbuild warning. Set to `false` to suppress.

### Enforcement Sites

```
  Package-level exclusion:
    CdnPlugin  (onResolve) ─── checks remapFalse.packageRemapFalse
    TarPlugin  (onResolve) ─── checks remapFalse.packageRemapFalse  (3 branches)

  Per-module exclusion:
    HttpPlugin (onResolve) ─── checks remapFalse.importRemapFalse

  Stub serving:
    HttpPlugin (onLoad)    ─── EXCLUDED_MODULE_NAMESPACE handler
                               respects suppressWarning from pluginData
```


## Content Pre-Processing: Flow Type Stripping

> **Source:** [core/utils/flow-strip.ts](../core/utils/flow-strip.ts)

After a file is resolved and fetched, but *before* esbuild parses it, bundlejs runs content-aware transformations. The most significant is **Flow type stripping** — removing Meta's [Flow](https://flow.org/) type annotations from JavaScript files.

> **Why this exists:** The React Native / Metro / Expo ecosystem ships raw Flow-annotated `.js` files to npm. Metro (React Native's bundler) strips Flow via Babel automatically — but every other bundler (esbuild, webpack, Rollup) chokes on Flow syntax like `import typeof`, `opaque type`, and `$Exact<T>`. The specific trigger: `react-native`'s `index.js` contains `import typeof ActionSheetIOS from '...'` — invalid in both JavaScript and TypeScript.

**Before and after — what Flow stripping does to real React Native code:**

```javascript
// BEFORE (raw from npm — this is valid Flow, invalid JS):
import typeof ActionSheetIOS from './Libraries/ActionSheetIOS/ActionSheetIOS';
import type { ColorValue } from './Libraries/StyleSheet/StyleSheet';

export opaque type NativeComponentType<T> = HostComponent<T>;

const Platform: $Exact<PlatformConstants> = { OS: 'ios' };
```

```javascript
// AFTER (flow-remove-types output — valid JS, parseable by esbuild):
import              ActionSheetIOS from './Libraries/ActionSheetIOS/ActionSheetIOS';
/*    type { ColorValue }                                                       */

/*    opaque type NativeComponentType<T> = HostComponent<T> */

const Platform          /*                  */ = { OS: 'ios' };
```

> Notice: `flow-remove-types` replaces type annotations with whitespace, preserving source positions so source maps remain valid. The `import typeof` becomes a regular `import`, `opaque type` becomes a comment, and type annotations like `$Exact<...>` are blanked out.

### Three-Layer Pipeline

```
  Layer 1: Detection ── containsFlow(content, opts?)
           │
           ├─ Known-package lookup (Set: "react-native")
           ├─ URL heuristic (/react-native/ in URL path)
           ├─ @flow pragma scan (first 4 KB)
           └─ Syntax pattern scan (import typeof, opaque type, $Exact, ...)
           │
           └─ false? Return unchanged. Zero overhead.
           │
           ▼ true
  Layer 2: Full stripping ── flow-remove-types (hermes-parser WASM)
           │
           ├─ AST-based type removal, preserves source positions
           ├─ Inline source map when build has sourcemap enabled
           └─ Falls through on parse error
           │
           ▼ fallback
  Layer 3: Regex fallback ── regexStripFlow()
           │
           └─ Best-effort: @flow pragmas, import typeof, import/export type
              Does NOT handle inline annotations or opaque type bodies
```

**Integration:** Both HttpPlugin (`onLoad`) and VFSPlugin (`onLoad`) call `maybeStripFlow()` on every file. The cost for non-Flow builds is just the `containsFlow()` check — a fast regex test against the first 4 KB per file. The `flow-remove-types` package (based on Meta's `hermes-parser` compiled to WASM) is only imported when Flow is actually detected.

**Flow + JSX:** React Native packages often contain *both* Flow and JSX in the same `.js` file. Flow stripping runs *before* loader inference, so the stripped content (clean JS) is passed to `inferLoader()`, which may upgrade the loader from `ts` to `tsx` if JSX is detected. See [Scenario 18 — JSX in `.js` Files](scenarios/18-jsx-in-js-files.md).


## Plugin Shared State

All six plugins share state through a **`Context`** object — a reactive, hierarchical data container built on `EventTarget` and `Proxy` (defined in [core/context/context.ts](../core/context/context.ts)).

Every build creates a **`LocalState`** (from [core/types.ts](../core/types.ts)):

```typescript
interface LocalState {
  filesystem: IFileSystem;               // In-memory VFS for entry points and fetched files
  config: BuildConfig;                   // Merged build configuration
  host: string;                          // Active CDN origin (e.g., "https://unpkg.com")
  versions: Map<string, string>;         // Resolved package version cache
  assets: OutputFile[];                  // Discovered assets (WASM, workers, etc.)
  tarballMounts: Map<string, TarballMount>;       // Extracted tarball metadata
  tarballInflight: Map<string, Promise>;           // Deduplicates concurrent tarball fetches
  packageManifests: Map<string, PackageJson>;      // Cached package.json manifests
  sideEffectsMatchersCache: Map<string, SideEffectsMatchers>;  // Compiled sideEffects globs
  failedExtensionChecks: Set<string>;    // URLs that failed extension probing (avoid retrying)
  failedManifestUrls: Set<string>;       // Manifest URLs that 404'd
}
```

The Context supports **two data modes**:

| Mode | Behavior | Example |
|:-----|:---------|:--------|
| **Shared** | Inherited from parent — changes propagate bidirectionally | Manifest cache, VFS, version cache |
| **Isolated** | Created via `withContext()` — child changes don't affect parent | CdnPlugin's `origin` setting |

> **`Context.opaque()`** marks values as *unproxyable* — `Map`, `Set`, `Promise`, and `ArrayBuffer` break under proxy interception, so they are excluded from reactive wrapping.

Three accessor functions: `fromContext("key", ctx)` (read), `toContext("key", value, ctx)` (write), `withContext({ key: value }, ctx)` (create scoped child).

**Concrete example — shared vs. isolated data:**

```typescript
// CdnPlugin gets its own isolated "origin" so it doesn't pollute other plugins:
const cdnContext = withContext({ origin: "https://unpkg.com" }, StateContext);

// CdnPlugin writes to the shared VFS — all plugins see extracted tarballs:
const fs = fromContext("filesystem", cdnContext);  // same object as parent
await setFile(fs, "/__tarballs__/abc123/index.js", content);

// VFSPlugin reads the same filesystem — can see the file just written:
const sameFs = fromContext("filesystem", StateContext);  // identical reference
sameFs.hasFile("/__tarballs__/abc123/index.js");  // true ✓

// But VFSPlugin can't see CdnPlugin's origin:
fromContext("origin", StateContext);  // undefined (isolated to cdnContext)
```

> **Think of it like a two-way mirror.** Shared state (VFS, caches) is a window — both sides see and modify the same data. Isolated state (`withContext`) is a private room — the child can see out, but the parent can't see in.


## The Edge Runtime

The HTTP API layer lives in `@bundle/edge` and runs on **[Deno Deploy](https://deno.com/deploy)**. The entry point exports a `fetch` handler (in [edge/mod.ts](../edge/mod.ts)):

```typescript
export default {
  async fetch(req: Request) {
    // parse URL, check cache, run build, compress, respond
  }
}
```

### Request Lifecycle

```
  Request arrives
       │
       ▼
  ┌──────────────────────┐
  │ 1. Parse query       │  ?q=react&treeshake=[{useState}]
  │    (parse-query.ts)  │  → BuildConfig
  └─────────┬────────────┘
            │
            ▼
  ┌────────────────────┐
  │ 2. Check Redis     │  Key: SHA-256(config + input)
  │    cache hit?      │
  └──┬──────────┬──────┘
     │ hit      │ miss
     ▼          ▼
  Return    ┌───────────────────┐
  cached    │ 3. Write entry    │  User code → VFS
  result    │ 4. Build          │  @bundle/core.build()
            │ 5. Compress       │  @bundle/compress
            │ 6. Cache & return │  Store in Redis, respond
            └───────────────────┘
```

**Query parameter reference:**

| Parameter | Example | Effect |
|:----------|:--------|:-------|
| `q` | `react,vue` | Packages to bundle (comma-separated) |
| `treeshake` | `[{useState}],[*]` | Per-package named exports |
| `share` | *(LZ-string)* | Compressed code for large inputs |
| `config` | `{"cdn":"esm.sh"}` | JSON5 config object |
| `badge` | `true` or `detailed` | SVG badge image |
| `file` | *(flag)* | Raw bundled JavaScript output |
| `analysis` | *(flag)* | esbuild bundle analysis (HTML) |
| `metafile` | *(flag)* | esbuild metafile JSON |
| `polyfill` | *(flag)* | Enable Node.js polyfills |
| `minify` | `false` | Disable minification |
| `format` | `cjs` | Output format (`esm`, `cjs`, `iife`) |


## Caching Architecture

bundlejs uses **multi-tiered caching**:

```
  Request
    │
    ▼
  Redis (Upstash)    ── Tier 1: Edge-level, TTL 24h, SHA-256 key
    │ miss
    ▼
  Cache API          ── Tier 2: Runtime-level, within Deno Deploy isolate
    │ miss
    ▼
  In-memory LRU      ── Tier 3: Process-level, 300 responses + 500 redirects
    │ miss
    ▼
  Network fetch
```

Responses are cached under the **final URL** after redirects — not the original request URL. A separate redirect map tracks *original → final* mappings.

**Per-build caches** (not persisted) live in `LocalState`: `packageManifests`, `versions`, `sideEffectsMatchersCache`, `failedExtensionChecks`, `failedManifestUrls`.

**Concrete example — cache key flow for a build request:**

```
  Request: /?q=react&treeshake=[{useState}]
     │
     ▼  Parse query → BuildConfig + generated entry:
     entry = 'export { useState } from "react";'
     │
     ▼  Compute Redis cache key:
     SHA-256( JSON.stringify(config) + entry )
     = "e3b0c44298fc1c14..."  (64 hex chars)
     │
     ▼  Redis lookup: GET "e3b0c44298fc1c14..."
     ├─ HIT  → return cached JSON (skip build entirely)
     └─ MISS → run build, then:
              SET "e3b0c44298fc1c14..." = result  (TTL: 24 hours)
```

Same config + same entry code = same cache key, so identical requests from different users hit the cache.


## Compression

After bundling, `@bundle/compress` compresses the output to report production size numbers. The `compress()` function accepts `Uint8Array` chunks and returns both compressed and uncompressed sizes.

| Algorithm | Implementation | Notes |
|:----------|:--------------|:------|
| **gzip** *(default)* | Native `CompressionStream` API | Fastest, no WASM |
| **brotli** | WASM module, quality 1–11 | Best compression ratio |
| **zstd** | WASM module, quality 1–11 | Fast decompression |
| **lz4** | WASM module | Fastest decompression |

Brotli, zstd, and lz4 WASM modules are **lazily loaded**.

**Concrete example — what the compression step produces:**

```typescript
// After esbuild produces the bundled output:
const bundledCode = new TextEncoder().encode(esbuildOutput);  // 6,720 bytes

// compress() returns both sizes:
const result = await compress(bundledCode, "gzip");
// result = {
//   compressedSize: 2398,          → "2.34 kB" (what you'd ship)
//   uncompressedSize: 6720,        → "6.72 kB" (what esbuild produced)
// }
```

> **Why both sizes?** The uncompressed size shows what esbuild generated after tree-shaking and minification. The compressed size shows what users actually download — the number that matters for page load performance. The difference between the two reveals how compressible the code is.


## Configuration Reference

The full `BuildConfig` interface (from [core/types.ts](../core/types.ts)):

```typescript
interface BuildConfig {
  // Entry points and CDN
  entryPoints?: string[];                // Default: ["/index.tsx"]
  cdn?: string;                          // Default: "https://unpkg.com"
  alias?: Record<string, string>;        // Package aliases: { "fs": "memfs" }
  polyfill?: boolean;                    // Default: false

  // Registry configuration
  registry?: string | RegistryConfig;    // URL, raw .npmrc content, or RegistryConfig object

  // Remapping exclusion behavior
  remapFalse?: {
    packageRemapFalse?: "error" | "stub";             // Default: "error"
    importRemapFalse?: "stub" | "error" | "external"; // Default: "stub"
    warnOnStubbedRemapFalse?: boolean;                 // Default: true
  };

  // esbuild options (passed through directly)
  esbuild?: {
    target?: string[];                   // Default: ["esnext"]
    format?: "esm" | "cjs" | "iife";    // Default: "esm"
    platform?: "browser" | "node" | "neutral";  // Default: "browser"
    minify?: boolean;                    // Default: true
    treeShaking?: boolean;               // Default: true
    sourcemap?: boolean | "inline" | "external";
    metafile?: boolean;
    external?: string[];
    define?: Record<string, string>;
    // ... all standard esbuild BuildOptions
  };

  // Resolution conditions
  resolve?: {
    runtime?: string;          // Deno, Bun, Cloudflare Workers, etc.
    conditions?: string[];     // Custom export conditions
  };

  // Virtual package.json for dependency versions
  "package.json"?: PackageJson;

  // Output formatting
  ansi?: "html" | "html-and-ansi" | "ansi";

  // Initialization
  init?: {
    platform?: Platform;       // Auto-detected
    version?: string;          // esbuild version (default: "0.27.2")
    wasmModule?: WebAssembly.Module;
    wasmURL?: string;
  };
}
```

Default build config (from [core/build.ts](../core/build.ts)):

```typescript
export const BUILD_CONFIG: BuildConfig = {
  entryPoints: ["/index.tsx"],
  cdn: DEFAULT_CDN_HOST,     // "https://unpkg.com"
  polyfill: false,
  remapFalse: {
    packageRemapFalse: "error",
    importRemapFalse: "stub",
    warnOnStubbedRemapFalse: true,
  },
  esbuild: {
    color: true,
    globalName: "BundledCode",
    logLevel: "info",
    sourcemap: false,
    target: ["esnext"],
    format: "esm",
    bundle: true,
    minify: true,
    treeShaking: true,
    platform: "browser",
    jsx: "transform",
  },
  ansi: "ansi",
  init: { platform: PLATFORM_AUTO },
};
```

At build time, these are augmented with explicit **loader mappings** and **defines**:

```typescript
loader: {
  ".png": "file",    ".jpeg": "file",    ".ttf": "file",
  ".svg": "text",    ".html": "text",    ".scss": "css",
},
define: {
  "__NODE__": "false",
  "process.env.NODE_ENV": "\"production\"",
},
write: false,        // Output to memory, not filesystem
outdir: "/",
```

> **WASM loading.** esbuild is always loaded as WebAssembly via `getEsbuild()` in [core/utils/get-esbuild.ts](../core/utils/get-esbuild.ts), using **esbuild v0.27.2**. The WASM binary is embedded as an encoded string in [core/wasm.ts](../core/wasm.ts) — no filesystem or network dependency for loading esbuild itself. WASM esbuild is roughly 2–5× slower than the native Go binary, but runs everywhere JavaScript runs.


## Resource Lifecycle & Explicit Resource Management

bundlejs implements the [TC39 Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) proposal. Every `build()`, `transform()`, and `context()` call returns an object that implements `Disposable` and `AsyncDisposable`, enabling the `using` / `await using` syntax for automatic cleanup.

### Why this matters

Each build creates per-build resources that must be torn down when the caller is finished:

- **Background stale-while-revalidate (SWR) fetches** — the caching layer fires `void backgroundRefresh(…)` calls that update the cache for future requests. Without cancellation, these outlive the build and cause resource leaks (Deno's test sanitizer flags them as leaked `fetchCancelHandle` / `op_cache_put` ops).
- **In-flight request deduplication** — the `inflight` LRU map tracks pending network requests so concurrent builds don't duplicate HTTP calls.
- **Plugin-registered resources** — plugins can register arbitrary cleanup callbacks on the per-build `AsyncDisposableStack` (workers, WASM runtimes, streams, etc.).

### Per-build lifecycle

Each `build()` and `context()` call creates:

1. An **`AsyncDisposableStack`** (`scope`) — collects cleanup callbacks in LIFO order
2. An **`AbortController`** (`abort`) — its signal threads through all background fetches

Both are stored on `LocalState` and available to plugins via `fromContext('scope', StateContext)` and `fromContext('abort', StateContext)`.

```
  build() / context()
       │
       ├── Create AsyncDisposableStack (scope)
       ├── Create AbortController (abort)
       ├── Register: scope.defer(() => abort.abort())
       │
       ├── Run esbuild with plugin pipeline
       │     ├── HttpPlugin: passes abort.signal to fetchPkg / fetchPkgHeaders
       │     ├── TarPlugin: passes abort.signal to fetchWithCache
       │     └── Background SWR refreshes carry abort.signal
       │
       └── Return result with [Symbol.asyncDispose] → scope.disposeAsync()
                                                       ├── abort.abort()
                                                       └── (any plugin-registered cleanup)
```

### Usage patterns

**`build()` — one-shot build with automatic cleanup:**

```typescript
import { build } from '@bundle/core';

{
  await using result = await build({ entryPoints: ['/index.tsx'] });
  console.log(result.contents[0].text);
}
// ← background fetches aborted, per-build scope disposed
```

**`context()` — long-lived context for watch/rebuild:**

```typescript
import { context, rebuild, dispose } from '@bundle/core';

{
  await using ctx = await context({ entryPoints: ['/index.tsx'] });
  const r1 = await rebuild(ctx);
  // … modify VFS …
  const r2 = await rebuild(ctx);
}
// ← esbuild context disposed, background fetches aborted, scope cleaned up
```

**`transform()` — stateless, dispose is a no-op:**

```typescript
import { transform } from '@bundle/core';

await using result = await transform('export const x = 1;');
console.log(result?.code);
// ← no-op dispose (transform has no per-call resources)
```

**Releasing the global WASM worker:**

The esbuild WASM worker is a global singleton shared across builds. It is **not** torn down by per-build disposal (since you usually want it alive for subsequent builds). Call `stop()` explicitly when completely done:

```typescript
import { build, stop } from '@bundle/core';

await using result = await build({ entryPoints: ['/index.tsx'] });
// … use result …

await stop(); // terminate WASM worker, free memory
```

### Error handling

If `build()` or `context()` throws during setup (before returning a result), the function itself cleans up the `AsyncDisposableStack` before re-throwing. The caller never receives a disposable object, so no cleanup is needed on their end.

```typescript
try {
  await using result = await build({ /* invalid config */ });
} catch (e) {
  // Resources already cleaned up by build() — no leak
}
```


## Using bundlejs as a Building Block

### As a library

```typescript
import { build, transform, stop } from "@bundle/core";

{
  await using result = await build({
    entryPoints: ["/index.ts"],
    cdn: "esm.sh",
    esbuild: { format: "esm", minify: true },
  });
  // result.contents → minified output files
  // result.packageSizeArr → per-package install sizes
}
// ← per-build resources disposed automatically

await stop(); // release esbuild WASM worker when completely done
```

### With a custom VFS

```typescript
import { build, useFileSystem, setFile, stop } from "@bundle/core";

const fs = useFileSystem();
const fsInstance = await fs;
await setFile(fsInstance, "/index.ts", `export { useState } from "react";`);

{
  await using result = await build({ entryPoints: ["/index.ts"] }, fs);
  // use result.contents…
}

await stop(); // release WASM worker
```

### With incremental builds

```typescript
import { context, rebuild } from "@bundle/core";

{
  await using ctx = await context({ entryPoints: ["/index.ts"] });
  const result1 = await rebuild(ctx);  // First build
  // ... modify VFS ...
  const result2 = await rebuild(ctx);  // Incremental, faster
}
// ← ctx automatically disposed (esbuild context + abort + scope)
```

### In CI pipelines

```sh
# Check bundle size of a package
curl "https://deno.bundlejs.com/?q=@tanstack/react-query&treeshake=[{useQuery}]"

# Get a badge for your README
# https://deno.bundlejs.com/?q=my-package&badge
```

### As an importable bundle

```typescript
import { something } from "https://deno.bundlejs.com/?q=my-package&file";
```

### Event system

The event system (in [core/configs/events.ts](../core/configs/events.ts)) uses the web-standard `EventTarget` API:

| Event | When |
|:------|:-----|
| `bundlejs.init.start` | esbuild WASM initialization begins |
| `bundlejs.init.complete` | esbuild ready |
| `bundlejs.init.error` | Initialization failed |
| `bundlejs.build.error` | Build failed |
| `bundlejs.logger.*` | Info/warn/error logging |


## Limitations, Trade-offs, and Gotchas

| Limitation | Details |
|:-----------|:--------|
| **WASM esbuild is slower** | ~2–5× slower than native Go. Acceptable for size checks; too slow for build-on-save. |
| **CDN dependency** | If unpkg goes down, resolution fails. Configurable CDN mitigates; *no automatic failover*. |
| **Extension probing = HTTP requests** | Up to 18 URL probes per extensionless import. HTTP/2 multiplexing and `failedExtensionChecks` caching help. |
| **No git/workspace/link deps** | These require local filesystem or git. `file:` specs can use `vfs:`/`virtual:` equivalents. |
| **Browser field inconsistency** | The dual-form `browser` field is npm's most inconsistent convention. bundlejs follows Node.js spec + esbuild behavior. |
| **`"module"` condition is non-standard** | bundlejs (via esbuild) injects `"module"`. Matches webpack/Rollup/esbuild; absent from Node.js. |
| **No dynamic import resolution** | `import(someVariable)` cannot resolve at build time (esbuild limitation). |
| **Tarball decompression** | Only gzip + uncompressed tars extracted. npm tarballs are 100% gzip. Detection layer is broader. |
| **Registry mode downloads full tarballs** | `cdn: "npm"` downloads the whole `.tgz`. Content-addressed cache ensures one fetch per package. Faster than hundreds of CDN requests for large packages. |
| **`.npmrc` auth is opt-in** | Auth tokens are only extracted when `extractAuth: true` is passed. Security boundary for the web-facing bundler. |
| **Env vars for full functionality** | `UPSTASH_URL`/`UPSTASH_TOKEN` (Redis), `GITHUB_AUTH_TOKEN` (gist links). Degrades gracefully without them. |
| **`await using` recommended** | Callers should use `await using result = await build(…)` to ensure cleanup. Without it, per-build background fetches may outlive the caller and leak resources. |


## What to Do Next

1. **Run the edge API locally.** `deno serve -A --watch edge/mod.ts` — hit it with `/?q=preact`, inspect JSON.

2. **Try tree-shaking.** Compare `/?q=lodash-es` vs `/?q=lodash-es&treeshake=[{debounce}]`.

3. **Read the plugin pipeline.** Start at [core/build.ts](../core/build.ts), then read each plugin's `onResolve` and `onLoad` handlers in order.

4. **Trace a resolution.** Pick a package and walk through CdnPlugin's `onResolve`: `parsePackageName` → `getCDNUrl` → `resolvePackageEntry` → final URL.

5. **Compare CDN options.** `/?q=react&config={"cdn":"esm.sh"}` vs `/?q=react&config={"cdn":"jsdelivr"}`.

6. **Try registry mode.** `/?q=lodash-es&config={"cdn":"npm.registry"}` — downloads tarballs instead of individual files.

7. **Try scoped registries.** `/?q=@jsr/std__path&config={"cdn":"npm.registry","registry":{"scopedRegistries":{"@jsr":"https://npm.jsr.io"}}}`.

8. **Test tarball resolution.** Use `pkg.pr.new`, an npm registry tarball URL, or place a `.tgz` file in VFS — all three are handled by TarballPlugin.

9. **Configure exclusion behavior.** Try `remapFalse: { packageRemapFalse: "stub" }` to suppress errors for platform-excluded packages.

10. **Embed it.** Import from `@bundle/core` directly and build something — a size checker in CI, a REPL, a custom analysis tool.

11. **Read the esbuild docs.** bundlejs inherits all esbuild configuration options. Understanding `target`, `format`, `platform`, `external`, and `conditions` helps.
