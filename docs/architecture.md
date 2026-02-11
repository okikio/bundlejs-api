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
  VirtualFileSystemPlugin(StateContext),  // 3. In-memory files
  TarballPlugin(StateContext),            // 4. Tarball URL extraction
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
VFSPlugin        Is "react" in the virtual filesystem?        ── NO ──▶ pass
   │                (no "." or "/" prefix — skip bare imports)
   ▼
TarballPlugin    Is "react" a tarball URL?                    ── NO ──▶ pass
   │
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

### 3. VirtualFileSystemPlugin — *In-memory file layer*

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

---

### 4. TarballPlugin — *Extract packages from `.tgz` archives*

> **Source:** [core/plugins/tar.ts](../core/plugins/tar.ts)

Handles tarball-based package sources, primarily from **[pkg.pr.new](https://pkg.pr.new)** (a service that builds npm packages from pull requests and serves them as tarballs).

- Detects tarball URLs → fetches archive → extracts into VFS under `/__tarballs__/<sha256-hash>/`
- Reads the extracted `package.json` → resolves entry point via `exports` or legacy fields
- **Content-addressed caching** (SHA-256 hash of the URL) ensures the same tarball is fetched only once per build
- Handles **self-reference imports** — when code *inside* a tarball imports its own package name, resolves against the tarball's manifest instead of fetching from CDN

---

### 5. HttpPlugin — *Fetch and resolve HTTP/HTTPS URLs*

> **Source:** [core/plugins/http.ts](../core/plugins/http.ts)

The workhorse for all HTTP/HTTPS resolution and loading. Serves **three roles**:

1. **Direct URL imports** — handles `import "https://esm.sh/react"` directly
2. **Relative import resolution** — resolves paths like `"./jsx-runtime.js"` inside CDN-fetched modules against the **final URL** after redirects (critical because CDNs redirect `react@latest` → `react@19.0.0`)
3. **Extension probing** — when a relative import has no extension, tries **18 combinations**:

```
  2 path variants ("", "/index")
  × 9 extensions (.js, .mjs, .ts, .tsx, .cjs, .jsx, .mts, .cts, "")
  = 18 total probes
```

Also scans fetched source for `new URL("...", import.meta.url)` patterns to discover **WASM files** and **web workers** that need fetching alongside the module.

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


## How Resolution Works

The resolution system must faithfully implement the **Node.js module resolution algorithm** — the set of rules Node.js uses to find the actual file behind an `import` statement — but against *CDN-hosted packages* instead of a local `node_modules` directory.

> **Node.js module resolution**, in brief: when you write `import "react"`, Node.js searches `node_modules/react/`, reads its `package.json`, follows the `exports` field (or falls back to `main`/`module`/`browser`), and returns the resolved file path. bundlejs does exactly this, but over HTTP against a CDN.

The resolution system handles the full spectrum:

- **Modern** `exports`/`imports` fields with conditional exports and subpath patterns
- **Legacy** `main`/`module`/`browser` fallbacks
- **Wildcard** subpath patterns (`"./features/*"`)
- **Browser field** remappings (both string and object forms)

bundlejs supports multiple **CDN** (Content Delivery Network) patterns, each with its own URL format (from [core/utils/cdn-format.ts](../core/utils/cdn-format.ts)):

| Config value | CDN URL | Style |
|:------------|:--------|:------|
| `"unpkg"` (default) | `https://unpkg.com` | npm |
| `"esm.sh"` or `"esm"` | `https://esm.sh` | npm |
| `"skypack"` | `https://cdn.skypack.dev` | npm |
| `"jsdelivr"` | `https://cdn.jsdelivr.net/npm` | npm |
| `"jsr"` | `https://jsr.io` | jsr |
| `"deno"` | `https://deno.land/x` | deno |
| `"github"` | `https://raw.githubusercontent.com` | github |
| Any full URL | Used directly | Detected from URL |

### Modern Resolution (exports field)

The modern path uses the `exports` field from `package.json`, following the [Node.js conditional exports spec](https://nodejs.org/api/packages.html#conditional-exports). The `exports` field maps subpaths to files under different **conditions** — a way for packages to serve different code for different environments:

```json
{
  "exports": {
    ".": {
      "browser": "./dist/browser.js",
      "import": "./dist/esm.js",
      "require": "./dist/cjs.js",
      "default": "./dist/esm.js"
    },
    "./utils": "./dist/utils.js",
    "./features/*": "./dist/features/*.js"
  }
}
```

The resolver walks conditions in **priority order**. For bundlejs targeting browsers with ESM:

```
  Condition priority: browser → import → default
  Fallback:           require  (some packages only define CJS exports)
```

**Subpath patterns** with `*` wildcards are fully supported:

- `import "pkg/features/auth"` matches `"./features/*"` in exports
- `"auth"` substitutes into the target → `./dist/features/auth.js`

**Subpath imports** (the `imports` field, prefixed with `#`) work similarly but are *private* to the package — only code *within* the package can use them.

### Legacy Resolution (no exports field)

Activates when a package lacks an `exports` field. Checks, in order:

1. **`browser`** field
2. **`module`** field
3. **`main`** field
4. **`index.js`** fallback

The `browser` field deserves special attention — it has **two forms** with very different semantics:

```
┌─────────────────────────────────────────────────────────────────┐
│ String form: direct entry point replacement                     │
│                                                                 │
│   { "browser": "./dist/browser.js" }                            │
│                                                                 │
│   → Use this directly as the entry point.                       │
├─────────────────────────────────────────────────────────────────┤
│ Object form: remapping layer (NOT an entry point)               │
│                                                                 │
│   { "main": "./lib/index.js",                                   │
│     "browser": {                                                │
│       "./lib/node-impl.js": "./lib/browser-impl.js",            │
│       "fs": false                                               │
│     }                                                           │
│   }                                                             │
│                                                                 │
│   → Entry still comes from "main" or "module".                  │
│   → Object maps are applied as the bundler resolves             │
│     imports within the package.                                 │
│   → Setting a value to `false` excludes the module entirely     │
│     in browser builds.                                          │
└─────────────────────────────────────────────────────────────────┘
```

> **⚠️ This distinction matters.** Many packages use the browser field incorrectly, and different bundlers interpret edge cases differently. bundlejs follows the Node.js spec.

### Side Effects

**Tree-shaking** (removing unused code) requires knowing which modules execute code on import — like a polyfill that sets `window.polyfill = true`. bundlejs reads the `sideEffects` field from `package.json` (via [core/utils/side-effects.ts](../core/utils/side-effects.ts)):

| `sideEffects` value | Meaning |
|:----|:----|
| `false` | Entire package is side-effect-free. Safe to tree-shake. |
| `["*.css", "./src/init.js"]` | Only listed files have side effects. Everything else is safe. |
| Not present | Assume everything has side effects (conservative). |

Glob patterns like `*.css` are normalized to `**/*.css` to match anywhere in the package tree. Compiled matchers are cached per package via `sideEffectsMatchersCache` in `LocalState`. The computed `sideEffects` value is passed to esbuild via the `onResolve` return value, enabling accurate tree-shaking even for CDN-fetched packages.


## Resolution Scenarios

Abstract rules are easier to understand through concrete examples. Here are seven scenarios that exercise different paths through the resolution system.

---

**Scenario 1 — Simple bare import**

> `import { useState } from "react"`

| Step | Plugin | Decision |
|:-----|:-------|:---------|
| 1 | AliasPlugin | No alias → pass |
| 2 | ExternalPlugin | Not a builtin → pass |
| 3 | VFSPlugin | Not a path → pass |
| 4 | TarballPlugin | Not a URL → pass |
| 5 | HttpPlugin | Not a URL → pass |
| 6 | **CdnPlugin** | **Bare import → handle it** |

CdnPlugin parses `"react"` → assumes `"latest"` → resolves exact version (`19.0.0`) → fetches `https://unpkg.com/react@19.0.0/package.json` → resolves entry via `exports["."]` → returns `https://unpkg.com/react@19.0.0/index.js` in `http-url` namespace.

---

**Scenario 2 — Scoped package with subpath**

> `import { QueryClient } from "@tanstack/react-query/build/modern"`

- CdnPlugin parses: name = `@tanstack/react-query`, subpath = `./build/modern`
- Resolves version → fetches `package.json` → looks up `"./build/modern"` in `exports` field
- Modern resolver finds a matching pattern → returns the appropriate CDN URL

---

**Scenario 3 — Tarball from PR preview**

> `"@tanstack/react-query": "https://pkg.pr.new/@tanstack/react-query@7988"`

1. CdnPlugin parses the version as a **URL spec** → re-enters plugin chain via `build.resolve()`
2. **TarballPlugin** intercepts the `pkg.pr.new` URL
3. Fetches tarball → extracts into VFS under `/__tarballs__/<sha256-hash>/`
4. Reads extracted `package.json` → resolves entry point → returns VFS path
5. Subsequent relative imports (e.g., `"./query-client"`) resolve against the VFS mount point

---

**Scenario 4 — Relative import inside CDN module**

> `https://esm.sh/react@18.2.0/index.js` contains `import { createElement } from "./jsx-runtime.js"`

The HttpPlugin resolves the relative path against the parent's **final URL** after redirects — *not* the originally-requested URL. CDNs frequently redirect (e.g., `react@18.2.0/index.js` → `react@18.2.0/es2022/index.js`). The plugin stores the redirected URL in `pluginData.url` and uses it as the resolution base.

---

**Scenario 5 — Node.js builtin ± polyfill**

> `import { readFile } from "fs"`

| Polyfill setting | What happens |
|:-----------------|:-------------|
| `polyfill: true` | ExternalPlugin recognizes `"fs"` as builtin → rewrites to `"memfs"` → CdnPlugin resolves from CDN |
| `polyfill: false` | ExternalPlugin marks `"fs"` as **external** → excluded from bundle → empty `export default {}` |

---

**Scenario 6 — Browser field exclusion**

> Package has `"browser": { "./dist/server-stream.js": false }`

- CdnPlugin resolves entry normally from `main`/`module`
- When esbuild encounters `import { stream } from "./server-stream.js"`, the browser remapping returns an **empty module**
- Server-only code is excluded from the browser bundle

---

**Scenario 7 — Subpath wildcard**

> `import { Button } from "@ui-lib/components/button"`

- CdnPlugin parses subpath: `"./button"`
- Matches `exports` pattern `"./*"` → captures `"button"`
- Substitutes into target `"./dist/esm/*.js"` → `./dist/esm/button.js`
- Returns `https://unpkg.com/@ui-lib/components@latest/dist/esm/button.js`


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

The `cdn` option accepts **short names** (`"unpkg"`, `"esm.sh"`, `"esm"`, `"jsr"`, `"skypack"`, `"jsdelivr"`, `"deno"`, `"github"`) or full URLs.

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

| Limitation | Details |
|:-----------|:--------|
| **WASM esbuild is slower** | ~2–5× slower than native Go binary. Acceptable for infrequent size checks; too slow for build-on-save workflows. |
| **CDN dependency** | If unpkg.com goes down, resolution fails. Configurable CDN origin mitigates this, but there is *no automatic failover*. |
| **Extension probing = many HTTP requests** | Up to 18 URL probes per extensionless import. HTTP/2 multiplexing and `failedExtensionChecks` caching help, but deep trees can be slow. |
| **No git/workspace/link deps** | `git+https://`, `workspace:*`, `link:../path`, `file:./local.tgz` all produce explicit errors. Only npm/URL/JSR specs. |
| **Browser field inconsistency** | The dual-form `browser` field is one of npm's most inconsistent conventions. bundlejs follows the Node.js spec — some packages that "work" in webpack may resolve differently. |
| **No dynamic import resolution** | Static `import("react")` works (esbuild handles code splitting), but `import(someVariable)` cannot be resolved. |
| **Tarball support is limited** | Only `pkg.pr.new`-style URLs trigger extraction. Arbitrary `.tgz` URLs are not auto-detected. |
| **Env vars for full functionality** | `UPSTASH_URL`/`UPSTASH_TOKEN` (Redis), `GITHUB_AUTH_TOKEN` (gist links). Without them, the API works but features degrade gracefully. |


## What to Do Next

1. **Run the edge API locally.** `deno serve -A --watch edge/mod.ts` — get a working instance, hit it with `/?q=preact`, inspect the JSON response.

2. **Try tree-shaking.** Compare `/?q=lodash-es` vs `/?q=lodash-es&treeshake=[{debounce}]` to see real tree-shaking in action.

3. **Read the plugin pipeline.** Start at [core/build.ts](../core/build.ts) where the plugins are registered, then read each plugin's `onResolve` and `onLoad` handlers in order.

4. **Trace a real resolution.** Pick a package you know well and manually walk through the CdnPlugin's `onResolve` handler: `parsePackageName` → `getCDNUrl` → `resolveModern`/`resolveLegacy` → final URL.

5. **Explore CDN options.** Try `/?q=react&config={"cdn":"esm.sh"}` vs `/?q=react&config={"cdn":"jsdelivr"}` and compare size results.

6. **Understand the Context system.** Read [core/context/context.ts](../core/context/context.ts). The `withContext()` method and shared-vs-isolated data model explain how plugins share caches while keeping independent configuration.

7. **Embed it.** Import from `@bundle/core` directly and build something — a size checker in CI, a REPL, a custom analysis tool. The programmatic API is the same one the edge function uses.

8. **Experiment with compression.** Try different algorithms and quality levels. Compare brotli-11 vs gzip for various packages to understand the size/speed tradeoff.

9. **Test tarball resolution.** Use `pkg.pr.new` to get a tarball URL for a real package, then trace through the TarballPlugin's extraction and mounting.

10. **Read the esbuild docs.** bundlejs inherits all of esbuild's configuration options. Understanding `target`, `format`, `platform`, `external`, and `conditions` will help you understand what bundlejs passes through vs. what it intercepts.

