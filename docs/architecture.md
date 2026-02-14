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

esbuild is written in Go and normally runs as a native binary — which makes it blazing fast, but also ties it to a specific OS and architecture. bundlejs use esbuild-wasm which compiles esbuild to **WebAssembly** (WASM), making esbuild run in *any* JavaScript runtime: Deno Deploy, browsers, Cloudflare Workers, Node.js. This is not just a portability convenience — Deno Deploy (where the production API runs) **cannot execute native Go binaries**; only JavaScript and WASM. WASM esbuild is roughly 2–5× slower than native Go, but it's the only way to make the bundler work in a serverless edge environment. (Future versions may support native binaries for contexts that allow them — see [core/utils/get-esbuild.ts](../core/utils/get-esbuild.ts) — but WASM remains the portable default.)

With WASM esbuild in hand, the next challenge is that esbuild assumes local files exist on disk. bundlejs intercepts every module resolution and file read that esbuild attempts, then redirects them to:

- **CDN fetches** — downloading packages from a Content Delivery Network (CDN) like [unpkg.com](https://unpkg.com) or [esm.sh](https://esm.sh)
- **Tarball extraction** — unpacking `.tgz` archives from services like [pkg.pr.new](https://pkg.pr.new)
- **In-memory VFS** — a Virtual File System held entirely in RAM

…and hands the results back to esbuild *as if they were local files*.

> **The division of labor:** esbuild does the heavy lifting — parsing, linking, tree-shaking, minification, code generation. bundlejs does the plumbing — figuring out *where* modules live, fetching them, and presenting them to esbuild as local.
>
> In short: *"esbuild, plus a portable module system implemented as plugins and shared resolvers."*

> **Why a VFS instead of esbuild's built-in `stdin`/virtual modules?** esbuild's `stdin` option only works for the entry point — it can't handle relative imports *between* virtual files, directory traversal, or file-existence checks. Tarballs extract dozens of files that reference each other with relative paths. The VFS provides a full filesystem API (read, write, list, exists, delete) shared across all plugins, so tarball extraction, content pre-processing, and esbuild loading all operate on the same in-memory tree.

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
  │  Core Engine (@bundle/core — esbuild-wasm + 7 plugins)      │
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

The core architectural insight: **seven esbuild plugins** registered in a specific order in [core/build.ts](../core/build.ts). This order is *load-bearing* — esbuild evaluates `onResolve` callbacks in registration order, and the **first plugin that returns a result wins**. Returning `undefined` passes control to the next plugin.

> **esbuild plugins** intercept two phases of module handling: **`onResolve`** (map an import specifier to a path + namespace) and **`onLoad`** (return a file's source code + loader type). A module's identity in esbuild is the tuple *(namespace, path)* — two modules with the same path but different namespaces are distinct files. bundlejs uses namespaces to distinguish VFS files, HTTP-fetched modules, tarball-extracted files, and CDN-resolved packages.

```typescript
plugins: [
  AliasPlugin(StateContext),              // 1. Alias rewrites
  ExternalPlugin(StateContext),           // 2. External marking / polyfills
  TarballPlugin(StateContext),            // 3. Tarball fetch / extract / mount
  PackagePlugin(StateContext),            // 4. Per-file enrichment (sideEffects + remapping)
  VirtualFileSystemPlugin(StateContext),  // 5. In-memory files
  HttpPlugin(StateContext),               // 6. HTTP URL resolution and loading
  CdnPlugin(withContext({ origin: host }, StateContext)),  // 7. Bare import → CDN URL
]
```

The ordering reflects a deliberate reasoning chain — each plugin narrows the problem space before the next one runs:

1. **Alias first** — rewrites must transform the import path *before* any other plugin tries to resolve the original name.
2. **External second** — Node.js builtins like `fs` and `path` must be caught *before* the CDN plugin tries to download them from npm (where packages named `fs` actually exist).
3. **Tarball third** — `.tgz` archive URLs must be intercepted and extracted *before* the VFS or HTTP plugins claim them as raw files.
4. **PackagePlugin fourth** — once the path is resolved to a file within a package (tarball-extracted or CDN-fetched), per-file enrichment (sideEffects hints, manifest field remapping) must be applied *before* the VFS or HTTP plugins return a plain result without that metadata.
5. **VFS fifth** — check in-memory files *before* making a network request. This favors the local (fast, already-fetched) copy over the remote one.
6. **HTTP sixth** — URL imports before bare imports. An explicit `https://…` path takes priority over treating the string as an npm package name.
7. **CDN last** — the catch-all. Everything that isn't aliased, external, archived, local, or a URL must be a bare npm/JSR specifier that needs CDN resolution.

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
PackagePlugin    Is "react" a relative path inside a package? ── NO ──▶ pass
   │                (bare import — no package context)
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

Each plugin has one job; complex behavior emerges from their composition. These seven plugins are individually simple, but together they unlock scenarios that no single plugin could handle — keep these in mind as you read through each one:

- **PR preview builds** — TarballPlugin was originally built for this: when a [pkg.pr.new](https://pkg.pr.new) tarball URL appears as a dependency, TarballPlugin fetches and extracts it while CdnPlugin resolves its npm dependencies normally. You can measure the bundle size of an unreleased package in seconds.
- **React Native bundling** — CDNs like unpkg.com intermittently return 503 errors when fetching files from `react-native` and related packages (the root cause is unclear, but the failures are consistent enough to block bundling). Registry tarball mode (TarballPlugin + CdnPlugin) works around this by fetching the entire package as a `.tgz` from the npm registry in a single request — no individual file fetches that can 503. Separately, `react-native` ships raw [Flow](https://flow.org/)-annotated `.js` files that esbuild cannot parse, so content pre-processing (VFSPlugin and HttpPlugin) strips Flow annotations before esbuild sees them. VFSPlugin's extension probing also handles non-standard suffixes like `.native` and `.fx`. These are independent concerns that combine to make React Native bundleable.
- **Large-package fetch reduction** — Packages like `lodash-es` or `@aws-sdk/*` have hundreds of internal imports. In CDN mode, each import is a separate HTTP fetch. In registry mode, the entire package downloads as one tarball, and all subsequent resolution is local VFS lookups.
- **Private registries** — CdnPlugin routes through scoped registries with auth tokens, TarballPlugin extracts the resulting tarballs, and the registry preference propagates through the entire transitive dependency tree automatically — no per-package configuration needed.
- **Tree-shaking at CDN scale** — CdnPlugin resolves entry points, PackagePlugin fetches only the files esbuild actually follows (via its `onLoad` handlers for both VFS and HTTP namespaces), and `sideEffects` metadata tells esbuild which unused files are safe to drop. One import from `lodash-es` bundles to ~1 kB instead of ~80 kB.

The following sections walk through each plugin in registration order — the individual descriptions explain *how* each plugin works, but refer back to these scenarios when you want to see the bigger picture.

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

> **Why `false` by default?** bundlejs's primary use case is answering *"how big will this dependency be?"* — and users typically want to measure the size of *their* code, not the polyfills that pad it. A React component library author comparing packages wants to see the component size, not the weight of `crypto-browserify`. Polyfills can be large (some are 50+ kB) and would inflate every measurement. Defaulting to external keeps the numbers focused on what the user is actually evaluating, while `polyfill: true` is one config flag away for users who genuinely want to include them.

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

Not all packages live on CDNs. Tarball support was originally built for **PR preview builds** — [pkg.pr.new](https://pkg.pr.new) serves unreleased packages as `.tgz` URLs, and TarballPlugin fetches and extracts them so bundlejs can measure their size before they're published. That same extraction machinery later enabled **registry tarball mode**, which downloads entire packages from the npm registry as tarballs — a workaround for CDN reliability issues (unpkg.com intermittently returns 503 errors on some `react-native` package files) and a performance optimization for large packages with hundreds of internal imports.

The TarballPlugin handles all of these through **three resolution branches**:

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

**How the plugin identifies tarballs.** The TarballPlugin itself has zero extension-matching logic — all detection is delegated to [utils/archive-detect.ts](../utils/archive-detect.ts), which means adding a new archive format is a single change in one file. Detection works at two levels: `isTarballUrl()` recognizes tarball-hosting CDNs (like `pkg.pr.new`) and tarball file extensions (like `.tgz`), while `findTarballSplitInPathname()` walks URL segments to split the tarball fetch path from the subpath within the archive:

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

When entry resolution encounters an exclusion (a `package.json` field maps the entry to `false`), the TarballPlugin follows the `remapFalse.packageRemapFalse` policy — see [Remapping and Exclusion Behavior](#remapping-and-exclusion-behavior) for the full policy matrix.

---

### 4. PackagePlugin — *Central hub for enrichment and content loading*

> **Source:** [core/plugins/package.ts](../core/plugins/package.ts)

PackagePlugin is the **central hub** of the plugin pipeline — it owns ALL per-file enrichment (sideEffects computation + manifest field remapping) AND ALL content loading (VFS reads + HTTP fetches). Transport plugins (TarballPlugin, CdnPlugin, HttpPlugin) resolve paths and then **delegate** to PackagePlugin via `build.resolve()`, which re-enters the plugin chain so PackagePlugin can enrich and load the result.

Before this architecture, sideEffects computation, manifest field remapping, Flow stripping, and content loading were duplicated across CdnPlugin, HttpPlugin, TarballPlugin, and VFSPlugin — and still incomplete. Tree-shaking was degraded for registry-mode (tarball-extracted) packages, and manifest field remappings could silently use the wrong file depending on which resolution path was taken.

PackagePlugin centralizes all of this by registering `onResolve` handlers that fire **before** the downstream VFSPlugin and HttpPlugin, plus `onLoad` handlers for both the `virtual-filesystem` and `http-url` namespaces.

**Resolution (`onResolve`)** — when a relative import resolves to a file *inside a known package* (identified by `pluginData.packageRoot` for VFS paths or `pluginData.packageBaseUrl` for HTTP paths), the plugin:

1. **Normalizes the path** to a package-relative form (e.g., `/__tarballs__/abc123/lib/stream.js` → `./lib/stream.js`)
2. **Applies manifest field remappings** — checks `react-native`, `electron`, and `browser` fields in priority order, rewriting the path if a match exists (or excluding the module if mapped to `false`)
3. **Computes sideEffects** for that specific file — boolean `false` means side-effect-free (safe to tree-shake), array patterns are matched against the file path

**Loading (`onLoad`)** — once a file is resolved, PackagePlugin handles content retrieval and pre-processing for both namespaces:

- **VFS (`virtual-filesystem`)** — reads the file from the in-memory filesystem via `getFile()`, runs Flow type stripping if needed, infers the esbuild loader, and sets `resolveDir` for relative import chains
- **HTTP (`http-url`)** — probes extensions via `determineExtension()`, fetches the file via `fetchAssets()`, stores it in the VFS, discovers asset references (WASM, workers), runs Flow stripping, and infers the loader

Both onLoad handlers also perform **JSX loader upgrade** — detecting JSX syntax in `.js` files and switching the esbuild loader from `js`/`ts` to `jsx`/`tsx`.

When no package context exists (user-authored VFS files, direct URL imports without a manifest), the onResolve handler returns `undefined` — the downstream VFSPlugin or HttpPlugin handles resolution as before, but content loading still routes through PackagePlugin's onLoad.

**`build.resolve()` delegation pattern** — transport plugins no longer directly return enriched results. Instead they call `build.resolve(resolvedPath, { namespace, kind, pluginData })`, which re-enters the esbuild plugin chain. PackagePlugin's onResolve catches the delegated resolution (via widened filters: `/^[.\/]/` for VFS, `/^(https?:\/\/|[.\/])/` for HTTP), enriches it with sideEffects and remappings, and returns the final result. This eliminates duplication and ensures every resolved file — regardless of how it was discovered — gets the same enrichment.

**`createPluginContext()`** — a shared helper that initializes the common state needed by PackagePlugin: `config`, `effectiveResolveOpts` (condition inputs for the current platform), and `sideEffectsMatchersCache`. This replaces the duplicated initialization that previously existed in CdnPlugin, HttpPlugin, and TarballPlugin.

> **Why a separate plugin instead of fixing it in each existing plugin?** esbuild's plugin architecture is first-match-wins on `onResolve`. Enrichment (sideEffects, remapping) must happen at the *resolution* phase — by the time `onLoad` runs, it's too late to change the resolved path or inject sideEffects hints. Having one plugin responsible for enrichment AND loading means a single code path covers both VFS and HTTP, with one set of tests and no duplication drift.

---

### 5. VirtualFileSystemPlugin — *In-memory file resolution (resolve-only)*

> **Source:** [core/plugins/fs.ts](../core/plugins/fs.ts)

Provides path resolution against the in-memory filesystem. This is how the **entry point** (the code the user provides) and any local files are resolved for esbuild. VFSPlugin is **resolve-only** — all content loading (reading files, Flow stripping, loader inference) is handled by PackagePlugin's `onLoad` handler for the `virtual-filesystem` namespace.

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

**Extension probing** in `resolveVfsPath()` goes beyond the basic example above. It handles a subtle ecosystem problem: the React Native / Expo ecosystem uses non-standard suffixes like `.fx`, `.types`, and `.native` where the actual files have an additional `.ts` or `.js` extension (e.g., `./Expo.fx` → `./Expo.fx.ts`). Without probing, these imports fail with `Could not resolve` errors. The algorithm is a three-step cascade:

1. **Exact match** — if the file exists at the given path, return it
2. **Extension probing** — append each of `RESOLVE_EXTENSIONS` (`.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json`). This fires for extensionless imports *and* for suffix-style imports where the extension is not a known resolvable one — `./Expo.fx` has `.fx` (not in `RESOLVE_EXTENSIONS`), so probing tries `.ts` → `./Expo.fx.ts` ✓. But `./index.ts` already has `.ts`, so no further probing occurs.
3. **Index fallback** — try `<path>/index.{tsx,ts,jsx,js,css,json}`

> **Think of it like a file finder with a fallback chain.** If you ask for a file and it’s not there, the VFS tries adding common extensions, then looks for an `index` file in a directory of that name — the same heuristics Node.js and Metro use, but against an in-memory filesystem.

**Content pre-processing** (Flow type stripping, JSX loader upgrade) is handled by **PackagePlugin\u2019s `onLoad` handler** for the `virtual-filesystem` namespace \u2014 not by VFSPlugin itself. VFSPlugin is purely responsible for path resolution and extension probing. See [Content Pre-Processing](#content-pre-processing-flow-type-stripping).

Together with suffix-style extension probing (in VFSPlugin) and content pre-processing (in PackagePlugin), these mechanisms are what make React Native packages — which were designed for Metro’s permissive parser — work inside esbuild’s stricter world.

Without this, `import typeof` and `opaque type` in `react-native`’s source cause esbuild syntax errors. JSX loader upgrade (detecting JSX syntax in `.js` files and switching the esbuild loader from `js` to `jsx`) is also handled by PackagePlugin's onLoad. See [Content Pre-Processing](#content-pre-processing-flow-type-stripping).

---

### 6. HttpPlugin — *URL routing and relative import resolution (resolve-only)*

> **Source:** [core/plugins/http.ts](../core/plugins/http.ts)

Handles all HTTP/HTTPS URL routing and relative import resolution. HttpPlugin is **resolve-only** — all content loading (fetching, Flow stripping, loader inference, asset discovery) is handled by PackagePlugin's `onLoad` handler for the `http-url` namespace. Serves **three roles** (sideEffects computation, manifest field remapping, and content loading are all handled by PackagePlugin):

1. **Direct URL imports** — handles `import "https://esm.sh/react"` directly
2. **Relative import resolution** — resolves paths like `"./jsx-runtime.js"` against the **final URL** after redirects (critical because CDNs redirect `react@latest` → `react@19.0.0`)
3. **CDN-follows-parent propagation** — when a bare import is encountered inside an HTTP-fetched file, HttpPlugin delegates to `build.resolve()` with `pluginData.cdnOrigin` set to the parent file's CDN origin, so the CdnPlugin can resolve it from the correct CDN

**Concrete trace — resolving a relative import after a CDN redirect:**

```
  CdnPlugin resolves "react" → https://unpkg.com/react@19.0.0/index.js
     │
     ▼  PackagePlugin.onLoad fetches the URL
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

**Concrete trace — manifest field remapping to `false`** (cross-plugin: PackagePlugin resolves, HttpPlugin serves the stub):

```json
// readable-stream's package.json:
{ "browser": { "util": false, "./lib/stream.js": "./lib/stream-browser.js" } }
```

```
  Inside readable-stream: import "util"
     │
     ▼  PackagePlugin.onResolve
     applyManifestRemappings("util", manifest) → false
     │
     ▼  Check remapFalse.importRemapFalse (default: "stub")
     │
     ▼  Return { path: "util", namespace: "excluded-module" }
     │
     ▼  ExternalPlugin.onLoad for excluded-module namespace:
     Return { contents: "export default {}", loader: "js" }
     + emit warning: "Module 'util' excluded via browser field"

  Inside readable-stream: import "./lib/stream.js"
     │
     ▼  PackagePlugin.onResolve
     applyManifestRemappings("./lib/stream.js", manifest)
     → "./lib/stream-browser.js"  (remapped, not excluded)
     │
     ▼  PackagePlugin's onLoad fetches the browser-specific file instead
```

When a remapping resolves to `false` (meaning "this module doesn't exist on this platform"), PackagePlugin follows the `remapFalse.importRemapFalse` policy — defaulting to an empty stub export that keeps the build alive. The excluded module's `onLoad` handler (registered by ExternalPlugin) serves the actual stub content. See [Remapping and Exclusion Behavior](#remapping-and-exclusion-behavior) for the full policy matrix.

> **Note:** Extension probing for HTTP paths and content pre-processing (Flow stripping, JSX loader upgrade, asset discovery for WASM files and web workers) all happen in PackagePlugin's `onLoad` handler for the `http-url` namespace — not in HttpPlugin.

---

### 7. CdnPlugin — *Catch-all for bare npm imports*

> **Source:** [core/plugins/cdn.ts](../core/plugins/cdn.ts)

Runs last — by this point, every other strategy has had a chance. This plugin does the *heaviest* resolution work:

1. Parse the package specifier (name, version, subpath)
2. Fetch `package.json` from the configured CDN
3. Resolve the entry point through **conditional exports** or legacy fields via `resolvePackageEntry()` (from [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts))
4. Compute **side effects** metadata (for tree-shaking)
5. Construct the final CDN URL

Also handles **JSR specifiers** (`jsr:@scope/name`), **npm aliases** (`npm:pkg@version`), and **subpath imports** (`#internal/...`). The full resolution algorithm is detailed in [How Resolution Works](#how-resolution-works).

When `resolvePackageEntry()` reports a whole-package exclusion (e.g., `"browser": false`), the CdnPlugin follows the `remapFalse.packageRemapFalse` policy — defaulting to a build error that forces the user to address the dependency. See [Remapping and Exclusion Behavior](#remapping-and-exclusion-behavior) for configuration options.

#### Registry Tarball Mode

CDN mode works well for most packages, but it has two weaknesses:

1. **Large packages generate too many HTTP fetches.** Packages like `lodash-es` or `@aws-sdk/*` have hundreds of internal imports. Each import triggers a separate HTTP request to the CDN, which is slow and can hit rate limits.
2. **CDN reliability issues.** Some CDNs intermittently fail on certain packages. unpkg.com, for example, returns 503 errors when fetching files from `react-native` and related packages — the root cause is unclear, but the failures are consistent enough to make CDN-mode bundling unreliable for those packages.

Registry tarball mode solves both problems. When the CDN origin is a **registry** (`cdn: "npm"`, `cdn: "npm.registry"`, or `cdn: "https://registry.npmjs.org"`), the CdnPlugin downloads the **entire package tarball** in a single HTTP request, extracts it to the VFS, and resolves entry points locally — no per-file CDN fetches, no 503 risk:

> **Why not make this the default?** Downloading full tarballs uses significantly more memory than fetching individual files on demand. Deno Deploy isolates have a **512 MB memory limit**, and a single large tarball (plus its transitive dependencies) can consume a meaningful portion of that budget. CDN mode only fetches the files esbuild actually follows during bundling, keeping memory usage proportional to the *used* code rather than the *entire* package. Registry mode is opt-in (`cdn: "npm.registry"`) for when reliability or fetch count matters more than memory efficiency.

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

The flow: resolve version → fetch manifest → construct tarball URL → route through TarballPlugin (which fetches, extracts to VFS, and resolves the entry point). This also provides exact npm parity — no CDN-specific quirks, and the content pre-processing pipeline handles Flow and JSX issues before esbuild parses anything.

**Transitive dependency propagation.** Registry mode doesn't just apply to the top-level import — all bare imports from within extracted tarballs also resolve through the registry via two complementary mechanisms:

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
     ▼  PackagePlugin.onLoad reads file, esbuild finds: import "body-parser"
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

The plugin pipeline above describes *which* plugin handles each import. This section describes *how* the CdnPlugin and its resolution utilities actually find the right file — by faithfully implementing the **Node.js module resolution algorithm** (the set of rules Node.js uses to find the actual file behind an `import` statement) against *CDN-hosted packages* instead of a local `node_modules` directory.

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

> **Why unpkg as the default?** unpkg serves **raw npm files without transformation** — the files you get from unpkg are byte-for-byte identical to what `npm install` produces. CDNs like esm.sh and Skypack pre-process packages (rewriting imports, converting CJS to ESM, injecting polyfills), which can break packages or produce different entry points than what the package author intended. Since bundlejs runs its *own* module resolution and bundling, pre-processing from the CDN is unnecessary and can interfere. unpkg gives bundlejs the raw materials it needs. (The historical default was actually Skypack, but was changed to unpkg for this reason.)


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

> **Why `browser` platform is the default:** bundlejs's primary use case is *"how big will this dependency be in my production bundle?"* — and most production bundles target browsers. The `browser` platform gives the most useful default conditions for that scenario: it activates the `browser` export condition, enables the legacy `browser` field in `package.json`, and produces ESM output. Users targeting Deno, Node.js, or Workers can override this via `platform` and `runtime` config.

> **Where bundlejs deviates from Node.js:** The `"module"` condition is an esbuild convention, not part of the Node.js spec — but many real-world packages use `"module"` as their *only* ESM export condition (because webpack, Rollup, and esbuild all recognize it). Without `"module"`, those packages would resolve to their CJS entry point, producing inaccurate bundle size measurements. bundlejs also passes `unsafe: true` to the [resolve.exports](https://www.npmjs.com/package/resolve.exports) library, which allows resolution to succeed even when no matching condition exists (instead of throwing). And it retries with `require: true` as a compatibility fallback for packages that only define CJS exports. Both deviations sacrifice spec purity for real-world coverage — the goal is measuring packages as they *actually* ship on npm, not as the spec says they should be written.


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

After a relative path resolves to a file inside a known package, PackagePlugin checks whether it should be **remapped** to a platform-specific alternative *before* VFSPlugin or HttpPlugin returns a plain result. This handles packages that ship different implementations for different runtimes via `package.json` fields.

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

When a relative import has no extension, up to 18 URL combinations are tried (2 path variants × 9 extensions). This is a pragmatic deviation from Node.js (which does not probe) — but it's necessary because npm packages are authored assuming bundlers like webpack and Rollup will probe extensions for them. TypeScript's convention of extensionless imports compounds this — `.ts` and `.tsx` must be tried alongside `.js`. And unlike local bundlers, CDNs serve exact paths with no probing of their own; some CDNs redirect extensionless URLs to the right file, but not all of them and not consistently. bundlejs takes full responsibility for probing to ensure correctness across all CDN backends.

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

The plugin sections above mentioned exclusions in passing — what happens when a `package.json` field maps a module to `false`. This section is the authoritative reference for that behavior.

Path remapping fields (`browser`, `react-native`, `electron`) can map packages or individual modules to `false`, meaning "this doesn't exist on this platform." For example, a package might declare `"browser": { "fs": false }` to signal that its filesystem code has no browser equivalent. The `remapFalse` config controls how the bundler reacts.

The two exclusion levels have **different default policies** because they signal different author intent:

**Package-level exclusion** (`"browser": false` at the top level) occurs when the package author is explicitly saying *"this entire package does not work on this platform — we acknowledge the use case but choose not to participate."* This is a deliberate, conscious decision. The default response is `"error"` — respect the author's explicit statement and force the bundlejs user to make an active choice (stub it, externalize it, or remove the dependency).

**Per-module exclusion** (`"browser": { "./server.js": false }`) is more granular — the author is saying *"this specific file has no browser equivalent, but the rest of the package works fine."* This represents partial platform support, not outright incompatibility. The default response is `"stub"` — replace the excluded module with an empty export and keep building. Most of the time, the excluded module is an optional code path that the user's import tree doesn't actually need at runtime.

Both defaults give users the option to override: `remapFalse.packageRemapFalse` and `remapFalse.importRemapFalse` can be set to `"error"`, `"stub"`, or (for per-module only) `"external"`.

**Package-level exclusion** is handled by **CdnPlugin** and **TarballPlugin**. **Per-module exclusion** is handled by **PackagePlugin**.

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
    PackagePlugin (onResolve) ─── checks remapFalse.importRemapFalse

  Stub serving:
    ExternalPlugin (onLoad)   ─── EXCLUDED_MODULE_NAMESPACE handler
                                   respects suppressWarning from pluginData
```


## Content Pre-Processing: Flow Type Stripping

> **Source:** [core/utils/flow-strip.ts](../core/utils/flow-strip.ts)

Flow stripping is an independent concern from tarball/registry support — it is needed regardless of *how* the files arrive (CDN fetch, tarball extraction, or VFS). The files themselves contain [Flow](https://flow.org/) type annotations that esbuild (and every non-Metro bundler) cannot parse.

That said, Flow stripping and registry mode *combine powerfully* for React Native. CDNs like unpkg.com have reliability issues with `react-native` packages (intermittent 503 errors — see [Registry Tarball Mode](#registry-tarball-mode)), so registry mode fetches the entire package as a tarball. Flow stripping then cleans the extracted files before esbuild sees them. Neither feature alone is sufficient — together they make React Native bundleable:

> **The complete React Native pipeline:**
>
> ```
>   import "react-native"    (bare import)
>      │
>      ▼  CdnPlugin (registry mode)                     ← works around CDN 503 errors
>      Fetch entire tarball from registry.npmjs.org
>      │
>      ▼  TarballPlugin
>      Extract to VFS: /__tarballs__/<hash>/
>      │
>      ▼  PackagePlugin (onLoad)                         ← cleans unparseable source
>      Flow stripping: remove `import typeof`, `opaque type`, etc.
>      JSX upgrade: detect JSX in .js files
>      │
>      ▼  VFSPlugin (onResolve)                          ← handles Metro conventions
>      Suffix probing: resolve ./Expo.fx → ./Expo.fx.ts
>      │
>      ▼  esbuild
>      Parse clean JavaScript, bundle normally
> ```

After a file is resolved and fetched, but *before* esbuild parses it, bundlejs runs content-aware transformations. The most significant is **Flow type stripping** — removing Flow type annotations from JavaScript files.

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

**Integration:** PackagePlugin's `onLoad` handlers (for both `virtual-filesystem` and `http-url` namespaces) call `maybeStripFlow()` on every file. The cost for non-Flow builds is just the `containsFlow()` check — a fast regex test against the first 4 KB per file. The `flow-remove-types` package (based on Meta's `hermes-parser` compiled to WASM) is only imported when Flow is actually detected.

**Flow + JSX:** React Native packages often contain *both* Flow and JSX in the same `.js` file. Flow stripping runs *before* loader inference, so the stripped content (clean JS) is passed to `inferLoader()`, which may upgrade the loader from `ts` to `tsx` if JSX is detected. See [Scenario 18 — JSX in `.js` Files](scenarios/18-jsx-in-js-files.md).


## Plugin Shared State

The seven plugins described above need to coordinate: CdnPlugin writes tarballs that VFSPlugin reads, HttpPlugin caches manifests that CdnPlugin reuses, and all plugins share a single VFS. This coordination happens through a **`Context`** object — a reactive, hierarchical data container built on `EventTarget` and `Proxy` (defined in [core/context/context.ts](../core/context/context.ts)).

> **Why not just pass a plain object?** A plain shared object would handle the *shared* data case, but breaks down when plugins need *isolated* state. CdnPlugin needs its own `origin` property that doesn't leak back to the parent context — without isolation, one plugin could accidentally change the CDN host for all other plugins. The Context's `withContext()` provides exactly this: a child scope where specified keys are isolated, while everything else (VFS, caches, config) remains shared and bidirectional. The design was inspired by Go's [`context.Context`](https://pkg.go.dev/context) — hierarchical, cancellable, with scoped values — adapted for JavaScript's `Proxy` and `EventTarget` APIs. The reactivity (observable gets/sets) is a bonus that enables debugging and future features, but the core motivation was elegant shared-vs-isolated data management.

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

Everything described so far — the plugin pipeline, resolution algorithm, content pre-processing — is the `@bundle/core` engine. The **edge runtime** wraps that engine in an HTTP API, deployed on **[Deno Deploy](https://deno.com/deploy)**. The entry point exports a `fetch` handler (in [edge/mod.ts](../edge/mod.ts)):

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

A single build involves dozens to hundreds of HTTP fetches — package manifests, source files, redirects. Without caching, every request to the bundlejs API would repeat all of that work. bundlejs uses **multi-tiered caching** to avoid it:

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

Each tier exists for a distinct reason. **Redis (Upstash)** is Tier 1 because it persists across Deno Deploy isolate cold starts — when an isolate is recycled (which happens frequently on serverless), Cache API and LRU caches are lost, but Redis retains the cached build result. A repeat request that hits Redis returns in milliseconds without re-building. **Cache API** is Tier 2 because it survives within a single isolate lifetime but is faster to access than a network Redis call — it caches *individual HTTP responses* (package manifests, source files), not whole build results. **In-memory LRU** is Tier 3 — the fastest lookup (no I/O), but the smallest and most volatile; it's gone on the next isolate restart.

The per-fetch caching (Cache API + LRU) uses a **stale-while-revalidate** (SWR) pattern: return the cached response immediately, then fire a background refresh to update the cache for future requests. This works well because npm package content rarely changes for a given version — a stale response for `react@19.0.0/index.js` returns the correct file 99.99% of the time. The tradeoff favors latency over freshness, which is the right call for a size-checking tool where speed matters and a one-request delay in cache freshness is invisible.

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


### Per-Fetch Lifecycle: How `fetchWithCache` Works

> **Source:** [utils/fetch-and-cache.ts](../utils/fetch-and-cache.ts)

The `fetchWithCache()` function is the single entry point for all HTTP requests within the build pipeline. Every CDN file fetch, package manifest download, extension probe, and asset discovery goes through this function. Understanding its lifecycle is essential because it creates the background operations that the [Resource Lifecycle](#resource-lifecycle--explicit-resource-management) section describes how to clean up.

#### Request flow

```
  fetchWithCache(url, { signal, scope, cacheMode, … })
       │
       ▼  Can cache?  (method === GET && cacheMode !== 'no-store')
       │
       ├─ NO → doFetch(url) → return response
       │
       ▼  YES
       │
       ▼  Check cacheMode
       │
       ├─ 'reload' → skip cache check, fetch fresh, store in cache
       │
       ▼  NOT 'reload'
       │
       ▼  lookupCache(url)
       │   ├── Check in-memory LRU (responseCache)
       │   └── Check Cache API (cacheApi.match)
       │   Both keyed by final URL (via redirectMap)
       │
       ├─ MISS → dedup check (inflight map) → doFetch → storeInCache → return
       │
       ▼  HIT
       │
       ├─ cacheMode: 'force' → return cached immediately (no refresh)
       │
       ▼  cacheMode: 'normal' (default)
       │
       ├── Clone cached response → cancel original body
       ├── Fire backgroundRefresh(originalUrl, finalUrl, …)    ← SWR
       ├── scope.adopt(bgPromise, awaiter)                     ← lifecycle tracking
       └── Return { response: clone, pending: bgPromise }
```

#### Redirect-aware caching

A critical design decision: responses are always cached under the **final URL** after redirects, never the original request URL. This ensures:

1. **Relative imports resolve correctly** — a module fetched from `unpkg.com/react@latest` that redirects to `unpkg.com/react@19.0.0/index.js` must resolve its `./jsx-runtime` import against the *final* URL
2. **No stale redirect targets** — when `@latest` advances from `19.0.0` to `19.1.0`, the redirect map updates naturally
3. **Direct hits work** — a request for the already-resolved URL finds the cached content immediately

A separate `redirectMap` LRU (capacity: 500) tracks *original → final* URL mappings so that requests to aliased URLs can find cached content without re-fetching:

```
  Request: https://esm.sh/lodash@latest
       │
       ▼  lookupCache("https://esm.sh/lodash@latest")
       ▼  redirectMap.get("…@latest") → "…@4.17.21"
       ▼  responseCache.get("…@4.17.21") → cached Response ✓

  vs. direct request:
  Request: https://esm.sh/lodash@4.17.21
       │
       ▼  lookupCache("…@4.17.21")
       ▼  redirectMap has no entry (not a redirect URL)
       ▼  responseCache.get("…@4.17.21") → cached Response ✓
```

#### Request deduplication

When two concurrent callers request the same URL before the first fetch settles, the second caller **joins the existing promise** instead of issuing a duplicate HTTP request. The `inflight` LRU map (capacity: 200) tracks pending fetches:

```
  Caller A: fetchWithCache("https://unpkg.com/react@19/index.js")
       │
       ▼  Cache miss → start fetch → store promise in inflight map
       │                              ┌──────────────────────────┐
       │                              │ inflight["…/index.js"]   │
  Caller B: fetchWithCache("…")  ───▶ │   = Promise<Response>   │
       │                              └──────────────────────────┘
       ▼  inflight.get("…") → existing promise → await it
       │   then read from cache (each caller gets its own clone)
       │
       ▼  When fetch settles: inflight.delete("…/index.js")
```

The dedup also bounds background refresh concurrency — if a background refresh for URL X is already in progress, the next cache hit simply joins the existing refresh rather than spawning a second one.

#### Stale-while-revalidate (SWR) and background refresh

When a cache hit occurs in `normal` mode, `fetchWithCache` fires a `backgroundRefresh()` — an async function that re-fetches the URL from the network and updates the cache for future requests. This is **fire-and-forget** from the caller's perspective (the cached content is returned immediately), but the background promise must be tracked for lifecycle management.

```
  backgroundRefresh(originalUrl, finalUrl, init, retries, cacheApi)
       │
       ▼  Bail if signal.aborted (build already finished)
       │
       ▼  doFetch(originalUrl, { signal, … })
       │   ├── fetch() with redirect:'follow'
       │   └── signal cancels in-flight fetch → throws AbortError
       │
       ├── AbortError? → return (expected during disposal)
       │
       ▼  Check signal.aborted again (between fetch and cache write)
       │   └── Aborted? → cancel response body, return
       │
       ▼  storeInCache(originalUrl, resolvedUrl, response, cacheApi, signal)
       │   ├── Checks signal.aborted before write (skip if build finished)
       │   ├── Cache API: cacheApi.put(new Request(finalUrl), response)
       │   │     → starts Deno op_cache_put (cannot be cancelled once started)
       │   └── In-memory: responseCache.set(finalUrl, response)
       │
       ├── 404 on original URL? → retry with finalUrl (extension probing case)
       │   └── Same signal checks and cache write
       │
       └── All errors swallowed (background operation — must not throw)
```

The **smart fallback** handles two real-world cases:
1. **Version aliases** (`@latest`): original URL works, may resolve to newer version
2. **Extension probing** (`dbcs-codec` → `dbcs-codec.js`): original extensionless URL 404s, use the final (extension-resolved) URL

#### Signal and scope threading: builds → fetch-and-cache

The `FetchOptions` interface exposes two lifecycle parameters that connect the caching layer to the per-build [Resource Lifecycle](#resource-lifecycle--explicit-resource-management):

```typescript
interface FetchOptions {
  signal?: AbortSignal;           // Per-build abort signal
  scope?: AsyncDisposableStack;   // Per-build disposal scope
  // … other options (init, retries, clone, cacheMode)
}
```

**`signal`** — the per-build `AbortController.signal`. When the build finishes and disposal runs, `abort()` fires this signal. Background refreshes that are still fetching receive an `AbortError` and bail early. The signal is **only applied to background refreshes** — primary (awaited) fetches are not affected, so in-progress builds won't be interrupted by disposal of a *previous* build.

**`scope`** — the per-build `AsyncDisposableStack`. Background refresh promises are **adopted** into this scope via `scope.adopt(bgPromise, awaiter)`. When `disposeAsync()` runs, the stack awaits each adopted promise — including any `cacheApi.put()` calls that were already in progress when the abort signal fired. Without adoption, fire-and-forget promises outlive the build and leak Deno runtime ops.

**Threading path** — how signal and scope flow from `build()` through the plugin pipeline to `fetchWithCache`:

```
  build.ts                core/plugins/          core/plugins/          utils/
  ─────────               ──────────────         ──────────────         ──────
  AsyncDisposableStack    PackagePlugin          http.ts                fetch-and-cache.ts
  AbortController         (onLoad, HTTP)         (fetchPkg wrapper)     (fetchWithCache)
       │                       │                       │                       │
       ├── StateContext.scope ─┤                       │                       │
       ├── StateContext.abort ─┤                       │                       │
       │                       │                       │                       │
       │                  determineExtension()         │                       │
       │                       │                       │                       │
       │                  fromContext("abort")          │                       │
       │                  fromContext("scope")          │                       │
       │                       │                       │                       │
       │                  fetchPkg(url, {              │                       │
       │                    signal: abort.signal, ─────┤                       │
       │                    scope  ─────────────────────┤                       │
       │                  })                            │                       │
       │                                          fetchContent(url, {          │
       │                                            signal, scope ─────────────┤
       │                                          })                           │
       │                                                                  fetchWithCache()
       │                                                                       │
       │                                                                  backgroundRefresh
       │                                                                       │
       │                                                                  scope.adopt(bg)
       │                                                                       │
       ▼  [Symbol.asyncDispose]                                                │
       │                                                                       │
       ├── defer(abort) ← LIFO: fires FIRST                                   │
       │   └── abort.abort() → signal fires                                    │
       │       └── in-flight fetch → AbortError                                │
       │                                                                       │
       └── adopt(bgPromise) ← LIFO: fires SECOND                              │
           └── await bgPromise                                                 │
               └── storeInCache settles (put completes or throws)              │
```

#### Resources created by background refresh

Each `backgroundRefresh` call can create up to three Deno runtime resources. These are what Deno's test sanitizer detects as leaks when disposal doesn't fully complete:

| Deno Resource | Created by | How it's cleaned up |
|:---|:---|:---|
| `fetchCancelHandle` | `fetch()` in `doFetch()` | AbortSignal cancels the in-flight request; Deno frees the handle on the next macrotask |
| `op_cache_put` | `cacheApi.put()` in `storeInCache()` | Must run to completion — **cannot be cancelled** once started. The adopt awaiter blocks until the put finishes |
| `CacheResponseResource` | `cacheApi.match()` in `lookupCache()` | Response body must be consumed (`.arrayBuffer()`) or cancelled (`.body?.cancel()`) |

The `op_cache_put` resource is the trickiest — Deno's Cache API `put()` operation writes the response body to persistent storage. Unlike `fetch()`, it doesn't accept an `AbortSignal`, so once started it must complete naturally. The disposal stack handles this by awaiting the full `backgroundRefresh` promise chain, which includes the `storeInCache` call.

#### Defensive strategies

The caching layer uses several strategies to prevent resource leaks:

1. **Signal checks at every boundary** — `backgroundRefresh` checks `signal.aborted` before the fetch, after the fetch (before cache write), and `storeInCache` checks before calling `cacheApi.put()`. This creates multiple bail-out points.

2. **Response body cancellation** — when bailing early due to abort, the response body is explicitly cancelled via `response.body?.cancel()` to prevent `CacheResponseResource` leaks.

3. **Cache response cleanup on clone** — when `lookupCache` returns a Cache API response, `fetchWithCache` clones it for the caller and cancels the original's body. This ensures the `CacheResponseResource` from `cacheApi.match()` is freed even if the caller doesn't consume the response.

4. **Error swallowing in background** — `backgroundRefresh` catches all errors (AbortError, 404, network failures) and returns silently. Background operations must never throw — they're fire-and-forget from the caller's perspective, with lifecycle management handled by the disposal scope.

5. **Macrotask delay in disposal** — `[Symbol.asyncDispose]` adds a `setTimeout(0)` after `disposeAsync()` completes. This gives Deno's runtime a macrotask to finalize internal resource cleanup (`fetchCancelHandle` teardown) that happens asynchronously after abort + promise settlement.


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

Each build spins up background fetches, in-flight deduplication, and plugin-scoped resources — all of which must be cleaned up when the build finishes. bundlejs implements the [TC39 Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) proposal so that cleanup happens automatically. Every `build()`, `transform()`, and `context()` call returns an object that implements `Disposable` and `AsyncDisposable`, enabling the `using` / `await using` syntax.

> **Why ERM instead of try/finally?** The SWR caching pattern fires background fetches that *must* be aborted when the build ends — if they outlive the build, Deno's test sanitizer flags them as leaked resources, and in production they waste memory. With manual try/finally, every consumer of the `build()` API must remember to call a cleanup function in the right place. With ERM, cleanup is **correct by default** — `await using result = await build(…)` guarantees disposal at the end of scope, even if the consumer doesn't think about resource management. This is especially important for library consumers who may not know about the background fetches at all.

### Why this matters

Each build creates per-build resources that must be torn down when the caller is finished:

- **Background stale-while-revalidate (SWR) fetches** — the caching layer fires `void backgroundRefresh(…)` calls that update the cache for future requests. Without cancellation, these outlive the build and cause resource leaks (Deno's test sanitizer flags them as leaked `fetchCancelHandle` / `op_cache_put` ops).
- **In-flight request deduplication** — the `inflight` LRU map tracks pending network requests so concurrent builds don't duplicate HTTP calls.
- **Plugin-registered resources** — plugins can register arbitrary cleanup callbacks on the per-build `AsyncDisposableStack` (workers, WASM runtimes, streams, etc.).

> **Deep dive:** The [Caching Architecture](#caching-architecture) section covers the full `fetchWithCache` lifecycle, including the SWR background refresh flow, request deduplication, redirect-aware caching, and the specific Deno runtime resources that cause leaks when disposal fails.

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
       │     ├── PackagePlugin (onLoad): passes abort.signal + scope
       │     │     via determineExtension → fetchPkg → fetchWithCache
       │     ├── PackagePlugin (onLoad): passes abort.signal + scope
       │     │     via fetchAssets → fetchPkg → fetchWithCache
       │     ├── TarballPlugin: passes abort.signal + scope to fetchWithCache
       │     └── Background SWR refreshes carry abort.signal;
       │           scope.adopt() tracks their settlement
       │
       └── Return result with [Symbol.asyncDispose] → scope.disposeAsync()
                                                       ├── abort.abort()
                                                       └── (any plugin-registered cleanup)
```

### LIFO disposal timing

`AsyncDisposableStack` disposes entries in **last-in, first-out** order. This ordering is critical because `scope.defer(() => abort.abort())` is registered *before* the build runs, placing it near the bottom of the stack. During the build, `scope.adopt(bgPromise, awaiter)` calls push background refresh promises onto the *top* of the stack. At disposal time:

```
  scope.disposeAsync()                       LIFO order
       │
       ├── 1. adopt(bgPromise_N)  ← last adopted, disposed first
       │       └── await bgPromise_N (storeInCache → cacheApi.put settles)
       │
       ├── 2. adopt(bgPromise_N-1)
       │       └── await bgPromise_N-1
       │
       │   … (all adopted promises drain) …
       │
       ├── N. adopt(bgPromise_1)  ← first adopted, disposed last among adopts
       │       └── await bgPromise_1
       │
       └── N+1. defer(abort)      ← registered earliest, fires LAST
                 └── abort.abort()
                     └── signal fires → in-flight fetches receive AbortError
```

> **Wait — doesn't that mean abort fires *after* all adopts?** Yes. The `defer(abort)` fires last because it was registered first (LIFO). This means the adopted background refresh promises are awaited *before* the abort signal fires. The background refresh functions themselves check `signal.aborted` at multiple points (before fetch, after fetch, before cache write) — but those checks happen during the *build* phase. By disposal time, the promises that were adopted have either already completed or are still in-flight. The adopt awaiter blocks until they settle, and only then does `defer(abort)` fire. In-flight fetches that were *not* adopted (or that started after adoption) are cancelled by the abort signal last.

> **Design implication:** Because `op_cache_put` operations cannot be cancelled once started, the adopt-then-abort ordering is correct — it ensures that any `cacheApi.put()` calls in progress are awaited to completion before the build scope closes. See [Resources created by background refresh](#resources-created-by-background-refresh) and [Defensive strategies](#defensive-strategies) in the Caching Architecture section for the full resource lifecycle within `fetchWithCache`.

For the detailed flow of how `signal` and `scope` thread from `build()` through plugins into `fetchWithCache`, see [Signal and scope threading](#signal-and-scope-threading-builds--fetch-and-cache) in the Caching Architecture section.

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
| **WASM esbuild is slower** | ~2–5× slower than native Go. Acceptable for size checks; too slow for build-on-save. WASM is required because Deno Deploy can't run native binaries — but in contexts that allow it, future versions may support native Go esbuild for full speed. |
| **CDN dependency** | If unpkg goes down, resolution fails. Configurable CDN mitigates; *no automatic failover* because each CDN has different URL formats, redirect behaviors, and file-processing logic — silently falling back could change which entry point resolves, producing different bundle sizes without the user knowing. unpkg intermittently 503s on some `react-native` packages — use `cdn: "npm.registry"` as a workaround. |
| **Extension probing = HTTP requests** | Up to 18 URL probes per extensionless import. HTTP/2 multiplexing and `failedExtensionChecks` caching help. |
| **No git/workspace/link deps** | These require local filesystem or git. `file:` specs can use `vfs:`/`virtual:` equivalents. |
| **Browser field inconsistency** | The dual-form `browser` field is npm's most inconsistent convention. bundlejs follows Node.js spec + esbuild behavior. |
| **`"module"` condition is non-standard** | bundlejs (via esbuild) injects `"module"`. Matches webpack/Rollup/esbuild; absent from Node.js. |
| **No dynamic import resolution** | `import(someVariable)` cannot resolve at build time (esbuild limitation). |
| **Tarball decompression** | Only gzip + uncompressed tars extracted. npm tarballs are 100% gzip. Detection layer is broader. |
| **Registry mode downloads full tarballs** | `cdn: \"npm\"` downloads the whole `.tgz`, using more memory than CDN mode (which fetches only files esbuild follows). Opt-in because Deno Deploy's 512 MB limit makes memory a real constraint. Content-addressed cache ensures one fetch per package per build. |
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
