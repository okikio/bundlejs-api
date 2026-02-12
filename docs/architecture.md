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

**Who reaches for it:**

- **Library authors** — verifying their package's bundle footprint before publish
- **Teams** — evaluating dependency costs *before* adoption
- **CI pipelines** — automated size checks via the HTTP API
- **Tool builders** — anyone needing programmatic bundling without native dependencies

> **What bundlejs is *not*:** It is not a replacement for your local build tool (webpack, Vite, Rollup). It does not manage `node_modules`, does not install packages to disk, and does not run your code. Everything is fetched over HTTP, held in memory, bundled, measured, and discarded.


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

**What bundlejs explicitly does *not* do:**

| ❌ Does not | Why |
|:-----------|:----|
| Install packages to disk | Everything is fetched and held *in memory* |
| Run your code | It only bundles and measures |
| Support `git:` / `workspace:` / `link:` specs | Only registry, URL, and JSR specifiers |
| Persist VFS between requests | Each bundle starts with a *fresh* build context |


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


## The Four Modules

bundlejs is a Deno workspace with four packages. Each has a clear responsibility, and dependencies flow strictly downward.

```
bundlejs-api/
├── edge/      @bundle/edge       HTTP API layer (Deno Deploy)
├── core/      @bundle/core       The bundler engine (esbuild + plugins)
├── compress/  @bundle/compress   Compression algorithms (gzip/brotli/zstd/lz4)
└── utils/     @bundle/utils      Shared utilities (parsing, fetching, resolution)
```

The dependency graph looks like this:

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

`@bundle/utils` is the **foundation** — zero internal dependencies. It provides the shared substrate that every other package builds on:

- **Package parsing** — [utils/parse-package-name.ts](../utils/parse-package-name.ts) splits specifiers like `@scope/pkg@^2.0.0/sub` into name, version, and subpath
- **Spec classification** — [utils/npm-spec.ts](../utils/npm-spec.ts) and [utils/jsr-spec.ts](../utils/jsr-spec.ts) categorize specifiers as *semver*, *tag*, *URL*, *alias*, or *unsupported*
- **Export conditions** — [utils/resolve-conditions.ts](../utils/resolve-conditions.ts) computes the right condition set (`browser`, `import`, `require`, etc.) for a given runtime
- **Exports/imports resolution** — [utils/resolve-exports-imports.ts](../utils/resolve-exports-imports.ts) resolves subpaths through `package.json` `exports` and `imports` fields
- **Import map resolution** — [utils/resolve-import-map.ts](../utils/resolve-import-map.ts) applies import map remappings
- **Builtin catalogs** — [utils/runtime-builtins.ts](../utils/runtime-builtins.ts) catalogs ~50 Node.js builtins with browser polyfill mappings
- **Caching fetch** — [utils/fetch-and-cache.ts](../utils/fetch-and-cache.ts) wraps `fetch()` with multi-tier caching (LRU + Cache API)
- **npm registry API** — [utils/npm-search.ts](../utils/npm-search.ts) wraps the npm registry REST API — version resolution, packument fetching, tarball URL construction. Handles scoped packages (`@scope/name`) with the registry's `%2f` encoding convention and a full-packument fallback when version-specific endpoints fail
- **`.npmrc` parsing** — [utils/npmrc.ts](../utils/npmrc.ts) extracts registry configuration from `.npmrc` content — default registry overrides, scoped registry mappings (`@scope:registry=https://...`), comment stripping, and environment variable interpolation. Intentionally omits auth tokens (security boundary)

A deliberate design principle runs through `@bundle/utils` — it wraps **Web APIs** instead of Node.js APIs. This is strategic: by building on web standards, the same code runs in Deno Deploy, browsers, Cloudflare Workers, *and* Node.js without platform-specific shims.

| Purpose | Web API (used) | Node.js API (avoided) |
|:--------|:---------------|:----------------------|
| HTTP requests | `fetch()` | `node:http` |
| Streams | `ReadableStream` / `WritableStream` | `node:stream` |
| Cryptography | `crypto.subtle` | `node:crypto` |
| Compression | `CompressionStream` | `node:zlib` |
| Text encoding | `TextEncoder` / `TextDecoder` | `Buffer` |


## esbuild: The Foundation

Every design decision in bundlejs is shaped by esbuild's architecture, so understanding esbuild is essential.

**[esbuild](https://esbuild.github.io/)** is a JavaScript/TypeScript *bundler* written in Go. A bundler takes many source files with `import`/`export` statements and combines them into fewer output files. esbuild is **10–100× faster** than webpack or Rollup because it:

- Parses, links, and generates code **in parallel** (Go’s goroutines)
- Avoids JavaScript-based AST transformations
- Uses a **single-pass architecture** that minimizes memory allocation

Its internal pipeline has three phases:

```
         ┌───────────────┐
         │  Parse Phase  │  Read files, build ASTs
         └───────┬───────┘
                 │
                 ▼
         ┌───────────────┐
         │ Bundle Phase  │  Resolve imports, link modules
         └───────┬───────┘
                 │
                 ▼
         ┌───────────────┐
         │  Link Phase   │  Generate output, minify
         └───────────────┘
```

esbuild exposes **two APIs**:

| API | Purpose | Filesystem? |
|:----|:--------|:------------|
| **Build API** — `esbuild.build()` | Takes entry points, resolves imports, bundles into output files | Normally reads/writes disk |
| **Transform API** — `esbuild.transform()` | Takes a single string, applies transformations (minify, transpile) | No filesystem access |

bundlejs uses the *Build API*, but replaces all filesystem access with its plugin pipeline.

### The Plugin System

The **plugin system** is where bundlejs hooks in. An esbuild plugin is a JavaScript object that registers callback functions for two interception points:

- **`onResolve`** — called when esbuild encounters an `import` statement. The plugin receives the import path and returns:
  - A **resolved path** (where to find the file)
  - A **namespace** (which group of files this belongs to)
  - If the plugin returns `undefined`, esbuild tries the next plugin

- **`onLoad`** — called when esbuild needs to *read* a file’s contents. The plugin receives the resolved path + namespace and returns:
  - The **source code** (as a string)
  - A **loader type** (`"js"`, `"ts"`, `"css"`, `"json"`, etc.)

> **Namespaces** are esbuild’s mechanism for routing modules through different handlers. A module's identity is the tuple *`(namespace, path)`*. Two modules with the same path but *different* namespaces are treated as **distinct files**. bundlejs uses namespaces to distinguish between VFS files, HTTP-fetched modules, tarball-extracted files, and CDN-resolved packages.
>
> Module caching in esbuild is keyed by this tuple — so plugins must return **canonical paths**. If the same module resolves to different paths on different calls, esbuild fetches and bundles it multiple times.

### WASM Loading

bundlejs **always** loads esbuild as WebAssembly. The `getEsbuild()` function in [core/utils/get-esbuild.ts](../core/utils/get-esbuild.ts) returns `ESBUILD_DENO_WASM` unconditionally (a platform-detection switch exists but is commented out), using **esbuild v0.27.2**.

The WASM binary is embedded as an encoded string in [core/wasm.ts](../core/wasm.ts) and decoded at startup — so there is *no filesystem or network dependency* for loading esbuild itself.

> **Trade-off:** WASM esbuild is roughly **2–5× slower** than the native Go binary, but it runs *everywhere* JavaScript runs — browsers, edge functions, server runtimes.

### Default Configuration

bundlejs initializes esbuild with these defaults (defined in [core/build.ts](../core/build.ts)):

```typescript
export const BUILD_CONFIG: BuildConfig = {
  entryPoints: ["/index.tsx"],
  cdn: DEFAULT_CDN_HOST,     // "https://unpkg.com"
  polyfill: false,
  esbuild: {
    color: true,
    globalName: "BundledCode",
    logLevel: "info",
    sourcemap: false,
    target: ["esnext"],      // No downlevel transpilation
    format: "esm",           // ES module output
    bundle: true,            // Resolve and inline all dependencies
    minify: true,            // Minified output for size measurement
    treeShaking: true,       // Only include what's imported
    platform: "browser",     // Browser conditions for exports resolution
    jsx: "transform",
  },
  ansi: "ansi",
  init: { platform: PLATFORM_AUTO },
};
```

At build time, these are augmented with explicit **loader mappings** and **defines** (from [core/build.ts](../core/build.ts)):

```typescript
loader: {
  ".png": "file",    // Binary assets → referenced by URL, not inlined
  ".jpeg": "file",
  ".ttf": "file",
  ".svg": "text",    // SVG and HTML → imported as strings
  ".html": "text",
  ".scss": "css",    // SCSS → treated as CSS
},
define: {
  "__NODE__": "false",
  "process.env.NODE_ENV": "\"production\"",
},
write: false,        // Output to memory, not filesystem
outdir: "/",         // Virtual output directory
```

Key details:

- **`write: false`** — esbuild produces output as JavaScript objects rather than writing to disk
- **`file` loader** for `.png`, `.jpeg`, `.ttf` — tells esbuild to treat those as external binary assets (referenced by URL)
- **`text` loader** for `.svg`, `.html` — imports return the raw string content
- **`"production"` define** — enables dead code elimination in libraries that branch on `NODE_ENV`


## The Plugin Pipeline

The six esbuild plugins are registered in a **specific order** in [core/build.ts](../core/build.ts) — and this order is *load-bearing*. esbuild evaluates `onResolve` callbacks in registration order; the **first plugin that returns a result wins**. Returning `undefined` passes control to the next plugin.

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

Each plugin has one job; complex behavior emerges from their composition. Here is what each does:

---

### 1. AliasPlugin — *Rewrite import paths before resolution*

> **Source:** [core/plugins/alias.ts](../core/plugins/alias.ts)

Runs first because aliases must rewrite the import path *before* any other plugin tries to resolve it.

- If config specifies `{ alias: { "fs": "memfs" } }`, transforms `import "fs"` → `import "memfs"`
- Also handles **npm-style aliases** from `package.json` dependencies (e.g., `"react": "npm:preact@10"`)
- By running first, ensures all subsequent resolution operates on the *intended* package name

---

### 2. ExternalPlugin — *Handle Node.js builtins*

> **Source:** [core/plugins/external.ts](../core/plugins/external.ts)

Runs second to catch Node.js built-in modules (like `fs`, `path`, `crypto`) *before* the CDN plugin tries to fetch them from npm. Behavior depends on the **`polyfill`** setting:

| `polyfill` value | What happens to `import "fs"` |
|:-----------------|:-----------------------------|
| `false` *(default)* | Marked **external** — excluded from bundle with empty `export default {}` |
| `true` | Rewritten to a browser polyfill (e.g., `fs` → `memfs`, `path` → `path-browserify`), then falls through to CdnPlugin |

Polyfill mappings come from [utils/runtime-builtins.ts](../utils/runtime-builtins.ts), which catalogs **~50 Node.js builtins** with their browser alternatives.

---

### 3. TarballPlugin — *Extract packages from `.tgz` archives (HTTP + VFS)*

> **Source:** [core/plugins/tar.ts](../core/plugins/tar.ts)

Handles tarball-based package sources from **three branches**:
1. **HTTP tarball URLs** — `pkg.pr.new`, npm registry tarballs (`registry.npmjs.org/…/-/….tgz`), GitHub release tarballs, or any URL whose pathname contains a tarball extension
2. **VFS tarball paths** — absolute paths in the in-memory filesystem (e.g., `/packages/my-lib.tgz`)
3. **Self-reference imports** — when code *inside* an extracted tarball imports its own package name, resolves against the tarball's manifest instead of fetching from CDN

**Must be registered before VFS.** Without this ordering, a file like `/packages/my-lib.tgz` would be claimed by the VirtualFileSystemPlugin as a raw blob before the TarballPlugin could intercept and extract it.

**Detection** is fully delegated to `archive-detect`:
- `findTarballSplitInPathname()` walks pathname segments and calls `detectArchiveFromPathHint()` per segment — the first tarball-like segment is the split point between tarball fetch path and subpath
- `isTarballUrl()` checks for CDN-style origins (`getCDNStyle() === "tarball"`) *or* delegates to `isTarballPath()` for extension-based detection
- `isTarballPath()` is the path-based counterpart for VFS paths — both ultimately call `findTarballSplitInPathname()`

The tar plugin has **zero extension-matching logic of its own** — add a new tarball extension to `archive-detect` and it's automatically recognized here.

**Extraction pipeline:**
- `fetchAndExtractTarball(source, …)` accepts both HTTP URLs (fetched via `fetchWithCache`) and VFS paths (read via `getFile`, wrapped in `new Response()`)
- Archive format detection uses `detectArchiveFromResponse()` (multi-signal: extension, headers, magic bytes, ustar signature)
- Extracts into VFS under `/__tarballs__/<sha256-hash>/`
- **Content-addressed caching** (SHA-256 of the source) ensures the same tarball is fetched only once per build
- Reads the extracted `package.json` → resolves entry point via `exports` or legacy fields

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
- Resolution follows esbuild's filesystem pattern: *exact path match* → *extension probing* (`.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json`) → `/index.*` fallback
- **TarballPlugin runs first**, so tarball paths (e.g., `/packages/my-lib.tgz`) are intercepted and extracted before VFS sees them
- **Flow type stripping** runs in `onLoad` — tarball-extracted React Native packages may contain Flow annotations. See [Content Pre-Processing: Flow Type Stripping](#content-pre-processing-flow-type-stripping)

---

### 5. HttpPlugin — *Fetch and resolve HTTP/HTTPS URLs*

> **Source:** [core/plugins/http.ts](../core/plugins/http.ts)

The workhorse for all HTTP/HTTPS resolution and loading. Serves **five roles**:

1. **Direct URL imports** — handles `import "https://esm.sh/react"` directly
2. **Relative import resolution** — resolves paths like `"./jsx-runtime.js"` inside CDN-fetched modules against the **final URL** after redirects (critical because CDNs redirect `react@latest` → `react@19.0.0`)
3. **Manifest field remapping** — applies platform-specific path rewrites from top-level `package.json` fields (`"browser"`, `"react-native"`, `"electron"`) to relative imports *within* a package, using the `packageBaseUrl` passed from the CdnPlugin
4. **Extension probing** — when a relative import has no extension, tries **18 combinations**:

```
  2 path variants ("", "/index")
  × 9 extensions (.js, .mjs, .ts, .tsx, .cjs, .jsx, .mts, .cts, "")
  = 18 total probes
```

5. **Registry mode propagation** — when the configured CDN host is a *registry* (`getCDNStyle(host) === "registry"`), bare imports encountered inside HTTP-fetched files are resolved through the registry rather than following the parent file's CDN origin. This ensures **all transitive dependencies** flow through the configured registry when registry mode is active, even if a file was originally loaded from a different CDN.

   Without this, a file loaded from e.g. `esm.sh` would resolve its bare imports through `esm.sh` (CDN-follows-parent behavior). The `REGISTRY_HOST` check overrides this: `const origin = REGISTRY_HOST ? host : (NPM_CDN ? pathOrigin : host)` — registry mode always wins.

Also scans fetched source for `new URL("...", import.meta.url)` patterns to discover **WASM files** and **web workers** that need fetching alongside the module.

**Content pre-processing:** Before returning fetched content to esbuild, the `onLoad` handler runs two content-aware transformations: **Flow type stripping** (removes Flow annotations from React Native ecosystem packages) and **JSX loader upgrade** (detects JSX in `.js` files and upgrades the loader to `tsx`). Both are detailed in [Content Pre-Processing: Flow Type Stripping](#content-pre-processing-flow-type-stripping) and [Scenario 18 — JSX in `.js` Files](scenarios/18-jsx-in-js-files.md).

---

### 6. CdnPlugin — *Catch-all for bare npm imports*

> **Source:** [core/plugins/cdn.ts](../core/plugins/cdn.ts)

Runs last — by this point, every other strategy has had a chance. This plugin does the *heaviest* resolution work:

1. Parse the package specifier (name, version, subpath)
2. Fetch `package.json` from the configured **CDN** (Content Delivery Network)
3. Resolve the entry point through **conditional exports** or legacy fields
4. Compute **side effects** metadata (for tree-shaking)
5. Construct the final CDN URL

Also handles **JSR specifiers** (`jsr:@scope/name`), **npm aliases** (`npm:pkg@version`), and **subpath imports** (`#internal/...`). The full resolution algorithm is detailed next.

#### Registry Tarball Mode

When the CDN origin is a **registry** (`getCDNStyle(cdn) === "registry"` — triggered by `cdn: "npm"`, `cdn: "npm.registry"`, or `cdn: "https://registry.npmjs.org"`), the CdnPlugin takes a fundamentally different path. Instead of resolving individual files via a CDN like unpkg or esm.sh, it downloads the **entire package tarball** in one shot, extracts it to VFS, then resolves entry points from the extracted tree.

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

The REGISTRY_CDN flow:

1. **Resolve version** — calls `resolveVersion()` against the npm registry API (or a custom registry from `.npmrc` configuration)
2. **Fetch manifest** — calls `getPackageOfVersion()` to get the version-specific metadata, including `dist.tarball`
3. **Construct tarball URL** — `getPackageTarballUrl()` prefers the manifest's `dist.tarball` field (authoritative) and falls back to URL construction by convention
4. **Route through TarballPlugin** — calls `build.resolve(tarballUrl)`, which TarballPlugin intercepts, fetches, extracts to VFS, and resolves the entry point

**Why registry mode exists:**

- **Fewer HTTP requests** — large packages with many internal imports (lodash-es, @aws-sdk/*) generate hundreds of individual HTTP fetches in CDN mode. Registry mode collapses this into a single tarball download + local VFS resolution.
- **Exact npm parity** — uses the exact same files that `npm install` would produce.
- **No CDN quirks** — eliminates CDN-specific redirect/resolution differences.

**Scoped registry support.** The CdnPlugin normalizes the `BuildConfig.registry` field at init time via `normalizeRegistryConfig()` (from [utils/npmrc.ts](../utils/npmrc.ts)). For each bare import, `getRegistryForPackage()` resolves the appropriate registry by scope — e.g., `@jsr/std__path` routes to `https://npm.jsr.io` while `react` routes to the default registry. This config accepts a `RegistryConfig` object, a plain URL string, or raw `.npmrc` content (auto-detected by the presence of `=` or newlines).

**Transitive dependency propagation.** All bare imports from within extracted tarballs also resolve through the registry. The CdnPlugin always has the registry origin configured, and the [HttpPlugin's registry propagation](#5-httpplugin--fetch-and-resolve-httphttps-urls) ensures even files loaded from different CDNs route their deps through the registry when registry mode is active.


## How Resolution Works

The CdnPlugin (and the resolution utilities it calls) must faithfully implement the **Node.js module resolution algorithm** — the set of rules Node.js uses to find the actual file behind an `import` statement — but against *CDN-hosted packages* instead of a local `node_modules` directory.

> **Node.js module resolution** ([Node.js docs: packages](https://nodejs.org/api/packages.html)) specifies how the runtime maps an `import` specifier to a file on disk. The algorithm has two generations:
>
> - **Modern** (Node ≥ 12.7): the `exports` and `imports` fields in `package.json`, using **conditional exports** and **subpath patterns**
> - **Legacy**: the `main`, `module`, and `browser` fields — plus conventions like `index.js` fallback
>
> When you write `import "react"`, Node.js searches `node_modules/react/`, reads its `package.json`, follows the `exports` field (or falls back to legacy fields), and returns the resolved file path. bundlejs does exactly this, but over HTTP against a CDN.

bundlejs supports multiple **CDN** (Content Delivery Network) sources. The `cdn` config option selects which one to use — each has its own URL format (from [core/utils/cdn-format.ts](../core/utils/cdn-format.ts)):

| Config value | CDN URL | Style |
|:------------|:--------|:------|
| `"unpkg"` (default) | `https://unpkg.com` | npm |
| `"esm.sh"` or `"esm"` | `https://esm.sh` | npm |
| `"skypack"` | `https://cdn.skypack.dev` | npm |
| `"jsdelivr"` | `https://cdn.jsdelivr.net/npm` | npm |
| `"jsr"` | `https://jsr.io` | jsr |
| `"jsr.registry"` | `https://jsr.io` | jsr |
| `"deno"` | `https://deno.land/x` | deno |
| `"github"` | `https://raw.githubusercontent.com` | github |
| `"npm"` or `"npm.registry"` | `https://registry.npmjs.org` | registry |
| Any full URL | Used directly | Detected from URL |

The resolution algorithm has several distinct paths depending on what kind of import it encounters. The rest of this section walks through each one with real examples, explaining the relevant spec background first and then showing how bundlejs implements (or intentionally deviates from) it.


### Bare npm Imports — Conditional Exports

> **Spec background:** [Node.js Conditional Exports](https://nodejs.org/api/packages.html#conditional-exports) (Node ≥ 12.7) define a JSON structure in `package.json` `"exports"` where each key is a *subpath* (like `"."` or `"./utils"`) and each value is either a file path or a nested object whose keys are *conditions* (like `"import"`, `"require"`, `"browser"`, `"default"`). The runtime walks the condition keys in definition order and picks the **first matching** condition. This single mechanism replaces the older `main`/`module`/`browser` fields, unifying CJS, ESM, and platform-specific entry points in one declaration.

When you write `import { useState } from "react"`, the CdnPlugin:

1. Parses the specifier → name: `react`, version: `null`, subpath: `null`
2. No version specified → assumes `"latest"` → resolves exact version via the registry (e.g., `19.0.0`)
3. Fetches `https://unpkg.com/react@19.0.0/package.json`
4. Reads the `exports` field and resolves `"."` (the root entry point)
5. Returns `https://unpkg.com/react@19.0.0/index.js` in the `http-url` namespace

The **condition priority chain** determines which export path the resolver picks. For bundlejs targeting browsers with ESM, the default chain is:

```
  import → browser → module → default
  Fallback: require  (some packages only define CJS exports)
```

These conditions come from [utils/resolve-conditions.ts](../utils/resolve-conditions.ts) (see also: [Node.js docs: conditional exports](https://nodejs.org/api/packages.html#conditional-exports)). The chain varies by platform — bundlejs supports 10+ runtime profiles:

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

> **Where bundlejs deviates from Node.js:** The `"module"` condition is an **esbuild convention**, not part of the Node.js spec. Node.js does not recognize `"module"` as a condition key. bundlejs (via esbuild) injects it because many npm packages use `"module"` to expose ESM entry points. This is pragmatic — it matches what webpack, Rollup, and esbuild all do — but it means a package that behaves one way in Node.js might resolve differently in bundlejs.
>
> Additionally, bundlejs passes `unsafe: true` to the resolver, which relaxes strict exports matching. If ESM resolution fails entirely, it retries with `require: true` as a **compatibility fallback** — catching packages that only define CJS exports. This deviates from the spec (which would return an error), but it dramatically improves compatibility with real-world npm packages.

To see this in action, here is what React's `package.json` `exports` field *could* look like and how bundlejs resolves it:

```json
{
  "name": "react",
  "version": "19.0.0",
  "main": "index.js",
  "exports": {
    ".": {
      "react-server": "./react.react-server.js",
      "browser": "./index.js",
      "import": "./index.js",
      "require": "./index.js",
      "default": "./index.js"
    },
    "./package.json": "./package.json",
    "./jsx-runtime": {
      "react-server": "./jsx-runtime.react-server.js",
      "default": "./jsx-runtime.js"
    },
    "./jsx-dev-runtime": {
      "react-server": "./jsx-dev-runtime.react-server.js",
      "default": "./jsx-dev-runtime.js"
    },
    "./compiler-runtime": {
      "react-server": "./compiler-runtime.js",
      "default": "./compiler-runtime.js"
    }
  }
}
```

The resolver walks the conditions for `"."` in priority order: `browser` matches → returns `./index.js`. If this were a server-side build with `platform: "node"`, it would check `import` first (since `browser` is not in the node condition set), and still get `./index.js`.


### Subpath Exports and Imports

> **Spec background:** [Node.js Subpath Exports](https://nodejs.org/api/packages.html#subpath-exports) allow a package to define multiple entry points beyond the root `"."`. **Subpath patterns** (using `*` as a wildcard) let packages map entire directories without listing every file. The `*` in the key captures a segment, and the `*` in the value substitutes it — inspired by glob syntax but limited to a *single* `*` per key/value pair.
>
> [Subpath imports](https://nodejs.org/api/packages.html#subpath-imports) (the `"imports"` field, where keys start with `#`) serve a complementary role: they are *private* to the package. Only code *within* the package can use them. This gives library authors a way to create internal aliases (e.g., `#internal/utils`) without polluting the public API.


```typescript
import { Button } from "@ui-lib/components/button";
import { Dialog } from "@ui-lib/components/dialog";
```

A more complex example — suppose you import from a UI component library whose `package.json` looks like:

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

When you write `import { Button } from "@ui-lib/components/button"`:

1. CdnPlugin parses: name = `@ui-lib/components`, subpath = `./button`
2. The resolver tries each `exports` key against `"./button"`
3. `"."` does not match (subpath is not empty)
4. `"./*"` matches — captures `"button"` — substitutes into `"./dist/esm/*.js"` → `./dist/esm/button.js`
5. Returns `https://unpkg.com/@ui-lib/components@latest/dist/esm/button.js`

And `import { Tooltip } from "@ui-lib/components/features/tooltip"` would match `"./features/*"` → capture `"tooltip"` → produce `./dist/features/tooltip/index.js`.

**Subpath imports in practice.** bundlejs detects the `#` prefix in the CdnPlugin, looks up the *importer's* manifest (not the root manifest), and resolves through `imports`:

```json
{
  "name": "vfile",
  "imports": {
    "#minpath": { "node": "./lib/minpath.node.js", "default": "./lib/minpath.browser.js" }
  }
}
```

When code inside `vfile` does `import path from "#minpath"`, bundlejs resolves it using the browser condition → `./lib/minpath.browser.js`. If this resolution fails, bundlejs returns a **hard error** immediately — it never falls through to treat `#minpath` as a bare npm package name. This matches the Node.js spec: `#`-prefixed imports that fail resolution are *not* retried as package names.

> **Implementation note:** bundlejs delegates the actual exports/imports matching to the [`resolve.exports`](https://www.npmjs.com/package/resolve.exports) library by @lukeed, which implements the full Node.js resolution algorithm including pattern matching, `null` entries (explicit exclusion of subpaths), and nested condition objects.


### Legacy Resolution — Packages Without `exports`

> **Spec background:** Before `exports` existed, npm packages declared their entry point through a grab bag of fields that evolved organically:
>
> - **`main`** — the original Node.js field (since Node 0.4). Points to the CJS entry.
> - **`module`** — a community convention (never part of Node.js) proposed by Rollup to indicate an ESM entry. Widely adopted but never standardized.
> - **`browser`** — defined in [the `browser` field spec](https://github.com/nicolo-ribaudo/tc39-proposal-pkgjson-exports/blob/main/PRIOR-ART.md#browser) by the bundler community (primarily Browserify and webpack). Indicates a browser-specific entry point *or* a set of module remappings.
>
> The tricky part: bundlers disagree on the priority and semantics of these fields, especially `browser`. webpack, Rollup, esbuild, and Parcel all have subtly different behavior.

When the resolver finds no `exports`, it falls back to legacy fields. The fallback chain in bundlejs (from [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts)) depends on the platform:

| Platform | Legacy field priority |
|:---------|:---------------------|
| `browser` | `browser` → `module` → `main` |
| `node` | `module` → `main` |
| `neutral` | `module` → `main` |

The `browser` field has **two forms** with very different semantics. Consider `readable-stream`, a package that needs different implementations for Node.js and browsers:

```json
{
  "name": "readable-stream",
  "version": "3.6.2",
  "main": "./lib/stream.js",
  "browser": {
    "./lib/internal/streams/pipeline.js": "./lib/internal/streams/pipeline-browser.js",
    "./lib/internal/streams/finished.js": "./lib/internal/streams/finished-browser.js",
    "util": false,
    "string_decoder": false
  }
}
```

This is the **object form** — it is *not* an entry point. The entry still comes from `main` (`./lib/stream.js`). The object maps are applied as the bundler resolves imports *within* the package:
- `import "./pipeline.js"` → remapped to `./pipeline-browser.js`
- `import "util"` → `false` means **excluded** (empty module returned)

Compare with the **string form**, which *is* the entry point:

```json
{
  "name": "some-isomorphic-lib",
  "main": "./lib/node.js",
  "browser": "./lib/browser.js"
}
```

Here, `browser` replaces the entry entirely — no remapping, just a different file.

> **⚠️ This distinction matters.** The resolver in [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts) checks `typeof browser` — string/array → direct entry; object → remapping layer applied *after* finding the entry from other fields. Many packages use the browser field incorrectly, and different bundlers interpret edge cases differently.
>
> **Where bundlejs deviates:** Some edge runtimes (Cloudflare Workers, Vercel Edge) include `"browser"` in their condition set but set `browserField: false` — meaning they match the `"browser"` condition in `exports` but *do not* apply the legacy `browser` field remappings. This is a deliberate choice: these runtimes are server-like and should not get browser polyfill swaps for things like `crypto` or `stream`, even though they want browser-optimized code paths from `exports`.

If *all* legacy fields are missing, bundlejs applies a last-resort chain: check `unpkg` field → check `bin` field → try `./index.js`. This handles more packages than the spec strictly requires.

Note that the `browser` field (object form) is just one of several **manifest remapping fields** — `"react-native"` and `"electron"` follow the same pattern. Legacy resolution only applies remappings at entry point resolution time; *internal* relative imports go through a separate remapping pass in the [HttpPlugin](#5-httpplugin--fetch-and-resolve-httphttps-urls). See [Manifest Field Remapping for Relative Imports](#manifest-field-remapping-for-relative-imports) for the full story.


### Side Effects and Tree-Shaking

> **Spec background:** The `sideEffects` field is a [webpack convention](https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free) (not a Node.js spec) adopted by most bundlers. A **side effect** is code that executes on import — like a CSS file that applies styles, a polyfill that patches `window`, or a module-level `console.log()`. **Tree-shaking** (removing unused code) needs to know which files are safe to discard when their exports are not used. Without this signal, the bundler must conservatively assume *every* file has side effects and keep it all.

bundlejs reads the `sideEffects` field from `package.json` (via [core/utils/side-effects.ts](../core/utils/side-effects.ts)):

```json
{
  "name": "lodash-es",
  "sideEffects": false
}
```

| `sideEffects` value | Meaning |
|:----|:----|
| `false` | Entire package is side-effect-free. Safe to tree-shake aggressively. |
| `["*.css", "./src/init.js"]` | Only listed files have side effects. Everything else is safe. |
| Not present | Assume everything has side effects (conservative, no tree-shaking). |

Glob patterns like `*.css` are normalized to `**/*.css` to match anywhere in the package tree. The computed `sideEffects` value is passed to esbuild via the `onResolve` return value, enabling accurate tree-shaking even for CDN-fetched packages.

> **Implementation detail:** bundlejs only applies side-effects analysis to **JS-like files** (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.mts`, `.cts`, or no extension). CSS and other asset files are intentionally excluded — marking them as side-effect-free in a CDN environment is a common footgun because CSS *must* execute (apply styles) to have any effect.

This is why `/?q=lodash-es&treeshake=[{debounce}]` produces a dramatically smaller bundle than `/?q=lodash-es` — lodash-es declares `"sideEffects": false`, so esbuild can discard everything except `debounce` and its dependencies.

The preceding sections cover npm packages — the most common case. But bundlejs also handles several non-npm module systems that the CdnPlugin routes through before reaching the standard npm resolution path.


### JSR Modules — Deno's TypeScript-First Registry

> **Spec background:** [JSR](https://jsr.io) (JavaScript Registry) is a modern package registry ([JSR docs](https://jsr.io/docs)) designed for the post-Node.js era. Key differences from npm:
>
> - **TypeScript-first** — packages publish `.ts` source files directly, not pre-compiled `.js`
> - **Scoped by default** — every package is `@scope/name` (2–20 char scope, 2–58 char name, lowercase + numbers + hyphens)
> - **Semver-native** — versions are resolved via a registry API that understands semver ranges natively
> - **No dist-tags** — there is no `latest` or `next`; `"latest"` is computed as the highest non-yanked version
> - **Yanking** — versions can be marked as yanked (soft-deleted), which excludes them from resolution but does not remove them from URLs
>
> JSR exposes a JSON API for resolution ([JSR API docs](https://jsr.io/docs/api)): package metadata at `/@scope/name/meta.json`, version metadata at `/@scope/name/version_meta.json`, and source files at `/@scope/name/version/path`.

When you write:

```typescript
import { join } from "jsr:@std/path@1.0.0";
```

The CdnPlugin detects the `jsr:` prefix and takes a completely different path from npm resolution:

1. Parses with `parseJSRSpec()` → scope: `std`, name: `path`, version: `1.0.0`
2. If the version contains `^`, `~`, or is omitted → calls `resolveJSRVersion()` against the JSR registry API (`https://jsr.io/@std/path/meta.json`) to find the highest matching non-yanked version
3. Fetches the version metadata from `https://jsr.io/@std/path/1.0.0_meta.json`, which contains an `exports` map
4. Resolves the subpath (default: `"."` → typically `./mod.ts`) through the exports
5. Constructs the final URL: `https://jsr.io/@std/path/1.0.0/mod.ts`

Notice the URL format is different from npm CDNs — the version is a **path segment** (`/1.0.0/`), not an `@version` suffix. JSR modules are typically TypeScript source files (`.ts`) served directly, unlike npm packages which are usually pre-compiled JavaScript.

> **Where bundlejs deviates from the JSR spec:** The "latest" version computation sorts versions by `semver.format().localeCompare()` with `{ numeric: true }` — this is a string comparison, not strict semver ordering. It works correctly for stable releases but could produce unexpected results for pre-release versions (e.g., `1.0.0-alpha.10` vs `1.0.0-alpha.9`). This is a known trade-off: pre-release JSR packages are rare enough that the simpler implementation is acceptable.

If direct JSR resolution fails (e.g., due to a network issue), bundlejs falls back to `esm.sh`'s JSR proxy: `https://esm.sh/jsr/@std/path@1.0.0`. This fallback means JSR packages degrade gracefully even when the JSR API is unreachable.

```
/?q=jsr:@std/path&treeshake=[{join,resolve}]
```


### npm Aliases — Version Pinning and Package Swapping

> **Spec background:** The `npm:` protocol prefix in dependency versions (see [npm docs: aliases](https://docs.npmjs.com/cli/v10/using-npm/package-spec#aliases)) lets you install one package under a different name. This is commonly used for Deno compatibility (Deno uses `npm:` prefixes natively) or to swap implementations at the dependency level.

```json
{
  "dependencies": {
    "react": "npm:preact@10.24.0",
    "path": "npm:path-browserify@1.0.1"
  }
}
```

When bundlejs encounters `import "react"`, the AliasPlugin (or CdnPlugin's dependency lookup) detects the `npm:preact@10.24.0` alias via `parseNpmSpec()`, which classifies it as an `AliasSpec`. The CdnPlugin then unwraps the alias:

- `effectiveName` = `preact` (the *actual* package to fetch)
- `effectiveVersion` = `10.24.0`
- Resolution continues as normal, but fetches `preact` instead of `react`

> **Limitation:** Nested aliases (`npm:npm:foo`) are explicitly rejected. Alias targets must be registry packages — you cannot alias to a URL, path, or git reference.


### URL Dependencies and Tarball Extraction

> **Spec background:** npm's `package.json` allows **URL-based dependency versions** — any `https://` URL pointing to a `.tgz` tarball is a valid dependency specifier ([npm docs: urls as dependencies](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#urls-as-dependencies)). This is commonly used with services like [pkg.pr.new](https://pkg.pr.new) (which builds npm packages from pull requests), npm's own publish tarballs, and GitHub release assets.
>
> The tarball format itself follows the **tar** (tape archive) standard (POSIX.1-2001 / pax format), typically compressed with **gzip**. npm packages are always `package/` rooted inside the tarball — every file path starts with `package/` by convention.

bundlejs supports tarball extraction through a **two-layer architecture**:

1. **Routing layer** — Two detection methods work together:
   - `getCDNStyle()` in [core/utils/cdn-format.ts](../core/utils/cdn-format.ts) classifies CDN-style origins (e.g., `pkg.pr.new` → `"tarball"`)
   - `isTarballUrl()` and `isTarballPath()` delegate to `archive-detect`'s `detectArchiveFromPathHint()` to recognize any URL or VFS path containing a tarball extension (`.tgz`, `.tar.gz`, `.tar.zst`, etc.)

   Together, these catch tarballs from *any* origin — npm registry, GitHub releases, custom servers, local VFS — without per-origin configuration.

2. **Detection and extraction layer** — the [utils/archive-detect.ts](../utils/archive-detect.ts) module uses a multi-signal pipeline to identify archives from any source:

   | Signal | Source | Examples detected |
   |:-------|:-------|:-----------------|
   | **URL extension** | Path analysis | `.tgz`, `.tar.gz`, `.tar.zst`, `.tar.bz2`, `.tar.xz`, `.tar.br`, `.tar.lz4`, `.txz`, `.tbz2` |
   | **HTTP headers** | `Content-Type` | `application/tar`, `application/gzip`, `application/x-tar`, `application/zstd`, `application/octet-stream` |
   | **Content-Disposition** | RFC 6266 + RFC 8187 | `filename="package.tgz"`, `filename*=utf-8''pkg.tar.gz` |
   | **Magic bytes** | Binary sniffing | gzip (`1F 8B`), bzip2 (`42 5A 68`), xz (`FD 37 7A 58 5A 00`), zstd (`28 B5 2F FD`), lz4 (`04 22 4D 18`), zip (`PK`), lzip (`4C 5A 49 50`) |
   | **Tar confirmation** | Post-decompression | `"ustar"` magic at byte offset 257 (POSIX tar header) |

   The header parsing follows the specs rigorously — `Content-Type` uses RFC media type grammar, `Content-Encoding` follows RFC 9110, and `Content-Disposition` implements both strict RFC 6266 parsing and a lenient recovery fallback for the many servers that produce non-compliant headers.

When bundlejs processes a tarball URL dependency like:

```json
{
  "dependencies": {
    "@tanstack/react-query": "https://pkg.pr.new/@tanstack/react-query@7988"
  }
}
```

The CdnPlugin classifies the version as a `UrlSpec` and re-enters the plugin chain via `build.resolve()`. The TarballPlugin intercepts and runs through this process:

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
    │ NO  │ → Fetch .tgz → detect archive format → decompress → extract
    └──┬──┘
       │
       ▼
  Write all files to VFS:
    /__tarballs__/a1b2c3d4e5f6g7h8/package.json
    /__tarballs__/a1b2c3d4e5f6g7h8/dist/index.js
    /__tarballs__/a1b2c3d4e5f6g7h8/dist/query-client.js
    ...
       │
       ▼
  Read extracted package.json → resolve entry via exports/legacy
       │
       ▼
  Return VFS path: /__tarballs__/a1b2c3d4e5f6g7h8/dist/index.js
```

The content-addressed hash ensures the same tarball is only fetched once per build, even if multiple dependencies reference it. Each mount is tracked in `LocalState.tarballMounts` with its manifest and root path.

The TarballPlugin also handles **self-reference imports**. If code *inside* the extracted `@tanstack/react-query` tarball does `import { QueryClient } from "@tanstack/react-query"` (importing itself by name), the plugin detects this — the import path matches the mount's `manifest.name` — and resolves against the local VFS mount instead of fetching from a CDN. This is critical for packages that use their own name in internal imports.

> **Current extraction limits:** While the detection layer recognizes *many* compression formats, the extraction path currently supports only **gzip-compressed** tars (`.tgz`, `.tar.gz`) and **uncompressed** tars (`.tar`). Other formats (zstd, xz, bzip2, lz4) are detected and produce a clear error with a suggestion to add the corresponding decompressor. This is a reasonable trade-off — npm tarballs are *always* gzip-compressed (`application/tar+gzip`), so every real npm dependency works. The detection infrastructure is intentionally over-capable to make adding new formats straightforward when the need arises.
>
> **VFS tarballs:** The TarballPlugin also handles tarballs stored directly in the VFS (e.g., `/packages/my-lib.tgz`). `fetchAndExtractTarball()` reads the raw bytes via `getFile()` and wraps them in a `new Response()`, feeding into the same detection → decompress → untar pipeline as HTTP tarballs. This is why TarballPlugin must be registered before VFSPlugin — see [Plugin Pipeline](#the-plugin-pipeline).

```
/?q=@tanstack/react-query&config={"package.json":{"dependencies":{"@tanstack/react-query":"https://pkg.pr.new/@tanstack/react-query@7988"}}}
```


### Relative Imports and CDN Redirects

When the CdnPlugin resolves `react` to `https://unpkg.com/react@19.0.0/index.js`, esbuild fetches that file. Inside, it might contain:

```javascript
// https://unpkg.com/react@19.0.0/index.js
export { createElement, Fragment } from "./jsx-runtime.js";
export { useState, useEffect } from "./hooks.js";
```

The `"./jsx-runtime.js"` import needs to resolve against the correct base URL. But here is the complication: CDNs frequently **redirect**. The original request to `react@19.0.0/index.js` might redirect to `react@19.0.0/es2022/index.js`. If the HttpPlugin resolved the relative import against the *original* URL, it would look for `react@19.0.0/jsx-runtime.js` — wrong directory.

The HttpPlugin solves this by storing the **final URL** (post-redirect) in `pluginData.url`. Relative imports are resolved with:

```typescript
resolvedPath = urlJoin(args.pluginData?.url, "../", argPath);
// e.g., urlJoin("https://esm.sh/react@19.0.0/es2022/index.js", "../", "./jsx-runtime.js")
//     → "https://esm.sh/react@19.0.0/es2022/jsx-runtime.js"  ✓
```

When a relative import has **no file extension** (e.g., `import "./utils"`), the HttpPlugin tries up to 18 URL combinations — 2 path variants (`""`, `"/index"`) × 9 extensions (`.js`, `.mjs`, `.ts`, `.tsx`, `.cjs`, `.jsx`, `.mts`, `.cts`, `""`). Failed probes are cached in `failedExtensionChecks` to avoid repeating HEAD requests for the same URLs.

> **Why 18 probes?** Node.js does not probe for extensions — if you write `import "./utils"`, Node.js expects a file literally named `utils` (no extension) or relies on `exports` to resolve it. But CDN-served packages were often built for bundlers like webpack that *do* probe. bundlejs inherits this behavior from esbuild's loader system: each probed extension maps to a loader (`.ts` → TypeScript, `.json` → JSON, etc.). This is a pragmatic deviation from Node.js strict resolution — without it, many CDN-fetched packages would fail to resolve their internal imports.

#### Manifest Field Remapping for Relative Imports

After URL resolution — but *before* extension probing — the HttpPlugin checks whether the resolved relative path should be **remapped** to a platform-specific alternative. This handles packages that ship different implementations for different runtimes via top-level `package.json` fields.

> **Convention background:** The `"browser"` field was the original remapping mechanism, [defined by the bundler community](https://github.com/nicolo-ribaudo/tc39-proposal-pkgjson-exports/blob/main/PRIOR-ART.md#browser) (Browserify, webpack). Other ecosystems adopted the same pattern with different field names:
>
> | Field | Convention | Activated by condition |
> |:------|:-----------|:----------------------|
> | `"browser"` | Browserify / webpack / esbuild | `"browser"` |
> | `"react-native"` | Metro bundler (React Native) | `"react-native"` |
> | `"electron"` | Electron apps (less common) | `"electron"` |
>
> Structurally, all three work identically — an object mapping source paths to replacement paths (or `false` to exclude).

Consider `@exodus/bytes`, which ships both browser and React Native variants:

```json
{
  "browser": {
    "./fallback/platform.js": "./fallback/platform.browser.js",
    "./fallback/utf8.auto.js": "./fallback/utf8.auto.browser.js"
  },
  "react-native": {
    "./fallback/platform.js": "./fallback/platform.native.js",
    "./fallback/utf8.auto.js": "./fallback/utf8.auto.native.js"
  }
}
```

When `utf8.js` internally imports `"./fallback/platform.js"`, the HttpPlugin:

1. Joins the relative path against the parent URL → `https://unpkg.com/@exodus/bytes@1.13.0/fallback/platform.js`
2. Strips the `packageBaseUrl` to get the package-relative path → `"./fallback/platform.js"`
3. Iterates over remapping fields in priority order (`react-native` → `electron` → `browser`), checking which ones match the active conditions
4. Applies the **first matching** remapping — e.g., with browser conditions, rewrites to `"./fallback/platform.browser.js"`; with React Native conditions, rewrites to `"./fallback/platform.native.js"`
5. Reconstructs the full URL → `https://unpkg.com/@exodus/bytes@1.13.0/fallback/platform.browser.js`

If a remapping maps to `false`, the HttpPlugin returns an esbuild error (module excluded for the current environment) rather than silently fetching a file that does not exist or is wrong for the platform.

The implementation lives in `applyManifestRemappings()` in [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts). The `REMAPPING_FIELDS` constant defines the field-to-condition mapping and their priority order.

> **Why does priority order matter?** When both `"browser"` and `"react-native"` conditions are active (which can happen with custom condition sets), the more-specific field (`"react-native"`) should win. The priority order mirrors how `exports` conditions work — first match takes precedence.


### Node.js Builtins — Polyfill or Exclude

When a CDN-fetched module does `import { readFile } from "fs"`, the ExternalPlugin catches it before the CdnPlugin can try to fetch `fs` from npm (which does not exist as a package). The behavior depends on the polyfill setting:

With `polyfill: false` (the default), the builtin is **excluded** and an empty export is returned. This is the right choice when measuring browser bundle size — you do not want `fs` inflating your numbers:

```
/?q=some-server-pkg                      → fs excluded, reports browser-only size
```

With `polyfill: true`, the builtin is **rewritten** to its browser polyfill. The mappings from [utils/runtime-builtins.ts](../utils/runtime-builtins.ts) include ~50 entries like:

| Node.js builtin | Browser polyfill |
|:----------------|:-----------------|
| `fs` | `memfs` |
| `path` | `path-browserify` |
| `crypto` | `crypto-browserify` |
| `stream` | `stream-browserify` |
| `buffer` | `buffer` |
| `events` | `events` |

The rewritten import falls through to the CdnPlugin, which fetches the polyfill package from the CDN normally.

```
/?q=some-server-pkg&polyfill             → fs → memfs, reports full polyfilled size
```

The `node:` prefix (e.g., `import "node:fs"`) is stripped before matching — both `"fs"` and `"node:fs"` resolve to the same polyfill or exclusion.


### Import Maps

> **Spec background:** [Import maps](https://html.spec.whatwg.org/multipage/webappapis.html#import-maps) are a **WHATWG HTML standard** (also adopted by [Deno](https://docs.deno.com/runtime/fundamentals/modules/#import-maps)) that lets you remap bare specifiers without a bundler. An import map is a JSON object with `imports` (global remappings) and `scopes` (per-directory overrides).

bundlejs supports import maps through [utils/resolve-import-map.ts](../utils/resolve-import-map.ts), following the WHATWG algorithm:

1. If a referrer URL is provided, check **scopes** — sorted by key length (longest first, per spec)
2. For each matching scope, try to resolve the specifier via **exact match** first, then **prefix match** (keys ending with `/`, sorted by length)
3. Fall back to top-level **imports**

```json
{
  "imports": {
    "lodash": "https://esm.sh/lodash-es@4.17.21",
    "react": "https://esm.sh/preact@10.24.0/compat"
  },
  "scopes": {
    "/vendor/": {
      "react": "https://esm.sh/react@18.3.0"
    }
  }
}
```

> **Known deviation:** The implementation does not sort import specifier keys by code-unit order (the spec requires this). In practice, this only matters if a package has overlapping prefix keys with identical lengths — an extremely rare edge case.


### Unsupported Dependency Types

The `parseNpmSpec()` function in [utils/npm-spec.ts](../utils/npm-spec.ts) (following [npm-package-arg](https://github.com/npm/npm-package-arg) behavior) classifies every dependency version into one of these types:

| Type | Example | Supported? |
|:-----|:--------|:-----------|
| **semver** | `^1.2.3`, `~1.0.0`, `>=2.0.0` | ✅ |
| **version** | `1.2.3` (exact) | ✅ |
| **tag** | `latest`, `next`, `beta` | ✅ |
| **alias** | `npm:preact@^10` | ✅ |
| **url** | `https://pkg.pr.new/...` | ✅ (via TarballPlugin) |
| **jsr** | `jsr:@std/path@1.0.0` | ✅ (via JSR API) |
| `git` | `github:user/repo#semver:^1.0.0` | ❌ Error |
| `file` | `file:./local.tgz` | ❌ Unsupported — see VFS alternatives below |
| `directory` | `file:./packages/foo` | ❌ Unsupported — see VFS alternatives below |
| `workspace` | `workspace:*` | ❌ Error |
| `link` | `link:../sibling` | ❌ Error |

The unsupported types all require local filesystem access or git operations — neither of which bundlejs has in a CDN/edge environment. When encountered, the CdnPlugin returns a descriptive error explaining what was found and why it cannot be resolved.

> **The `file:` gap and VFS alternatives.** While bundlejs cannot resolve `file:` protocol specs (there is no local filesystem), the **VFS plugin** provides an equivalent mechanism. The `vfs:` and `virtual:` URI schemes let you reference files in bundlejs's in-memory filesystem:
>
> ```typescript
> import utils from "vfs:/lib/my-utils.ts";      // Explicit VFS reference
> import config from "virtual:./config.json";     // Also works with relative paths
> import entry from "/index.tsx";                  // Absolute paths resolve against VFS too
> ```
>
> These schemes are handled by the VirtualFileSystemPlugin (see [Plugin 4](#4-virtualfilesystemplugin--in-memory-file-layer) above). You can pre-populate the VFS at build time with `setFile()`, making `vfs:` a practical alternative to `file:` for injecting local content into a build. The prefixes are configurable via `opts.prefixes` — the defaults are `["vfs:", "virtual:"]`.

That covers the full resolution picture — from bare npm imports through JSR, tarballs, aliases, and builtins. The next section covers a different problem: what happens when a resolved file's *content* is not valid JavaScript as far as esbuild is concerned.


## Content Pre-Processing: Flow Type Stripping

> **Source:** [core/utils/flow-strip.ts](../core/utils/flow-strip.ts) · **Scenario doc:** [Scenario 20 — Flow Type Stripping](scenarios/20-flow-type-stripping.md)

After a file is resolved and its content is fetched (from CDN) or read (from VFS), but *before* esbuild parses it, bundlejs runs **content-aware transformations** that fix syntax esbuild cannot handle. The most significant of these is **Flow type stripping** — removing Meta's Flow type annotations from JavaScript files.

This section covers what Flow is, how it differs from TypeScript, why npm packages contain it, and how bundlejs strips it.


### What Is Flow?

**[Flow](https://flow.org/)** is a **static type checker for JavaScript**, created by **Meta (Facebook)** and open-sourced in 2014. Like TypeScript, it lets developers add type annotations to JavaScript. Unlike TypeScript, Flow does not define a new language or file extension — Flow annotations are written directly in `.js` files, marked with a `// @flow` pragma.

> **Mental model:** TypeScript *replaces* JavaScript's type story — it defines a `.ts` language that is a superset of `.js`. Flow *annotates* JavaScript without changing its identity — a `.js` file with Flow annotations is still a JavaScript file, just one with extra annotations that Flow-aware tooling can read and everyone else must strip.

Flow was created to solve the same problem as TypeScript — catching type errors before runtime — but with a different design philosophy:

- **Soundness-first** — Flow's type system was designed to be more *sound* (fewer false negatives) than TypeScript's, at the cost of being stricter
- **Gradual adoption** — the `@flow` pragma means you can add Flow to individual files without converting an entire codebase
- **No new language** — no `.flow` or `.fjs` extension; annotations live in standard `.js` files

In practice, TypeScript has become the dominant choice for new projects. Flow's usage is concentrated in **Meta's open-source ecosystem** — React Native, Expo, fbjs, and related packages.


### Flow vs TypeScript — Syntax and Ecosystem

Flow and TypeScript share some syntax (type annotations on parameters, generics, `type` and `interface` declarations), but Flow introduces several syntax forms that are **completely invalid** in both JavaScript and TypeScript:

```js
// @flow

// ❌ import typeof — imports the *type* of a value binding
//    TypeScript uses `import type { X }` instead
import typeof ActionSheetIOS from './ActionSheetIOS';

// ❌ opaque type — an opaque type alias only visible within the defining module
//    No TypeScript equivalent (TS uses branded types as a workaround)
opaque type Token = string;

// ❌ Flow utility types — $-prefixed built-in type operators
//    TypeScript has its own utility types (Partial<T>, Pick<T,K>, etc.)
//    but does NOT use the $ prefix
type Props = $Exact<{ name: string }>;
type Diff = $Diff<Full, Partial>;
type Mapped = $ObjMap<Obj, <V>(V) => Array<V>>;

// ❌ Type cast expressions (non-standard parenthesized syntax)
//    TypeScript uses `value as Type` instead
const x = (value: any);

// ❌ declare module with Flow-specific syntax
declare module 'react-native' { }
declare export default class Foo { }
```

The full comparison:

| Aspect | Flow | TypeScript |
|:-------|:-----|:-----------|
| **File extension** | `.js` (same as JavaScript) | `.ts` / `.tsx` |
| **Pragma** | `// @flow` at top of file | None required |
| **Import type syntax** | `import typeof X from '...'` | `import type { X } from '...'` |
| **Opaque types** | `opaque type Foo = Bar` (built-in keyword) | No equivalent (use branded types) |
| **Utility types** | `$Exact<T>`, `$Diff<A,B>`, `$ObjMap<T,F>` | `Partial<T>`, `Omit<T,K>`, `Record<K,V>` |
| **Type casts** | `(value: Type)` (parenthesized) | `value as Type` |
| **Ecosystem** | React Native, Metro, Expo, Meta OSS | Broadly adopted across the web ecosystem |
| **Type stripping support** | `flow-remove-types`, Babel plugin | esbuild, SWC, OXC, `tsc`, Node.js 22+ |
| **Spec status** | No TC39 proposal; Meta-proprietary | No TC39 proposal; Microsoft-backed |

> **The TC39 Type Annotations proposal.** There is an active [TC39 proposal (Stage 1)](https://github.com/tc39/proposal-type-annotations) that would let JavaScript engines natively *ignore* type annotation syntax. If this proposal advances, Flow annotations in `.js` files could become valid JavaScript — eliminating the need for stripping entirely. As of 2025, this proposal has not progressed beyond Stage 1.

> **Node.js `--experimental-strip-types`.** Starting with Node.js 22, the `--experimental-strip-types` flag (powered by `amaro`/SWC) can strip **TypeScript** types natively at startup. It does **not** support Flow. This asymmetry is a concrete example of Flow's narrower tooling support.


### Why Do npm Packages Contain Flow Syntax?

In the **React Native / Metro / Expo ecosystem**, shipping raw Flow annotations in `.js` files is the **convention** — not the exception:

1. **Metro bundler** — React Native's default build tool — has **native Flow support**. Its Babel pipeline includes `@babel/plugin-transform-flow-strip-types`, so it strips Flow automatically. Packages don't need to pre-compile.

2. **React Native itself** (`react-native` on npm) ships its *entire source* as Flow-annotated `.js` files. The `index.js` entry point is full of `import typeof` statements — the exact syntax that triggered this feature.

3. **Expo SDK packages**, **fbjs**, **react-native-web**, and other Meta OSS packages follow the same pattern.

4. **Metro's `.js` = JSX + Flow convention.** Metro treats *all* `.js` files as capable of containing both JSX *and* Flow syntax by default. This means a single `.js` file in the React Native ecosystem may require *both* [Flow stripping](#flow-stripping-pipeline) and [JSX loader upgrade](scenarios/18-jsx-in-js-files.md).

This creates a problem for **any bundler that isn't Metro**: the published npm package contains syntax that no standard JavaScript parser understands.

```
Metro Bundler (React Native)               Any other bundler (esbuild, webpack, etc.)
┌───────────────────────────────┐           ┌───────────────────────────────┐
│  .js with Flow annotations    │           │  .js with Flow annotations    │
│             │                 │           │             │                 │
│             ▼                 │           │             ▼                 │
│  Babel: @flow strip plugin    │           │  ??? → parse error            │
│             │                 │           │                               │
│             ▼                 │           │  bundlejs: flow-remove-types  │
│  Valid JavaScript             │           │             │                 │
│             │                 │           │             ▼                 │
│             ▼                 │           │  Valid JavaScript             │
│  Bundle output                │           │             │                 │
└───────────────────────────────┘           │             ▼                 │
                                            │  esbuild continues            │
                                            └───────────────────────────────┘
```

The specific error that motivated this feature:

```
✘ [ERROR] Unexpected "typeof"
    react-native@1000.0.0/index.js:14:7:
      14 │ import typeof ActionSheetIOS from './Libraries/ActionSheetIOS/ActionSheetIOS';
         │        ~~~~~~
```

esbuild sees `import typeof` — valid in neither JavaScript nor TypeScript — and fails at the parse phase. No amount of configuration or loader selection can fix this; the syntax must be removed *before* esbuild sees it.


### Why Not OXC, SWC, or esbuild Itself?

Before implementing a dedicated stripping layer, we evaluated existing tools:

| Tool | Can strip Flow? | Details |
|:-----|:---------------|:--------|
| **esbuild** | ❌ No | No Flow support at all. Cannot be configured to ignore Flow syntax. |
| **OXC** (`oxc-transform`) | ❌ No | Explicitly rejects Flow. The parser detects `@flow` pragmas and emits `"Flow is not supported"`. Only handles TypeScript type stripping. ([Source](https://github.com/oxc-project/oxc)) |
| **SWC** | ❌ No | No built-in Flow support. |
| **Babel** + `@babel/plugin-transform-flow-strip-types` | ✅ Yes | Works, but requires `@babel/core` + parser + plugin — a heavy dependency chain with significant startup cost. Too expensive for per-request bundling. |
| **`flow-remove-types`** | ✅ Yes | Official tool from the Flow team. Built on `hermes-parser` (Meta's Hermes engine compiled to WASM). Lightweight, zero-config, understands all Flow syntax. **This is what bundlejs uses.** |

> **`hermes-parser`** is the parser from [Hermes](https://github.com/nicolo-ribaudo/hermes-parser-wasm) — Meta's JavaScript engine designed for React Native. When compiled to WASM, it can parse JavaScript files containing ES6+, Flow annotations, and JSX — the exact combination that React Native packages use. `flow-remove-types` wraps `hermes-parser` to produce clean JavaScript output with Flow annotations replaced by whitespace (preserving source positions).


### Flow Stripping Pipeline

> **Source:** [core/utils/flow-strip.ts](../core/utils/flow-strip.ts)

The implementation has three layers, ordered from cheapest to most expensive:

```
                     Flow Stripping Pipeline

  ┌───────────────────────────────────────────────────────────────┐
  │  Layer 1: Detection — containsFlow(content, opts?)            │
  │                                                               │
  │  1a. Known-package fast path (Set lookup: "react-native")     │
  │  1b. URL heuristic (/react-native/ or /react-native@ in URL)  │
  │  1c. @flow pragma scan (first 4 KB only)                      │
  │  1d. Syntax pattern scan (import typeof, opaque type, $...)   │
  │                                                               │
  │  → false? Return content unchanged. Zero overhead.            │
  └───────────────────────────┬───────────────────────────────────┘
                              │ true
                              ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  Layer 2: Full stripping — flow-remove-types (hermes-parser)  │
  │                                                               │
  │  Uses hermes-parser (WASM) for complete AST-based type        │
  │  removal. Replaces all annotations with whitespace,           │
  │  preserving source positions (line/column numbers stable).    │
  │                                                               │
  │  When source maps are enabled: generates a v3 source map      │
  │  via .generateMap() and embeds it inline as a                 │
  │  //# sourceMappingURL=data:... comment for esbuild to fold    │
  │  into the final bundle map.                                   │
  │                                                               │
  │  → success? Return cleaned source (+ inline map if enabled).  │
  │  → parse error or unavailable? Fall through to Layer 3.       │
  └───────────────────────────┬───────────────────────────────────┘
                              │ fallback
                              ▼
  ┌───────────────────────────────────────────────────────────────┐
  │  Layer 3: Regex fallback — regexStripFlow()                   │
  │                                                               │
  │  Best-effort removal of the patterns that most commonly       │
  │  cause esbuild parse failures:                                │
  │  • @flow pragmas → whitespace                                 │
  │  • import typeof → import (preserving columns)                │
  │  • import type { ... } from '...' → whitespace                │
  │  • export type { ... } → whitespace                           │
  │                                                               │
  │  ⚠ Does NOT handle: inline type annotations, opaque type      │
  │    bodies, type cast expressions, generic parameters,         │
  │    declare statements.                                        │
  └───────────────────────────────────────────────────────────────┘
```


#### Layer 1: Detection — `containsFlow()`

Detection is ordered by cost (cheapest first) and short-circuits on the first positive signal:

1. **Known-package lookup** — a `Set` of package names known to ship Flow source. Currently contains `"react-native"`. The URL or `packageName` option provides the lookup key. This check is O(1) and avoids content scanning entirely.

2. **URL heuristic** — scans the URL string for known-package names (e.g., `/react-native/` or `/react-native@`). Catches files loaded via CDN where the package name is encoded in the URL path.

3. **`@flow` pragma** — scans only the first **4 KB** of the file for `// @flow` or `/* @flow */`. Most properly authored Flow files include this pragma in their first comment block. The 4 KB window keeps scanning fast for large non-Flow files.

4. **Syntax pattern scan** — tests the full content against three regex patterns chosen for **near-zero false positives** in standard JavaScript and TypeScript:

   | Pattern | Matches | Why it's safe |
   |:--------|:--------|:--------------|
   | `/\bimport\s+typeof\b/` | `import typeof Foo from '...'` | Invalid in both JS (`typeof` not allowed after `import`) and TS (uses `import type` instead) |
   | `/\bopaque\s+type\b/` | `opaque type Foo = ...` | `opaque type` as two consecutive tokens does not appear in JS or TS. TS has `type` but not `opaque type` |
   | `/\$(?:Exact\|Diff\|ObjMap\|...)\b/` | `$Exact<T>`, `$Diff<A,B>`, etc. | Flow-specific utility types. The `$` prefix + specific names are extremely unlikely outside Flow |

> **Why not detect `import type`?** TypeScript uses `import type { X } from '...'` extensively — triggering on this pattern would produce false positives on every TypeScript codebase. Flow's `import typeof` is the distinguishing marker — it is syntactically invalid in TypeScript.


#### Layer 2: Full Stripping — `flow-remove-types`

When `containsFlow()` returns `true`, the `stripFlowTypes()` function invokes `flow-remove-types`:

```typescript
import flowRemoveTypes from "flow-remove-types";

const result = flowRemoveTypes(sourceText, { pretty: true, all: true });
const code = result.toString();
```

- **`pretty: true`** — removes extra whitespace left by type erasure, producing cleaner output
- **`all: true`** — strips *all* files passed to it, not just those with `@flow` pragma. Since detection already filters, every file that reaches this layer should be stripped

The `flow-remove-types` package replaces type annotations with whitespace by default (spaces and newlines), which **preserves source positions** — line numbers and column offsets in the output match the original. This is important for error messages and source maps referencing the original file.

If `flow-remove-types` throws (e.g., a parse error on malformed input), the function falls through to the regex fallback.

##### Source Map Generation

`flow-remove-types` can also produce a **v3 source map** that maps the stripped output back to the original Flow source. This is valuable for debugging: when source maps are enabled, browser devtools display the *original* Flow source rather than the stripped intermediate.

The map is generated via `.generateMap()` on the return value:

```typescript
const map = result.generateMap(); // → { version: 3, sources, names, mappings }
```

**How it integrates with esbuild:** esbuild's `onLoad` callback has no dedicated `sourceMap` field in its return type. The established convention is to append the map as an **inline `//# sourceMappingURL=data:...` comment** to the `contents` string. esbuild recognises this comment, parses the embedded map, and folds it into the final bundle source map automatically.

```
  Stripped JS code (from flow-remove-types)
  + "\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,<payload>"
       │
       ▼
  esbuild onLoad → parses inline map → merges into bundle .map
       │
       ▼
  Browser devtools → shows original Flow source
```

The implementation patches the raw map before embedding:

1. **`sources`** — set to the original URL/path (e.g., `https://esm.sh/react-native@0.74.0/index.js`) so devtools show the correct filename
2. **`sourcesContent`** — set to the original (pre-strip) source text, so devtools can display the code even without fetching the original URL

```typescript
map.sources = [sourceFileName]; // e.g. the CDN URL or VFS path
map.sourcesContent = [originalText]; // original Flow source
```

**When source maps are *not* meaningful:** In non-pretty mode (`pretty: false`), `flow-remove-types` preserves positions by replacing annotations with equivalent whitespace. Every line/column in the output already matches the original, so the map would be a trivial identity mapping. Source maps are only useful with `pretty: true` (the default), where whitespace is cleaned up and positions shift.

**Regex fallback does not produce maps.** Layer 3's regex stripper does not generate source maps — tracking every replacement offset would defeat the purpose of a lightweight fallback. This is acceptable because the regex path is a last-resort safety net, and in practice `flow-remove-types` handles all files.


#### Layer 3: Regex Fallback — `regexStripFlow()`

The regex fallback is a **last resort** for when `flow-remove-types` is unavailable or fails. It handles only the patterns that most commonly cause esbuild parse failures:

| Input | Output | Technique |
|:------|:-------|:----------|
| `import typeof Foo from './Foo'` | `import        Foo from './Foo'` | Replace `typeof` with spaces |
| `import type { X } from 'mod'` | *(entire line → whitespace)* | Preserve line structure |
| `export type { X }` | *(entire line → whitespace)* | Preserve line structure |
| `// @flow` | *(whitespace)* | Pragma removal |
| `/* @flow */` | *(whitespace, preserving newlines)* | Block comment pragma removal |

The fallback **does not handle**: inline type annotations (`function foo(x: string) {}`), type cast expressions (`(value: Type)`), opaque type declarations, generic parameters in Flow syntax, or `declare` statements. These would still cause esbuild parse errors. In practice, `flow-remove-types` is an explicit dependency (listed in [core/deno.jsonc](../core/deno.jsonc)) and should always be available — the regex fallback exists as a safety net, not a primary code path.


### Integration Into the Plugin Pipeline

Flow stripping hooks into esbuild's **`onLoad`** phase — the moment a plugin returns file content to esbuild for parsing. Two plugins apply it:

**HttpPlugin** ([core/plugins/http.ts](../core/plugins/http.ts)):

```
  CDN fetch → raw bytes (Uint8Array)
       │
       ▼
  maybeStripFlow(content, { url, sourceMap: enableSourceMaps })
       │
       ├─ Flow detected → strip (+ inline map if enabled) → return to esbuild
       └─ No Flow       → return original bytes to esbuild
```

**VirtualFileSystemPlugin** ([core/plugins/fs.ts](../core/plugins/fs.ts)):

```
  VFS getFile() → raw bytes (Uint8Array)
       │
       ▼
  maybeStripFlow(content, { url: args.path, sourceMap: enableSourceMaps })
       │
       ├─ Flow detected → strip (+ inline map if enabled) → return to esbuild
       └─ No Flow       → return original bytes to esbuild
```

**ExternalPlugin** does **not** need Flow stripping — it returns a static `export default {}` stub.

The entry point for both is `maybeStripFlow()`, which combines detection, stripping, and optional inline source map embedding in one call:

```typescript
// Returns { contents, wasStripped }
// - No Flow detected → contents = original Uint8Array (zero-copy), wasStripped = false
// - Flow detected    → contents = stripped string (with inline map if enabled), wasStripped = true
const { contents, wasStripped } = maybeStripFlow(rawBytes, { url, sourceMap: enableSourceMaps });
```

When `wasStripped` is `true`, the plugin logs an info event for observability.

**Source map activation.** Both plugins read `build.initialOptions.sourcemap` to decide whether to request a source map:

```typescript
const enableSourceMaps = !!build.initialOptions.sourcemap;
```

This means Flow source maps are only generated when the user's build configuration has source maps enabled (e.g., `sourcemap: true` or `sourcemap: "inline"`). When source maps are disabled (the default: `sourcemap: false`), the `sourceMap` option is `false` and no map is generated — zero additional overhead.

> **Ordering with JSX detection.** Flow stripping runs *before* loader inference. The stripped content (clean JavaScript) is then passed to `inferLoader()`, which may upgrade the loader from `ts` to `tsx` if JSX is detected. This ordering matters: Flow type annotations could theoretically mask or disrupt JSX pattern detection, so stripping first ensures accurate JSX detection. See [Scenario 18 — JSX in `.js` Files](scenarios/18-jsx-in-js-files.md) for JSX detection details.

> **Overhead for non-Flow builds.** If no Flow files are encountered during a build, the only cost is the `containsFlow()` check on each loaded file — a fast regex test against the first 4 KB. The `flow-remove-types` package is never imported, and no source transformation occurs. The cost is O(n) in the number of files, with a very small constant per file.


### Deviations from Standard Flow Handling

bundlejs intentionally differs from how the Flow type checker and Metro bundler handle Flow files:

| Aspect | Standard Flow / Metro | bundlejs |
|:-------|:---------------------|:---------|
| **Detection** | Requires `@flow` pragma (files without it are ignored) | Also detects via syntax patterns and known-package list — many React Native files lack pragmas but still contain Flow syntax |
| **Stripping tool** | Babel pipeline (`@babel/plugin-transform-flow-strip-types`) | `flow-remove-types` — lighter weight, zero-config, same parser (hermes) |
| **Scope** | Metro strips *all* `.js` files unconditionally through Babel *regardless* of whether they contain Flow | bundlejs only strips files where Flow is *detected* (`containsFlow()` returns `true`) — opt-in per file |
| **Fallback** | No fallback — Babel either works or fails | Regex fallback for partial stripping when `flow-remove-types` is unavailable |
| **`.flow.js` convention** | Some Flow tools recognize `.flow.js` as a Flow source file suffix | Not currently detected — could be added to the known-patterns list |

**Key deviation — selective vs unconditional stripping.** Metro applies Babel's Flow plugin to *every* `.js` file in its pipeline. bundlejs is selective: it only strips files where `containsFlow()` returns `true`. This is a deliberate efficiency choice — most npm packages do not contain Flow, and running a full parser on every file would add unnecessary latency in a per-request bundling service.

The trade-off: a Flow file with *no* pragma, *no* known-package match, and *no* detectable syntax patterns could slip through unstripped. In practice this gap is very small, because the syntax patterns specifically target the constructs that cause esbuild parse failures — if a file doesn't match any pattern, it likely doesn't contain syntax that would break esbuild either.


### Flow + JSX: Two Content Transformations

React Native packages often contain *both* Flow annotations and JSX syntax in the same `.js` file. bundlejs handles these as **two independent content transformations** that run in sequence during `onLoad`:

```
  Raw content (Uint8Array)
       │
       ▼
  1. maybeStripFlow()      → removes Flow type annotations
       │
       ▼
  2. inferLoader(content)  → detects JSX, upgrades loader ts → tsx if found
       │
       ▼
  esbuild.parse(content, { loader })
```

These are complementary:
- **Flow stripping** (this section) handles *type system annotations* — `import typeof`, `opaque type`, `$Exact<T>`, etc.
- **JSX loader upgrade** ([Scenario 18](scenarios/18-jsx-in-js-files.md)) handles *UI syntax* — `<Component>`, `<div>`, `</>`, etc.

Neither subsumes the other: a file can have Flow without JSX, JSX without Flow, both, or neither. The detection and handling are additive and order-independent (though Flow stripping runs first to give JSX detection clean input).

> **The shared root cause:** Both features exist because the React Native ecosystem ships `.js` files with non-standard syntax that Metro understands but other bundlers don't. They are sister features addressing different facets of the same ecosystem compatibility problem.


## Plugin Shared State

All six plugins share state through a **`Context`** object — a *reactive, hierarchical* data container built on `EventTarget` and `Proxy` (defined in [core/context/context.ts](../core/context/context.ts)).

Every build creates a **`LocalState`** (from [core/types.ts](../core/types.ts)) that all plugins read and write:

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
| **Shared** | Inherited from parent — changes propagate bidirectionally | Manifest cache, version cache, VFS |
| **Isolated** | Created via `withContext()` — child changes don't affect parent | CdnPlugin's `origin` setting |

```typescript
// All plugins share the same caches
const StateContext = new Context<LocalState>({
  filesystem: Context.opaque(await filesystem),
  packageManifests: new Map(),
  versions: new Map(),
  // ...
});

// CdnPlugin gets isolated CDN origin, but shared caches
CdnPlugin(withContext({ origin: host }, StateContext))
```

> **`Context.opaque()`** marks values as *unproxyable* — objects like `Map`, `Set`, `Promise`, and `ArrayBuffer` have methods that break under proxy interception, so they are excluded from reactive wrapping.

**Three accessor functions:**

- `fromContext("key", ctx)` — read a value
- `toContext("key", value, ctx)` — write a value
- `withContext({ key: value }, ctx)` — create a scoped child context


## The Edge Runtime

The HTTP API layer lives in `@bundle/edge` and runs on **[Deno Deploy](https://deno.com/deploy)** — a serverless platform that runs JavaScript/TypeScript at the edge (meaning close to users, in data centers worldwide). It uses the web-standard `Request`/`Response` pattern.

The entry point exports a `fetch` handler (in [edge/mod.ts](../edge/mod.ts)):

```typescript
export default {
  async fetch(req: Request) {
    // parse URL, check cache, run build, compress, respond
  }
}
```

> When run locally with `deno serve -A --watch edge/mod.ts`, Deno picks up this default export and serves it at `http://localhost:8000`.

### Request Lifecycle

Each request flows through these stages:

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

> **Tip:** The `/?file` endpoint returns raw bundled JavaScript — you can import directly from the API:
> ```typescript
> import { something } from "https://deno.bundlejs.com/?q=my-package&file";
> ```


## Caching Architecture

bundlejs uses a **multi-tiered caching** strategy. These tiers determine when you get *near-instant* responses versus cold builds.

```
  Request arrives
       │
       ▼
  ┌──────────────────┐
  │ Redis (Upstash)  │  Tier 1: Edge-level, persists across deploys
  │ TTL: 24h         │  Key: SHA-256(full config + input)
  └────────┬─────────┘
           │ miss
           ▼
  ┌────────────────────┐
  │ Cache API          │  Tier 2: Runtime-level, persists within
  │ "EXTERNAL_FETCHES" │  Deno Deploy isolate (per HTTP fetch)
  └────────┬───────────┘
           │ miss
           ▼
  ┌──────────────────┐
  │ In-memory LRU    │  Tier 3: Process-level, resets on restart
  │ 300 responses    │  Keyed by final URL (after redirects)
  │ 500 redirects    │  Also stores redirect mappings
  └────────┬─────────┘
           │ miss
           ▼
      Network fetch
```

### Tier details

| Tier | Where | Scope | TTL | Key strategy |
|:-----|:------|:------|:----|:-------------|
| **Redis** (Upstash) | `@bundle/edge` | Across deploys | 24h | SHA-256 of full config + input |
| **Cache API** | `@bundle/utils` | Within Deno Deploy isolate | Runtime-managed | Final URL after redirects |
| **LRU** | `@bundle/utils` | Per process | Until restart | Final URL + redirect map |

**Key design decisions:**

- Responses are cached under the **final URL** after redirects — *not* the original request URL. This ensures relative imports resolve correctly and avoids stale redirect targets when CDN aliases like `@latest` change.
- A **redirect map** separately tracks *original → final* URL mappings, so requests to aliased URLs find cached content without re-fetching.
- **Cache control endpoints:** `/delete-cache` (remove specific entry), `/no-cache` (bypass for current request), `/clear-all-cache-123` (admin flush)

### Per-build caches

Within a single build, additional caches live in `LocalState` (not persisted across requests):

- **`packageManifests`** — cached `package.json` data
- **`versions`** — resolved package versions
- **`sideEffectsMatchersCache`** — compiled side-effects glob patterns
- **`failedExtensionChecks`** / **`failedManifestUrls`** — negative caches to avoid retrying known failures


## Compression

After bundling, `@bundle/compress` compresses the output to report accurate **production size** numbers. The `compress()` function (in [compress/compress.ts](../compress/compress.ts)) accepts an array of `Uint8Array` chunks (supporting multi-file output from code splitting) and returns both compressed and uncompressed sizes.

| Algorithm | Implementation | Quality | Notes |
|:----------|:--------------|:--------|:------|
| **gzip** *(default)* | Native `CompressionStream` API | Fixed | Fastest, most compatible, no WASM |
| **brotli** | WASM module | 1–11 | Best compression ratio for web |
| **zstd** | WASM module | 1–11 | Fast decompression, good ratio |
| **lz4** | WASM module | Fixed | Fastest decompression |

> Brotli, zstd, and lz4 WASM modules are **lazily loaded** — only initialized when the chosen algorithm requires them.


## Configuration Reference

The full `BuildConfig` interface (from [core/types.ts](../core/types.ts)):

```typescript
interface BuildConfig {
  // Entry points and CDN
  entryPoints?: string[];                // Default: ["/index.tsx"]
  cdn?: string;                          // Default: "https://unpkg.com"
  alias?: Record<string, string>;        // Package aliases: { "fs": "memfs" }
  polyfill?: boolean;                    // Default: false

  // Registry configuration (for scoped registries / .npmrc support)
  registry?: string | RegistryConfig;    // Default: undefined (npm public registry)
  // Accepts:
  // - A URL string: "https://npm.jsr.io"
  // - Raw .npmrc content: "@jsr:registry=https://npm.jsr.io"
  // - A RegistryConfig object: { registry?: string, scopedRegistries?: Record<string, string> }

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
    platform?: Platform;       // Auto-detected ("deno" | "node" | "browser" | ...)
    version?: string;          // esbuild version (default: "0.27.2")
    wasmModule?: WebAssembly.Module;
    wasmURL?: string;
  };
}
```

The `cdn` option accepts **short names** (`"unpkg"`, `"esm.sh"`, `"esm"`, `"jsr"`, `"jsr.registry"`, `"skypack"`, `"jsdelivr"`, `"deno"`, `"github"`, `"npm"`, `"npm.registry"`) or full URLs. The `"npm"` and `"npm.registry"` schemes activate **registry tarball mode** — see [Registry Tarball Mode](#registry-tarball-mode) for details.

**Export condition resolution** supports 10+ runtime profiles:

- Deno, Bun, Node.js
- Electron (main/renderer)
- React Native
- Cloudflare Workers, Vercel Edge
- …and more

Conditions are computed from the `platform`, `format`, and `resolve` settings.

Compression is configured separately when using the edge API:

```typescript
type CompressConfig =
  | CompressionType                      // "gzip" | "brotli" | "zstd" | "lz4"
  | {
      type?: CompressionType;
      quality?: 1-11;                    // Brotli/zstd only
    };
```


## Using bundlejs as a Building Block

### As a library

Import `@bundle/core` directly for the programmatic API:

```typescript
import { build, transform } from "@bundle/core";

const result = await build({
  entryPoints: ["/index.ts"],
  cdn: "esm.sh",
  esbuild: { format: "esm", minify: true },
});
// result.contents → minified output files
// result.packageSizeArr → per-package install sizes
```

### With a custom VFS

Pre-populate the virtual filesystem before building:

```typescript
import { build, useFileSystem, setFile } from "@bundle/core";

const fs = useFileSystem();
const fsInstance = await fs;
await setFile(fsInstance, "/index.ts", `export { useState } from "react";`);

const result = await build({ entryPoints: ["/index.ts"] }, fs);
```

### With incremental builds

`context()` creates a persistent build context — repeated builds skip cold starts:

```typescript
import { context } from "@bundle/core";

const ctx = await context({ entryPoints: ["/index.ts"] });
const result1 = await ctx.rebuild();  // First build
// ... modify VFS ...
const result2 = await ctx.rebuild();  // Incremental, faster
ctx.dispose();                        // Clean up when done
```

### In CI pipelines

```sh
# Check bundle size of a package
curl "https://deno.bundlejs.com/?q=@tanstack/react-query&treeshake=[{useQuery}]"

# Get a badge for your README
# https://deno.bundlejs.com/?q=my-package&badge
```

### As an importable bundle

The `/?file` endpoint returns raw bundled JavaScript:

```typescript
import { something } from "https://deno.bundlejs.com/?q=my-package&file";
```

### Event system

The event system (in [core/configs/events.ts](../core/configs/events.ts)) uses the web-standard `EventTarget` API for lifecycle hooks. Events are namespaced with `bundlejs.` prefix:

| Event | When |
|:------|:-----|
| `bundlejs.init.start` | esbuild WASM initialization begins |
| `bundlejs.init.complete` | esbuild ready |
| `bundlejs.init.error` | Initialization failed |
| `bundlejs.build.error` | Build failed |
| `bundlejs.logger.*` | Info/warn/error logging |


## Limitations, Trade-offs, and Gotchas

| Limitation | Details | Why it's reasonable |
|:-----------|:--------|:--------------------|
| **WASM esbuild is slower** | ~2–5× slower than native Go binary. | Acceptable for infrequent size checks; too slow for build-on-save workflows. The portability trade-off (runs everywhere JS runs) is the core design choice. |
| **CDN dependency** | If unpkg.com goes down, resolution fails. | Configurable CDN origin mitigates this (`cdn: "esm.sh"`), but there is *no automatic failover* between CDNs. |
| **Extension probing = many HTTP requests** | Up to 18 URL probes per extensionless import. | HTTP/2 multiplexing and `failedExtensionChecks` caching help. This is a necessary deviation from Node.js (which does not probe) because many CDN-served packages were built for bundlers that do. |
| **No git/workspace/link deps** | `git+https://`, `workspace:*`, `link:../path` all produce explicit errors. | These require local filesystem or git — neither exists in a CDN/edge environment. `file:` specs can use `vfs:`/`virtual:` equivalents instead (see [VFS plugin](#4-virtualfilesystemplugin--in-memory-file-layer)). |
| **Browser field inconsistency** | The dual-form `browser` field is one of npm's most inconsistent conventions. | bundlejs follows the Node.js spec and esbuild's behavior — some packages that "work" in webpack may resolve differently. The [Legacy Resolution](#legacy-resolution--packages-without-exports) section details the exact semantics. |
| **No dynamic import resolution** | Static `import("react")` works (esbuild handles code splitting), but `import(someVariable)` cannot be resolved. | This is an esbuild limitation, not bundlejs-specific. No bundler can resolve truly dynamic specifiers at build time. |
| **Tarball routing is extension-based** | The TarballPlugin intercepts any URL or VFS path whose pathname contains a tarball extension (`.tgz`, `.tar.gz`, `.tar.zst`, etc.), plus CDN-style origins like `pkg.pr.new`. Detection is delegated to `archive-detect`'s `detectArchiveFromPathHint()`. | This means any tarball from any origin is automatically recognized — npm registry, GitHub releases, custom servers, local VFS paths. No per-origin configuration needed. |
| **Tarball decompression** | Only gzip and uncompressed tars are extracted; zstd/xz/bzip2/lz4 are detected but produce errors. | npm tarballs are 100% gzip. The detection layer is intentionally broader than the extraction layer, making future format support straightforward. |
| **`"module"` condition is non-standard** | bundlejs (via esbuild) injects `"module"` as a condition, which Node.js does not recognize. | Matches webpack, Rollup, and esbuild behavior. Without it, many ESM-exporting packages would not resolve correctly. |
| **Env vars for full functionality** | `UPSTASH_URL`/`UPSTASH_TOKEN` (Redis), `GITHUB_AUTH_TOKEN` (gist links). | Without them, the API works but features degrade gracefully — no persistent cache, no gist support. |
| **Registry mode downloads full tarballs** | `cdn: "npm"` downloads the entire package `.tgz` for every dependency — even if only one file is needed. | The tarball is cached (content-addressed SHA-256) so each package is only fetched once per build. For packages with many internal imports (lodash-es, @aws-sdk/*), this is actually *faster* than hundreds of individual CDN requests. |
| **Scoped package `%2f` encoding** | npm’s registry API requires `@scope%2fname` encoding in URL paths for scoped packages. Some HTTP infrastructure (proxies, CDNs) decodes `%2f` before routing, breaking version-specific endpoints. | `getPackageOfVersion()` uses a full-packument fallback when the version endpoint fails for scoped packages. The CdnPlugin’s NPM_CDN branch uses CDN-native URLs instead of registry API URLs for scoped package manifest fetches. |
| **`.npmrc` parsing is registry-only** | Only `registry=` and `@scope:registry=` directives are extracted. Auth tokens, proxy settings, and other npm config are intentionally ignored. | Security boundary — auth tokens should never be exposed in a web-facing bundler. The `.npmrc` format is only used for registry routing, not authentication. |


## What to Do Next

1. **Run the edge API locally.** `deno serve -A --watch edge/mod.ts` — get a working instance, hit it with `/?q=preact`, inspect the JSON response.

2. **Try tree-shaking.** Compare `/?q=lodash-es` vs `/?q=lodash-es&treeshake=[{debounce}]` to see real tree-shaking in action.

3. **Read the plugin pipeline.** Start at [core/build.ts](../core/build.ts) where the plugins are registered, then read each plugin's `onResolve` and `onLoad` handlers in order.

4. **Trace a real resolution.** Pick a package you know well and manually walk through the CdnPlugin's `onResolve` handler: `parsePackageName` → `getCDNUrl` → `resolveModern`/`resolveLegacy` → final URL.

5. **Explore CDN options.** Try `/?q=react&config={"cdn":"esm.sh"}` vs `/?q=react&config={"cdn":"jsdelivr"}` and compare size results.

6. **Understand the Context system.** Read [core/context/context.ts](../core/context/context.ts). The `withContext()` method and shared-vs-isolated data model explain how plugins share caches while keeping independent configuration.

7. **Embed it.** Import from `@bundle/core` directly and build something — a size checker in CI, a REPL, a custom analysis tool. The programmatic API is the same one the edge function uses.

8. **Experiment with compression.** Try different algorithms and quality levels. Compare brotli-11 vs gzip for various packages to understand the size/speed tradeoff.

9. **Test tarball resolution.** Use `pkg.pr.new` to get a tarball URL for a real package, or try an npm registry tarball URL (`https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz`), or place a `.tgz` file in the VFS — all three paths are handled by the TarballPlugin.

10. **Try registry mode.** Compare CDN mode vs registry mode: `/?q=lodash-es&config={"cdn":"unpkg"}` vs `/?q=lodash-es&config={"cdn":"npm.registry"}`. Registry mode downloads the tarball in one shot instead of fetching individual files.

11. **Try scoped registries.** Configure `.npmrc`-style scoped registries: `/?q=@jsr/std__path&config={"cdn":"npm.registry","registry":{"scopedRegistries":{"@jsr":"https://npm.jsr.io"}}}` routes `@jsr` packages through JSR while everything else goes through the default npm registry.

12. **Read the esbuild docs.** bundlejs inherits all of esbuild's configuration options. Understanding `target`, `format`, `platform`, `external`, and `conditions` will help you understand what bundlejs passes through vs. what it intercepts.

