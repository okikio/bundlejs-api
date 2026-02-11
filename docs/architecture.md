# bundlejs: Architecture & Usage Guide

> Bundle anywhere. Bundle everywhere.

bundlejs is a JavaScript/TypeScript bundling service that runs esbuild entirely in WebAssembly — no native binaries, no filesystem, no local install. You give it package names (or raw code), and it returns minified, tree-shaken bundles with compressed size measurements. It works as an HTTP API deployed on Deno Deploy, as an embeddable library (`@bundle/core`) for any JavaScript runtime, and as the engine behind [bundlejs.com](https://bundlejs.com) for quick package size checks.

The problem it solves: *"How big will this dependency be in my production bundle?"* — answered in seconds, from anywhere, with real esbuild output rather than estimates. Unlike tools that guess sizes from package metadata, bundlejs runs a real bundler. It performs actual tree-shaking, dead code elimination, scope hoisting, and minification, then compresses the result and reports the exact size.

The kinds of developers who reach for it include library authors verifying their package's bundle footprint, teams evaluating dependency costs before adoption, CI pipelines that need automated size checks via API, and anyone building tools that require programmatic bundling without native dependencies.

bundlejs is not a replacement for your local build tool — it is not webpack, Vite, or Rollup. It does not manage `node_modules`, does not install packages to disk, and does not run your code. Everything is fetched over HTTP, held in memory, bundled, measured, and discarded.


## How to Think About bundlejs

At the highest level, bundlejs is an adapter layer that makes esbuild work without a filesystem. esbuild is extremely fast but assumes local files exist on disk. bundlejs intercepts every module resolution and file read that esbuild attempts, redirects them to CDN fetches, tarball extraction, or an in-memory virtual filesystem (VFS), and hands the results back to esbuild as if they were local files. esbuild does the heavy lifting — parsing, linking, tree-shaking, minification, code generation. bundlejs does the plumbing: figuring out where modules live, fetching them, and presenting them to esbuild as if they were local.

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

There is no local filesystem at any stage. Every file — entry points, npm packages, transitive dependencies — lives in an in-memory VFS or is fetched over HTTP from a CDN. The esbuild plugins are the mechanism that makes this possible. bundlejs is essentially *"esbuild, plus a portable module system implemented as plugins and shared resolvers."*

What bundlejs explicitly does not do:

- Install packages to disk (everything is fetched and held in memory)
- Run your code (it only bundles and measures)
- Support git/workspace/link dependency specifiers (only registry, URL, and JSR specs)
- Persist VFS state between requests (each bundle starts with a fresh build context)


## Getting Started

**Prerequisites:** [Deno](https://deno.land/) installed (the project is a Deno workspace).

```sh
git clone https://github.com/okikio/bundlejs-api.git
cd bundlejs-api
deno serve -A --watch edge/mod.ts
```

The API is now running at `http://localhost:8000`. The simplest meaningful invocation is:

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

Three early mistakes to avoid. First, forgetting `UPSTASH_URL` and `UPSTASH_TOKEN` environment variables — Redis caching will silently degrade and every request triggers a fresh build. Second, expecting filesystem imports — bundlejs resolves everything over HTTP, so local `import "./my-file.ts"` only works if that file exists in the VFS. Third, assuming Node.js — this is a Deno project; use `deno` commands, not `npm`/`node`.


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

`@bundle/utils` is the foundation — it has no internal dependencies. It provides the shared substrate: package name parsing ([utils/parse-package-name.ts](../utils/parse-package-name.ts)), npm and JSR spec classification ([utils/npm-spec.ts](../utils/npm-spec.ts), [utils/jsr-spec.ts](../utils/jsr-spec.ts)), export condition computation ([utils/resolve-conditions.ts](../utils/resolve-conditions.ts)), exports/imports field resolution ([utils/resolve-exports-imports.ts](../utils/resolve-exports-imports.ts)), import map resolution ([utils/resolve-import-map.ts](../utils/resolve-import-map.ts)), Node.js builtin catalogs with polyfill mappings ([utils/runtime-builtins.ts](../utils/runtime-builtins.ts)), and a caching HTTP fetch layer ([utils/fetch-and-cache.ts](../utils/fetch-and-cache.ts)).

A deliberate design principle runs through `@bundle/utils`: it wraps Web APIs instead of Node.js APIs. `fetch()` instead of `node:http`. `ReadableStream` / `WritableStream` instead of `node:stream`. `crypto.subtle` instead of `node:crypto`. `CompressionStream` instead of `zlib`. `TextEncoder` / `TextDecoder` instead of `Buffer`. This is strategic — by building on web standards, the same code runs in Deno Deploy, browsers, Cloudflare Workers, and Node.js without platform-specific shims.


## esbuild: The Foundation

Every design decision in bundlejs is shaped by esbuild's architecture, so understanding esbuild is essential to understanding bundlejs.

esbuild is a JavaScript/TypeScript bundler written in Go. It is 10-100x faster than webpack or Rollup because it parses, links, and generates code in parallel, avoids JavaScript-based AST transformations, and uses a single-pass architecture that minimizes memory allocation. It has a three-phase pipeline:

```
┌───────────────┐     ┌────────────────┐     ┌────────────────┐
│ Parse Phase   │────▶│  Bundle Phase  │────▶│   Link Phase   │
│ (read files,  │     │  (resolve      │     │   (generate    │
│  build ASTs)  │     │   imports,     │     │    output,     │
│               │     │   link modules │     │    minify)     │
└───────────────┘     └────────────────┘     └────────────────┘
```

esbuild exposes two APIs. The **Build API** (`esbuild.build()`) takes entry points, resolves imports, and bundles everything into output files — it normally reads from and writes to the filesystem. The **Transform API** (`esbuild.transform()`) takes a single string of code, applies transformations (minify, transpile, etc.), and returns the result without filesystem access.

The plugin system is where bundlejs hooks in. Plugins intercept two operations:

- **`onResolve`** — Called when esbuild encounters an `import` statement. The plugin receives the import path and returns a resolved path (where to find the file) and a namespace (which group of files this belongs to). If a plugin does not handle it, esbuild tries the next plugin.
- **`onLoad`** — Called when esbuild needs to read a file's contents. The plugin receives the resolved path and namespace and returns the source code plus a loader type (JavaScript, TypeScript, CSS, etc.).

**Namespaces** are esbuild's mechanism for routing modules through different handlers. A module's identity is the tuple `(namespace, path)`. Two modules with the same path but different namespaces are treated as distinct. bundlejs uses namespaces to distinguish between VFS files, HTTP-fetched modules, tarball-extracted files, and CDN-resolved packages. Module caching in esbuild is keyed by this `(namespace, path)` tuple, so plugins must return canonical paths — if the same module resolves to different paths on different calls, esbuild fetches and bundles it multiple times.

bundlejs always loads esbuild as WebAssembly. The `getEsbuild()` function in [core/utils/get-esbuild.ts](../core/utils/get-esbuild.ts) has a platform-detection switch commented out — it currently returns `ESBUILD_DENO_WASM` unconditionally, using esbuild v0.27.2. The WASM binary is embedded as an encoded string in [core/wasm.ts](../core/wasm.ts) and decoded at startup, so there is no filesystem or network dependency for loading esbuild itself. This is a deliberate trade-off: WASM esbuild is roughly 2-5x slower than the native Go binary, but it runs everywhere JavaScript runs.

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

At build time, these are augmented with explicit loader mappings and defines (from [core/build.ts](../core/build.ts)):

```typescript
loader: {
  ".png": "file",    // Binary assets handled by esbuild's file loader
  ".jpeg": "file",
  ".ttf": "file",
  ".svg": "text",    // SVG and HTML as text
  ".html": "text",
  ".scss": "css",    // SCSS treated as CSS
},
define: {
  "__NODE__": "false",
  "process.env.NODE_ENV": "\"production\"",
},
write: false,        // Output to memory, not filesystem
outdir: "/",         // Virtual output directory
```

Everything runs in-memory. `write: false` means esbuild produces output files as JavaScript objects rather than writing to disk. The `file` loader for `.png`, `.jpeg`, and `.ttf` tells esbuild to treat those as external binary assets — referenced by URL rather than inlined.


## The Plugin Pipeline

The six esbuild plugins are registered in a specific order in [core/build.ts](../core/build.ts), and this order is load-bearing. esbuild evaluates `onResolve` callbacks in registration order — the first plugin that returns a result wins. Returning `undefined` passes control to the next plugin.

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

Each plugin has one job; complex behavior emerges from their composition.

**AliasPlugin** ([core/plugins/alias.ts](../core/plugins/alias.ts)) runs first because aliases must rewrite the import path before any other plugin tries to resolve it. If the config specifies `{ alias: { "fs": "memfs" } }`, this plugin transforms `import "fs"` to `import "memfs"` so downstream plugins resolve the right package. It also handles npm-style aliases from `package.json` dependencies (e.g., `"react": "npm:preact@10"`). By running first, it ensures all subsequent resolution operates on the intended package name.

**ExternalPlugin** ([core/plugins/external.ts](../core/plugins/external.ts)) runs second to handle Node.js built-in modules before the CDN plugin tries to fetch them from npm. Its behavior depends on the `polyfill` setting: when `polyfill` is `false` (the default), Node.js builtins like `fs` and `path` are marked external and excluded from the bundle with an empty `export default {}`. When `polyfill` is `true`, builtins are rewritten to browser polyfill packages (e.g., `fs` → `memfs`, `path` → `path-browserify`) using mappings from [utils/runtime-builtins.ts](../utils/runtime-builtins.ts), which catalogs ~50 Node.js builtins with their browser alternatives. The rewritten import then falls through to the CdnPlugin for actual resolution.

**VirtualFileSystemPlugin** ([core/plugins/fs.ts](../core/plugins/fs.ts)) runs third and provides the in-memory filesystem layer. This is how the entry point (the code the user provides) and any local files are made available to esbuild. The plugin registers three `onResolve` handlers with carefully scoped filters:

```
┌────────────────────┬─────────────┬──────────────────────────────────┐
│ Filter             │ Namespace   │ Catches                          │
├────────────────────┼─────────────┼──────────────────────────────────┤
│ /^(vfs:|virtual:)/ │ any         │ VFS-prefixed paths from anywhere │
│ /^\//              │ any         │ Absolute paths from anywhere     │
│ /^\.\.?\//         │ VFS only    │ Relative paths from VFS modules  │
└────────────────────┴─────────────┴──────────────────────────────────┘
```

This scoping is deliberate. By limiting relative path handling to VFS-namespace importers, the plugin avoids intercepting relative imports inside HTTP-fetched modules (those belong to HttpPlugin). Bare imports (no `.` or `/` prefix) skip this plugin entirely and fall through to the CDN. Resolution follows esbuild's filesystem pattern: exact path match, then extension probing (`.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json`), then `/index.*` fallback.

**TarballPlugin** ([core/plugins/tar.ts](../core/plugins/tar.ts)) runs fourth and handles tarball-based package sources, primarily from `pkg.pr.new` (a service that builds npm packages from pull requests and serves them as tarballs). When it detects a tarball URL, it fetches the archive, extracts files into the VFS under `/__tarballs__/<hash>/`, reads the extracted `package.json`, and resolves the entry point via `exports` or legacy fields. Content-addressed caching (SHA-256 hash of the URL) ensures the same tarball is only fetched once per build, even if multiple imports reference it. The plugin also handles self-reference imports — when code inside an extracted tarball imports its own package name, it resolves against the tarball's manifest instead of fetching from a CDN.

**HttpPlugin** ([core/plugins/http.ts](../core/plugins/http.ts)) runs fifth and is the workhorse for all HTTP/HTTPS URL resolution and loading. It serves three roles: handling direct URL imports (like `import "https://esm.sh/react"`), resolving relative imports inside CDN-fetched modules against the **final URL** after redirects (critical because CDNs frequently redirect `react@latest` to `react@19.0.0`), and performing extension probing when a relative import has no extension. The probing tries two path variants (`""`, `"/index"`) crossed with nine extensions (`.js`, `.mjs`, `.ts`, `.tsx`, `.cjs`, `.jsx`, `.mts`, `.cts`, `""`), making 18 total combinations. The plugin also scans fetched source for `new URL("...", import.meta.url)` patterns to discover WASM files and web workers that need fetching alongside the module.

**CdnPlugin** ([core/plugins/cdn.ts](../core/plugins/cdn.ts)) runs last as the catch-all for bare npm imports. By this point every other strategy has had a chance. This plugin performs the heaviest resolution work — parsing the package specifier, fetching `package.json` from the configured CDN, resolving the entry point through conditional exports or legacy fields, computing side effects metadata, and constructing the final CDN URL. It also handles JSR specifiers (`jsr:@scope/name`), npm aliases (`npm:pkg@version`), and subpath imports (`#internal/...`). The full resolution algorithm is detailed in the next section.


## How Resolution Works

The resolution system must faithfully implement the Node.js module resolution algorithm, but against CDN-hosted packages instead of a local `node_modules` directory. It handles the full spectrum: modern `exports`/`imports` fields, legacy `main`/`module`/`browser` fallbacks, subpath patterns with wildcards, and browser field remappings.

bundlejs supports multiple CDN patterns, each with its own URL format (from [core/utils/cdn-format.ts](../core/utils/cdn-format.ts)):

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

The **modern resolution path** uses the `exports` field from `package.json`, following the Node.js conditional exports specification. A package's `exports` field maps subpaths to files under different conditions:

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

The resolver walks the conditions in priority order. For bundlejs targeting browsers with ESM, the typical condition chain is `browser → import → default`. If ESM conditions fail, the resolver falls back to `require` conditions, because some packages only define CJS exports. Subpath patterns with `*` wildcards are fully supported — `import "pkg/features/auth"` matches `"./features/*"` and substitutes `"auth"` into the target to produce `./dist/features/auth.js`. Subpath imports (the `imports` field, prefixed with `#`) work similarly but are private to the package — only code within the package can use them.

The **legacy resolution path** activates when a package lacks an `exports` field. It checks: `browser` field → `module` field → `main` field → `index.js` fallback. The `browser` field deserves special attention because it has two forms with very different semantics:

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

This distinction is critical — many packages use the browser field incorrectly, and different bundlers interpret edge cases differently. bundlejs follows the Node.js spec.

**Side effects** computation rounds out the resolution picture. Tree-shaking requires knowing which modules execute code on import (like `window.polyfill = true`). bundlejs reads the `sideEffects` field from `package.json` (from [core/utils/side-effects.ts](../core/utils/side-effects.ts)):

| `sideEffects` value | Meaning |
|:----|:----|
| `false` | Entire package is side-effect-free. Safe to tree-shake. |
| `["*.css", "./src/init.js"]` | Only listed files have side effects. Everything else is safe. |
| Not present | Assume everything has side effects (conservative). |

Glob patterns like `*.css` are normalized to `**/*.css` to match anywhere in the package tree. Compiled matchers are cached per package via `sideEffectsMatchersCache` in `LocalState`. The computed `sideEffects` value is passed to esbuild via the `onResolve` return value, enabling accurate tree-shaking even for CDN-fetched packages.


## Resolution Scenarios

Abstract rules are easier to understand through concrete examples. Here are seven scenarios that exercise different paths through the resolution system.

**Scenario 1 — Simple bare import.** `import { useState } from "react"` passes through AliasPlugin (no alias), ExternalPlugin (not a builtin), VFSPlugin (not a path), TarballPlugin (not a URL), HttpPlugin (not a URL), and lands in CdnPlugin. The plugin parses the package name, finds no version specified, assumes `"latest"`, resolves the exact version via the npm registry (e.g., `"19.0.0"`), fetches `https://unpkg.com/react@19.0.0/package.json`, resolves the entry point through `exports["."]`, and returns `https://unpkg.com/react@19.0.0/index.js` in the `http-url` namespace.

**Scenario 2 — Scoped package with subpath export.** `import { QueryClient } from "@tanstack/react-query/build/modern"` hits the CdnPlugin, which parses out the name `@tanstack/react-query`, the subpath `/build/modern`, resolves the version, fetches `package.json`, and resolves `"./build/modern"` against the `exports` field. The modern resolver finds a matching pattern and returns the appropriate CDN URL.

**Scenario 3 — Tarball from a pull request preview.** When `package.json` declares a dependency like `"@tanstack/react-query": "https://pkg.pr.new/@tanstack/react-query@7988"`, the CdnPlugin parses the version as a URL spec and re-enters the plugin chain via `build.resolve()`. The TarballPlugin intercepts the `pkg.pr.new` URL, fetches and extracts the tarball into the VFS under `/__tarballs__/<sha256-hash>/`, reads the extracted `package.json`, resolves the entry point, and returns a VFS path. Subsequent imports from within the package resolve against the VFS mount point, so relative imports like `"./query-client"` work correctly.

**Scenario 4 — Relative import inside a CDN-fetched module.** When `https://esm.sh/react@18.2.0/index.js` contains `import { createElement } from "./jsx-runtime.js"`, the HttpPlugin resolves the relative path against the parent's **final URL** (after redirects). CDNs like esm.sh may redirect `react@18.2.0/index.js` to `react@18.2.0/es2022/index.js`. The relative import must resolve against where the file actually lives, not where it was originally requested. The HttpPlugin stores the redirected URL in `pluginData.url` and uses it as the resolution base.

**Scenario 5 — Node.js builtin with polyfill enabled.** `import { readFile } from "fs"` with `{ polyfill: true }` reaches the ExternalPlugin, which recognizes `"fs"` as a Node.js builtin, looks up its browser polyfill (`"memfs"`), rewrites the import, and delegates to the CdnPlugin. The CdnPlugin resolves `"memfs"` from the CDN normally. With `polyfill: false`, the ExternalPlugin instead marks `"fs"` as external, excluding it from the bundle entirely and returning an empty `export default {}`.

**Scenario 6 — Package with browser field exclusion.** When a package has `"browser": { "./dist/server-stream.js": false }`, the CdnPlugin resolves the entry point normally from `main` or `module`. But when esbuild processes the entry and encounters `import { stream } from "./server-stream.js"`, the browser remapping kicks in and returns an empty module, effectively excluding the server-only code from the browser bundle.

**Scenario 7 — Subpath export with wildcard.** `import { Button } from "@ui-lib/components/button"` hits the CdnPlugin, which parses the subpath `"./button"`, matches it against the `exports` pattern `"./*"`, captures `"button"`, substitutes into the target `"./dist/esm/*.js"`, and returns `https://unpkg.com/@ui-lib/components@latest/dist/esm/button.js`.


## Plugin Shared State

All six plugins share state through a `Context` object — a reactive, hierarchical data container built on `EventTarget` and `Proxy` (defined in [core/context/context.ts](../core/context/context.ts)). Every build creates a `LocalState` (defined in [core/types.ts](../core/types.ts)) that all plugins read from and write to:

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

The Context supports two data modes. **Shared data** is inherited from parent contexts — changes propagate bidirectionally, so all plugins share the same manifest cache, version cache, and VFS. **Isolated data** is created via `withContext()` — properties set in a child context don't affect the parent. This is how the CdnPlugin gets its own `origin` setting without polluting the shared state:

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

`Context.opaque()` marks values as "unproxyable" — objects like `Map`, `Set`, `Promise`, and `ArrayBuffer` have methods that break under proxy interception, so they are excluded from the reactive wrapping.

The context is accessed through three functions: `fromContext("key", ctx)` to read, `toContext("key", value, ctx)` to write, and `withContext({ key: value }, ctx)` to create a scoped child.


## The Edge Runtime

The HTTP API layer lives in `@bundle/edge` and runs on Deno Deploy. The entry point exports a `fetch` handler (in [edge/mod.ts](../edge/mod.ts)):

```typescript
export default {
  async fetch(req: Request) {
    // parse URL, check cache, run build, compress, respond
  }
}
```

When run locally with `deno serve -A --watch edge/mod.ts`, Deno picks up this default export and runs it as an HTTP server.

The request lifecycle flows through several stages. First, query parameters are parsed (by [edge/parse-query.ts](../edge/parse-query.ts)) into a build configuration. The `q` parameter supports multiple packages separated by commas (`?q=react,vue`), the `treeshake` parameter uses bracket syntax for per-package exports (`?treeshake=[{useState}],[*]`), the `share` parameter accepts LZ-string compressed code for large inputs, and the `config` parameter accepts a JSON5 configuration object. Next, the edge function checks Redis (Upstash) for a cached result keyed by the SHA-256 hash of the full configuration. On cache hit, it returns immediately. On cache miss, it writes the user's code to the VFS as an entry point, invokes `@bundle/core`'s `build()`, compresses the output via `@bundle/compress`, assembles the JSON response, caches it, and returns.

The API supports multiple response modes depending on query parameters:

| Query | Result |
|:------|:-------|
| `/?q=react` | JSON with bundle size |
| `/?q=react&treeshake=[{useState}]` | Tree-shaken size for specific exports |
| `/?q=react&badge` | SVG badge image |
| `/?q=react&badge=detailed` | Badge with module names |
| `/?q=react&file` | Raw bundled JavaScript |
| `/?q=react&analysis` | esbuild bundle analysis (HTML) |
| `/?q=react&metafile` | esbuild metafile JSON |
| `/?q=react&polyfill` | Enable Node.js polyfills |
| `/?q=react&minify=false` | Disable minification |
| `/?q=react&format=cjs` | Output as CommonJS |
| `/?q=react&config={...}` | JSON5 config object |

The `/?file` endpoint is noteworthy — it returns the raw bundled JavaScript, which means you can directly import from the bundlejs API: `import { something } from "https://deno.bundlejs.com/?q=my-package&file"`.


## Caching Architecture

bundlejs uses a multi-tiered caching strategy. Understanding these tiers matters because they determine when you get near-instant responses versus cold builds.

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
┌──────────────────┐
│ Cache API        │  Tier 2: Runtime-level, persists within Deno Deploy isolate
│ "EXTERNAL_FETCHES" │  Used by fetch-and-cache.ts for HTTP responses
└────────┬─────────┘
         │ miss
         ▼
┌──────────────────┐
│ In-memory LRU    │  Tier 3: Process-level, resets on restart
│ 300 responses    │  Keyed by final URL (after redirects)
│ 500 redirects    │  Also stores redirect mappings for aliased URLs
└────────┬─────────┘
         │ miss
         ▼
      Network fetch
```

The first tier is Redis (Upstash), used in `@bundle/edge` to cache complete API responses. Results are keyed by the SHA-256 hash of the full configuration plus input, with a 24-hour TTL. Badge images are cached separately. Cache control endpoints include `/delete-cache` to remove a specific entry, `/no-cache` to bypass cache for the current request, and `/clear-all-cache-123` for administrative cache flush.

The second and third tiers live in `@bundle/utils`'s `fetch-and-cache.ts` module, which handles all HTTP fetching throughout the build pipeline. It maintains an in-memory LRU cache (300 responses, 500 redirect mappings) and optionally uses the Cache API (available on Deno Deploy) as a persistent layer. A key design decision: responses are always cached under the **final** URL after redirects, not the original request URL. This ensures relative imports resolve correctly and avoids stale redirect targets when CDN aliases like `@latest` change. A redirect map separately tracks original-to-final URL mappings so requests to aliased URLs can find cached content without re-fetching.

Within a single build, additional per-build caches live in `LocalState`: package manifests, resolved versions, compiled side-effects matchers, and failed extension probes. These are local to each build context and do not persist.


## Compression

After bundling, `@bundle/compress` compresses the output to give accurate production size numbers. The `compress()` function (in [compress/compress.ts](../compress/compress.ts)) accepts an array of `Uint8Array` chunks (supporting multi-file output from code splitting) and returns both compressed and uncompressed sizes.

| Algorithm | Implementation | Quality configurable | Notes |
|:----------|:--------------|:----|:-----|
| gzip (default) | Native `CompressionStream` API | No | Fastest, most compatible |
| brotli | WASM module | Yes (1–11) | Best compression ratio for web |
| zstd | WASM module | Yes (1–11) | Fast decompression, good ratio |
| lz4 | WASM module | No | Fastest decompression |

Gzip uses the web-standard `CompressionStream` API available in all modern runtimes — no WASM needed. Brotli, zstd, and lz4 are implemented as WASM modules that are lazily loaded only when the chosen algorithm requires them. Configuration is handled through `createCompressConfig()`, which uses deep merge and `structuredClone` to produce final settings.


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

The `cdn` option accepts short names (`"unpkg"`, `"esm.sh"`, `"esm"`, `"jsr"`, `"skypack"`, `"jsdelivr"`, `"deno"`, `"github"`) or full URLs. Export condition resolution supports 10+ runtime profiles including Deno, Bun, Electron (main/renderer), React Native, Cloudflare Workers, and Vercel Edge — the conditions are computed from the `platform`, `format`, and `resolve` settings.

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

**As a library** — import `@bundle/core` directly and build something with the programmatic API:

```typescript
import { build, transform } from "@bundle/core";

// Bundle in-memory code
const result = await build({
  entryPoints: ["/index.ts"],
  cdn: "esm.sh",
  esbuild: { format: "esm", minify: true },
});
// result.contents → minified output files
// result.packageSizeArr → per-package install sizes
```

**With a custom filesystem** — provide your own VFS for pre-populated files:

```typescript
import { build, useFileSystem, setFile } from "@bundle/core";

const fs = useFileSystem();
const fsInstance = await fs;
await setFile(fsInstance, "/index.ts", `export { useState } from "react";`);

const result = await build({ entryPoints: ["/index.ts"] }, fs);
```

**With incremental builds** — `context()` creates a persistent build context for repeated builds without cold starts:

```typescript
import { context } from "@bundle/core";

const ctx = await context({ entryPoints: ["/index.ts"] });
const result1 = await ctx.rebuild();  // First build
// ... modify VFS ...
const result2 = await ctx.rebuild();  // Incremental, faster
ctx.dispose();                        // Clean up when done
```

**In CI pipelines** — use the HTTP API for automated bundle size checks:

```sh
# Check bundle size of a package
curl "https://deno.bundlejs.com/?q=@tanstack/react-query&treeshake=[{useQuery}]"

# Get a badge for your README
# https://deno.bundlejs.com/?q=my-package&badge
```

**As an importable bundle** — the `/?file` endpoint returns raw bundled JavaScript:

```typescript
import { something } from "https://deno.bundlejs.com/?q=my-package&file";
```

The event system (defined in [core/configs/events.ts](../core/configs/events.ts)) uses the web-standard `EventTarget` API for lifecycle hooks. Events are namespaced with `bundlejs.` prefix. Key events include `bundlejs.init.start`, `bundlejs.init.complete`, `bundlejs.init.error`, `bundlejs.build.error`, and `bundlejs.logger.*` for info/warn/error logging. This lets you observe and react to build lifecycle events without monkey-patching.


## Limitations, Trade-offs, and Gotchas

**WASM esbuild is slower than native.** Running esbuild in WebAssembly is roughly 2-5x slower than the native Go binary. This is the fundamental trade-off for universal portability — the same code runs in browsers, edge functions, and server runtimes. For a size-checking tool that runs infrequently, this is acceptable. For a production build tool running on every save, it would be a bottleneck.

**CDN dependency.** bundlejs is only as reliable as its CDN. If unpkg.com goes down, resolution fails. The configurable CDN origin mitigates this — switch to `esm.sh`, `jsdelivr`, or any other CDN — but there is no automatic failover between CDNs.

**Extension probing generates many HTTP requests.** When an import like `"./utils"` has no extension, bundlejs tries up to 18 URL combinations. Each is an HTTP request. CDN-level caching and HTTP/2 multiplexing help, but this can be slow for deeply nested dependency trees with extensionless imports. Failed probes are cached in `failedExtensionChecks` to avoid retrying known failures.

**No git/workspace/link dependencies.** Dependency specs like `git+https://...`, `workspace:*`, `link:../path`, and `file:./local.tgz` produce explicit errors. Only npm registry (semver/tags), URL, and JSR specs are supported (classified by [utils/npm-spec.ts](../utils/npm-spec.ts)).

**Browser field inconsistency across the ecosystem.** The dual-form `browser` field (string vs. object) is one of npm's most inconsistent conventions. Many packages use it incorrectly, and different bundlers interpret edge cases differently. bundlejs follows the Node.js spec, which means some packages that "work" in webpack might resolve differently here.

**No dynamic import resolution.** bundlejs resolves static imports. `import("react")` works (esbuild handles code splitting), but the resolution plugins cannot resolve imports computed at runtime (e.g., `import(someVariable)`).

**Tarball support is limited to known CDN patterns.** Currently, only `pkg.pr.new`-style URLs trigger tarball extraction. Arbitrary `.tgz` URLs are not automatically detected — the TarballPlugin checks against known tarball CDN patterns via `getCDNStyle()`.

**Environment variables for full functionality.** Redis caching requires `UPSTASH_URL` and `UPSTASH_TOKEN`. GitHub gist storage requires `GITHUB_AUTH_TOKEN`. Without these, the API still works but caching degrades and some features (like shareable gist links) are unavailable. The init is wrapped so Redis can fail without taking the whole server down.


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

---

*This document reflects the state of the `simplify-edge-functions` branch.*
