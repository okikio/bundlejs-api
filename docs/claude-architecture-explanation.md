# bundlejs: The Complete Architecture Guide

> Bundle everywhere and anywhere. A web-based JavaScript/TypeScript bundler built on esbuild that resolves and bundles packages directly from CDNs, in the browser or at the edge.

---

## What This Tool Is (and Why You'd Use It)

bundlejs solves a specific problem: you want to know how big a package will be in your production bundle, or you want to bundle JavaScript without installing anything locally. Every other bundler assumes you have a filesystem, a `node_modules` directory, and a local development environment. bundlejs assumes none of that. It runs esbuild in WebAssembly, fetches packages from CDNs over HTTP, and produces minified, tree-shaken, compressed output anywhere JavaScript runs.

The kinds of problems it solves:

- **Bundle size analysis.** You're evaluating whether to add `lodash-es` or `date-fns` to your project. bundlejs tells you the exact gzipped/brotli size of your specific imports, with tree-shaking, in seconds.
- **Runtime emulation.** You need Node.js-style module resolution in a browser or edge function. bundlejs emulates Node's resolution algorithm — `exports`, `imports`, `browser` field remapping, legacy `main`/`module` fallbacks — on top of CDN-hosted packages.
- **Edge bundling.** You want an API endpoint that accepts a package spec and returns bundled, compressed output. bundlejs runs on Deno Deploy as an edge function (`edge/bundle.ts:15506-15646`).
- **Zero-install experimentation.** You want to prototype with npm packages without `npm install`. bundlejs resolves bare imports like `"react"` to CDN URLs and bundles them in-memory.

bundlejs is a library and edge service, not a CLI. You interact with it through the web UI at bundlejs.com, through the edge API, or by importing its core modules directly.


## The Mental Model: How to Think About bundlejs

At the highest level, bundlejs is an adapter layer that makes esbuild work without a filesystem. esbuild is extremely fast because it's written in Go, but it assumes local files. bundlejs intercepts every module resolution and file read that esbuild attempts, and redirects them to CDN fetches, tarball extraction, or an in-memory virtual filesystem.

```
[ User Input: "export { useState } from 'react'" ]
          |
          v
[ Virtual Filesystem ]  <-- writes entry point to in-memory FS
          |
          v
[ esbuild (WASM) ]
     |         |
     |    (for each import)
     |         |
     v         v
[ Plugin Pipeline ]
     |
     |  1. AliasPlugin ......... package aliasing (fs -> memfs)
     |  2. ExternalPlugin ...... Node.js builtins (mark external or polyfill)
     |  3. VirtualFSPlugin ..... in-memory local files
     |  4. TarballPlugin ....... pkg.pr.new tarball extraction
     |  5. HttpPlugin .......... direct HTTP URL imports
     |  6. CdnPlugin ........... bare imports -> CDN resolution
     |
     v
[ Resolved Module + Source Code ]
     |
     v
[ esbuild bundles, minifies, tree-shakes ]
     |
     v
[ Compression (gzip / brotli / zstd / lz4) ]
     |
     v
[ Output: bundled code + size metrics ]
```

The critical insight: **esbuild does the heavy lifting** (parsing, bundling, minification, tree-shaking, source maps). bundlejs does the plumbing: figuring out where modules live, fetching them, and presenting them to esbuild as if they were local files.

**What bundlejs does NOT do:**

- It does not replace your local build tool. It's not webpack or Vite.
- It does not manage `node_modules`. There is no install step.
- It does not support every esbuild feature. Some features that require filesystem access (like `file` and `copy` loaders for binary assets) aren't applicable.
- It does not cache between separate bundle operations by default. Each build is independent, though HTTP caching reduces redundant fetches.


## esbuild: The Foundation

Before understanding bundlejs, you need to understand esbuild, because every design decision in bundlejs is shaped by esbuild's architecture.

### What esbuild is

esbuild is a JavaScript/TypeScript bundler written in Go. It's 10-100x faster than webpack or Rollup because it:

- Parses, links, and generates code in parallel across CPU cores
- Avoids the overhead of JavaScript-based AST transformations
- Uses a single-pass architecture that minimizes memory allocation

esbuild has a three-phase pipeline:

```
[ Parse Phase ]     Reads source files, builds AST for each
       |
       v
[ Bundle Phase ]    Resolves imports, links modules together
       |
       v
[ Link Phase ]      Generates output files, applies minification
```

### The plugin system

esbuild's plugin system is where bundlejs hooks in. Plugins intercept two operations:

**`onResolve`** — Called when esbuild encounters an import statement. The plugin receives the import path and must return a resolved path (where to find the file) and a namespace (which group of files this belongs to). If a plugin returns `undefined`, esbuild tries the next plugin.

**`onLoad`** — Called when esbuild needs to read a file's contents. The plugin receives the resolved path and namespace from the resolve step, and must return the file's source code and its loader type (JavaScript, TypeScript, CSS, etc.).

**Namespaces** are esbuild's mechanism for routing modules through different handlers. A module's identity is the tuple `(namespace, path)`. Two modules with the same path but different namespaces are treated as distinct. bundlejs uses namespaces to distinguish between VFS files, HTTP-fetched modules, tarball-extracted files, and CDN-resolved packages.

**Module caching** in esbuild is keyed by `(namespace, path)`. This means plugins must return canonical paths — if the same module resolves to different paths on different calls, esbuild will fetch and bundle it multiple times.

### What bundlejs configures

bundlejs initializes esbuild with these defaults (`core/build.ts:18541-18568`):

| Option | Default | Why |
|--------|---------|-----|
| `target` | `esnext` | No downleveling; measure modern output size |
| `format` | `esm` | ES modules are the standard |
| `platform` | `browser` | Primary use case is browser bundles |
| `minify` | `true` | Bundle size analysis needs minified output |
| `treeShaking` | `true` | Measure only what you import |
| `bundle` | `true` | Resolve and inline all dependencies |

These can be overridden through the configuration object. esbuild handles parsing TypeScript natively (no `tsc` needed), performs dead code elimination, generates source maps, and supports code splitting — all at Go-native speed.

bundlejs loads esbuild as WebAssembly in the browser, or uses the native Go binary on Deno/Node (`core/init.ts:16328-16388`). The initialization detects the platform and caches the esbuild instance globally so subsequent builds reuse it.


## The Plugin Pipeline: Where Resolution Happens

The six plugins are registered in a specific order (`core/build.ts:18639-18646`), and this order is load-bearing. Each plugin's `onResolve` handler gets a chance to claim an import. The first plugin to return a result wins; returning `undefined` passes control to the next plugin.

```
import "react"
   |
   AliasPlugin:    Is "react" aliased to something else?     --> NO, pass
   ExternalPlugin: Is "react" a Node.js builtin?             --> NO, pass
   VFSPlugin:      Is "react" in the virtual filesystem?     --> NO, pass
   TarballPlugin:  Is "react" a tarball URL?                  --> NO, pass
   HttpPlugin:     Is "react" an HTTP URL?                    --> NO, pass
   CdnPlugin:      Bare import -> resolve from CDN            --> YES, handle it
```

Here's why each plugin exists and what it handles.


### 1. AliasPlugin (first)

**File:** `core/plugins/alias.ts:10115-10230`

**Purpose:** Redirects one package name to another before any resolution happens.

**Why first:** Aliases must rewrite the import path before any other plugin tries to resolve it. If you've configured `{ alias: { "fs": "memfs" } }`, the AliasPlugin transforms the import to `"memfs"` so downstream plugins resolve the right package.

**What it handles:**
- User-configured package aliases (e.g., `"fs"` → `"memfs"`)
- npm-style aliases from `package.json` dependencies (e.g., `"react": "npm:preact@10"`)

**Example:**
```javascript
// Config: { alias: { "lodash": "lodash-es" } }
import { debounce } from "lodash"
// AliasPlugin rewrites to: import { debounce } from "lodash-es"
// CdnPlugin later resolves "lodash-es" from the CDN
```


### 2. ExternalPlugin (second)

**File:** `core/plugins/external.ts:14391-14616`

**Purpose:** Handles Node.js built-in modules — either marking them external (excluded from bundle) or replacing them with browser polyfills.

**Why second:** Must run before CDN resolution. You don't want the CdnPlugin trying to fetch `"fs"` or `"path"` from npm — these are Node.js builtins that either need polyfilling or explicit exclusion.

**Behavior depends on configuration:**

| `polyfill` setting | What happens to `import "fs"` |
|---|---|
| `true` | Redirected to browser polyfill (e.g., `memfs`) via CDN |
| `false` | Marked as external, excluded from bundle |

The plugin maintains a map of Node.js builtins to their browser-compatible polyfill packages. When polyfilling is enabled, it rewrites the import to the polyfill package name and lets the CdnPlugin handle the actual resolution.


### 3. VirtualFileSystemPlugin (third)

**File:** `core/plugins/fs.ts:14619-14925`

**Purpose:** Resolves imports against an in-memory filesystem. This is how the entry point (the code you type into bundlejs) and any local files are made available to esbuild.

**Why third:** Must run before HTTP/CDN resolution for local files, but after alias and external handling. The VFS should never intercept bare npm imports or HTTP URLs — only paths that look like local files.

**Resolution strategy (`core/plugins/fs.ts:14717-14766`):**

1. Skip anything that starts with a protocol (`http://`, `https://`) — never intercept URLs
2. Strip VFS prefixes if present (`vfs:`, `virtual:`)
3. Skip bare imports (no `.` or `/` prefix) — let CdnPlugin handle those
4. For relative imports: only resolve if the importer is also in the VFS namespace
5. Resolve against `resolveDir`, with extension probing and `/index` fallback

**Handler registration (`core/plugins/fs.ts:14826-14848`):**

The plugin registers three `onResolve` handlers with different filters:

| Filter | Namespace | Catches |
|--------|-----------|---------|
| `/^(vfs:\|virtual:)/` | any | VFS-prefixed paths from anywhere |
| `/^\//` | any | Absolute paths from anywhere |
| `/^\.\.?\//` | VFS only | Relative paths from VFS modules only |

This design ensures that relative imports inside HTTP-fetched modules go to the HttpPlugin (not VFS), while relative imports inside VFS files stay in the VFS.


### 4. TarballPlugin (fourth)

**File:** `core/plugins/tar.ts:16505-17276`

**Purpose:** Handles tarball-based packages, primarily from `pkg.pr.new` (a service that builds npm packages from pull requests and serves them as tarballs).

**Why fourth:** Tarballs are a special case of HTTP resources. They need to be intercepted before the generic HttpPlugin, because a tarball URL like `https://pkg.pr.new/@tanstack/react-query@7988` requires extraction and VFS mounting, not a simple HTTP fetch.

**Algorithm:**

1. Detect tarball URL (matches `pkg.pr.new` and similar CDN patterns)
2. Parse the package spec and subpath from the URL
3. Fetch the tarball, with content-addressed caching (SHA-256 hash of URL)
4. Extract using `UntarStream` to virtual filesystem at `/__tarballs__/<hash>/`
5. Read `package.json` from extracted files
6. Resolve entry point using `exports` field or legacy `main`/`module` fields
7. Mount the package for subsequent imports within the same bundle

**Key feature:** Content-addressed caching means the same tarball URL is only fetched and extracted once per build, even if multiple modules import from it.


### 5. HttpPlugin (fifth)

**File:** `core/plugins/http.ts:18023-18444`

**Purpose:** Fetches modules directly from HTTP/HTTPS URLs and resolves relative imports within fetched modules.

**Why fifth:** This is the general-purpose HTTP handler. By this point, aliases are resolved, builtins are handled, VFS files are checked, and tarballs are extracted. What remains are direct URL imports and the relative imports inside CDN-fetched modules.

**Three responsibilities:**

**A. Direct URL imports** — If you write `import "https://esm.sh/react"`, the HttpPlugin fetches it.

**B. Relative import resolution** — When a CDN-fetched module contains `import "./jsx-runtime.js"`, the HttpPlugin resolves it against the parent module's **final URL** (after any redirects). This is critical: CDNs frequently redirect, and relative paths must resolve against where the file actually lives, not where you originally requested it.

**C. Extension probing (`core/plugins/http.ts:18227-18276`)** — When a relative import has no extension, the HttpPlugin tries multiple combinations:

```
Paths:   "", "/index"
Extensions: "", ".js", ".mjs", ".ts", ".tsx", ".cjs", ".jsx", ".mts", ".cts"
```

That's 18 combinations total. It tries each until one returns a successful HTTP response.

**D. Asset discovery (`core/plugins/http.ts:18156-18195`)** — The HttpPlugin also scans fetched source code for `new URL("...", import.meta.url)` patterns. These typically reference WASM files or web workers that need to be fetched alongside the module.


### 6. CdnPlugin (last)

**File:** `core/plugins/cdn.ts:19242-19891`

**Purpose:** The fallback handler that resolves bare npm imports to CDN URLs. This is where `"react"` becomes `https://unpkg.com/react@18.2.0/index.js`.

**Why last:** Every other resolution strategy gets a chance first. The CdnPlugin is the catch-all for anything that looks like a bare npm package specifier.

**Algorithm:**

1. Parse the package specifier: `@scope/name@version/subpath` (`core/utils/cdn-format.ts:10232-10862`)
2. Handle npm aliases (`npm:pkg@version` → resolve the aliased package)
3. Fetch `package.json` from the configured CDN
4. Resolve the entry point using modern `exports` field OR legacy field fallback
5. Apply `browser` field remappings if present
6. Compute `sideEffects` hint for tree-shaking
7. Return the resolved CDN URL with metadata

This plugin does the heaviest lifting in terms of resolution complexity. It implements the full Node.js package resolution algorithm on top of HTTP-fetched `package.json` files. The resolution details are covered in depth in the next section.


## Resolution Algorithms: How Imports Become URLs

This is the most complex part of bundlejs. The resolution system must faithfully implement the Node.js module resolution algorithm, but against CDN-hosted packages instead of a local `node_modules` directory.

### Supported CDN Styles

bundlejs supports multiple CDN patterns (`core/utils/cdn-format.ts:10232-10862`):

| Style | Example | Used for |
|-------|---------|----------|
| npm | `unpkg.com`, `esm.sh`, `jsdelivr.net`, `skypack.dev` | Standard npm packages |
| jsr | `jsr.io` | JSR registry packages |
| github | `raw.githubusercontent.com` | Raw GitHub files |
| deno | `deno.land/x` | Deno third-party modules |
| tarball | `pkg.pr.new` | PR preview builds |

The CDN style determines URL formatting: how the package name, version, and subpath are encoded into a URL.


### Modern Resolution: `exports` and `imports` Fields

**File:** `core/utils/cdn-resolution.ts:15036-15109`

The modern resolution path uses the `exports` field from `package.json`, following the Node.js conditional exports specification.

```javascript
function resolveModern(manifest, subpath, conditions)
```

A package's `exports` field maps subpaths to files under different conditions:

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

The resolver walks the conditions in priority order. For bundlejs (targeting browsers with ESM), the typical condition chain is:

```
browser → import → default
```

If the ESM conditions fail, the resolver falls back to trying `require` conditions, because some packages only define CJS exports.

**Subpath patterns** are also supported. The wildcard `*` in `"./features/*"` matches any subpath and substitutes into the target. So `import "pkg/features/auth"` resolves to `./dist/features/auth.js`.

**Subpath imports** (the `imports` field with `#` prefix) work similarly:

```json
{
  "imports": {
    "#internal/utils": "./src/internal/utils.js"
  }
}
```

These are private to the package — only code within the package can use `#internal/utils`.


### Legacy Resolution: `main`, `module`, `browser`

**File:** `core/utils/cdn-resolution.ts:15141-15200`

When a package doesn't have an `exports` field, bundlejs falls back to the older resolution fields:

```javascript
function resolveLegacy(manifest, conditions, legacyFields)
```

**Resolution order:**

1. Check `browser` field (if browser conditions are active)
2. Fall back to: `module` → `main` → `index.js`
3. Apply browser field remappings if the `browser` field is an object

**The browser field has two forms, and this distinction is critical:**

**String form** — Direct entry point replacement:
```json
{ "browser": "./dist/browser.js" }
```
Use this as the entry point directly.

**Object form** — Remapping layer:
```json
{
  "main": "./lib/index.js",
  "browser": {
    "./lib/node-impl.js": "./lib/browser-impl.js",
    "fs": false
  }
}
```

The object form does NOT provide an entry point. It provides a mapping of "when code tries to import X, give it Y instead." The entry point still comes from `main` or `module`. Then, as the bundler resolves imports within the package, the browser remappings are applied.

Setting a value to `false` means "exclude this module entirely in browser builds." The resolver returns an empty module.

> **Historical note:** An earlier version of bundlejs incorrectly treated object-form browser field keys as entry points. This was a subtle bug because it would sometimes work (if the first key happened to be the entry point) but would resolve to the wrong file in many packages.


### Side Effects Computation

**File:** `core/utils/side-effects.ts:910-1055`

Tree-shaking requires knowing which modules have side effects (code that runs on import, like `window.polyfill = true`). bundlejs reads the `sideEffects` field from `package.json`:

```javascript
function computeEsbuildSideEffects(manifest, resolvedPkgSubpath)
```

| `sideEffects` value | Meaning |
|---|---|
| `false` | Entire package is side-effect-free. Safe to tree-shake. |
| `["*.css", "./src/init.js"]` | Only these files have side effects. Everything else is safe. |
| Not present | Assume everything has side effects (conservative). |

**Pattern normalization:** Glob patterns like `*.css` are normalized to `**/*.css` to match anywhere in the package tree. Leading `./` is stripped for matching consistency.

This metadata is passed to esbuild via the `sideEffects` return value from `onResolve`, enabling accurate tree-shaking even for CDN-fetched packages.


### Resolution Scenarios

Here are concrete scenarios that exercise different parts of the resolution system.

---

**Scenario 1: Simple bare import**

```javascript
import { useState } from "react"
```

Resolution trace:

```
AliasPlugin:    "react" -- no alias configured           --> pass
ExternalPlugin: "react" -- not a Node.js builtin          --> pass
VFSPlugin:      "react" -- no "." or "/" prefix, skip     --> pass
TarballPlugin:  "react" -- not a tarball URL              --> pass
HttpPlugin:     "react" -- not an HTTP URL                --> pass
CdnPlugin:      "react" -- bare import, handle it!
  1. parsePackageName("react") -> { name: "react", version: "latest" }
  2. Fetch https://unpkg.com/react@latest/package.json
  3. package.json has exports["."]["browser"] -> "./index.js"
  4. Return: https://unpkg.com/react@18.2.0/index.js (HTTP_NAMESPACE)
```

---

**Scenario 2: npm alias with scoped package**

```javascript
import { query } from "npm:@tanstack/react-query@5.0.0"
```

Resolution trace:

```
CdnPlugin detects "npm:" prefix
  1. Strip prefix -> "@tanstack/react-query@5.0.0"
  2. parsePackageName -> { name: "@tanstack/react-query", version: "5.0.0" }
  3. Fetch https://unpkg.com/@tanstack/react-query@5.0.0/package.json
  4. exports["."]["import"] -> "./build/modern/index.js"
  5. Return: https://unpkg.com/@tanstack/react-query@5.0.0/build/modern/index.js
```

---

**Scenario 3: Tarball from pull request preview**

```javascript
import { useQuery } from "https://pkg.pr.new/@tanstack/react-query@7988"
```

Resolution trace:

```
HttpPlugin: HTTP URL detected -> HTTP_NAMESPACE
TarballPlugin intercepts (origin matches pkg.pr.new):
  1. Parse spec -> { name: "@tanstack/react-query", version: "7988" }
  2. Hash URL -> SHA-256 -> "a3f9c2..."
  3. Check cache: /__tarballs__/a3f9c2.../ -- not found
  4. Fetch tarball from https://pkg.pr.new/@tanstack/react-query@7988
  5. Extract via UntarStream to VFS at /__tarballs__/a3f9c2.../package/
  6. Read /__tarballs__/a3f9c2.../package/package.json
  7. Resolve exports["."] -> ./build/modern/index.js
  8. Return: /__tarballs__/a3f9c2.../package/build/modern/index.js (VFS)
```

Subsequent imports within the extracted package resolve against the VFS mount point, so relative imports like `"./query-client"` work correctly.

---

**Scenario 4: Relative import inside a CDN-fetched module**

```javascript
// Inside https://esm.sh/react@18.2.0/index.js:
import { createElement } from "./jsx-runtime.js"
```

Resolution trace:

```
HttpPlugin: Relative import in HTTP_NAMESPACE
  1. Parent URL (after redirects): https://esm.sh/react@18.2.0/es2022/index.js
     (Note: esm.sh may redirect, so the final URL differs from the original)
  2. Resolve "./jsx-runtime.js" against parent's final URL
  3. Result: https://esm.sh/react@18.2.0/es2022/jsx-runtime.js
  4. Fetch content
  5. Return: HTTP_NAMESPACE with resolved URL
```

The "resolve against final URL" behavior is essential. CDNs like esm.sh frequently redirect from `react@18.2.0/index.js` to `react@18.2.0/es2022/index.js`. If relative imports resolved against the *original* URL, the paths would be wrong.

---

**Scenario 5: Node.js builtin with polyfill enabled**

```javascript
import { readFile } from "fs"
```

Config: `{ polyfill: true }`

Resolution trace:

```
AliasPlugin:    "fs" -- no user alias                     --> pass
ExternalPlugin: "fs" -- Node.js builtin detected!
  1. polyfill: true -> look up polyfill map
  2. "fs" maps to "memfs"
  3. Redirect to CdnPlugin with "memfs"
CdnPlugin:
  1. Resolve "memfs" from CDN
  2. Return: https://unpkg.com/memfs@latest/dist/index.js
```

With `polyfill: false`, ExternalPlugin would instead return `{ external: true }`, and `"fs"` would be excluded from the bundle entirely.

---

**Scenario 6: Package with browser field exclusion**

```javascript
import { something } from "server-only-dep"
```

Where `server-only-dep` has:
```json
{
  "main": "./dist/index.js",
  "browser": {
    "./dist/server-stream.js": false
  }
}
```

Resolution trace:

```
CdnPlugin:
  1. Fetch package.json
  2. resolveLegacy: entry = "./dist/index.js" (from main)
  3. Browser remapping: "./dist/server-stream.js" -> false (excluded)
  4. Entry point "./dist/index.js" is NOT remapped, resolves normally
  5. But when esbuild processes index.js and encounters:
       import { stream } from "./server-stream.js"
     The browser remapping kicks in and returns an empty module.
```

---

**Scenario 7: Subpath export with wildcard pattern**

```javascript
import { Button } from "@ui-lib/components/button"
```

Where `@ui-lib/components` has:
```json
{
  "exports": {
    "./*": {
      "import": "./dist/esm/*.js",
      "require": "./dist/cjs/*.js"
    }
  }
}
```

Resolution trace:

```
CdnPlugin:
  1. parsePackageName -> { name: "@ui-lib/components", subpath: "./button" }
  2. Fetch package.json
  3. resolveModern: match "./button" against "./*" pattern
  4. Wildcard captures: "button"
  5. Substitute into target: "./dist/esm/button.js"
  6. Conditions: import wins (ESM format)
  7. Return: https://unpkg.com/@ui-lib/components@latest/dist/esm/button.js
```


## Module System Components

### Virtual Filesystem

The VFS is the in-memory filesystem that holds the entry point code and any local files. It's the bridge between what you type into bundlejs and what esbuild sees as "files."

When you enter code in bundlejs, it's written to the VFS at the configured entry point path (default: `/index.ts`). esbuild reads this "file" through the VirtualFileSystemPlugin, which returns the in-memory content.

The VFS is also used by the TarballPlugin to mount extracted package contents. Tarball files are written to paths like `/__tarballs__/<hash>/package/dist/index.js`, making them accessible to esbuild through the normal VFS resolution path.

The VFS is cleared after each build (`edge/bundle.ts:15577`) to prevent state leakage between builds.


### Context Management System

**File:** `core/context/context.ts:9246-9500`

bundlejs uses a reactive context system for managing state across the plugin pipeline. The Context class is built on `EventTarget` and uses `Proxy` to make all property access observable.

**Core concepts:**

**Isolated data** — Properties defined in a child context that don't propagate to the parent. Created when you call `context.with({ newProp: value })`. The `newProp` exists only in the child context and its descendants.

**Shared data** — Properties inherited from the parent. If a child modifies a shared property, the change propagates back to the parent. This is how plugins share state like the package manifest cache and version resolution cache.

**Why this matters for the plugin system:**

Each plugin build creates a child context with isolated configuration but shared caches:

```javascript
// Parent context (shared across all plugins)
const StateContext = new Context({
  filesystem: Context.opaque(await filesystem),  // shared VFS
  assets: [],                                    // shared asset list
  config: Context.opaque(createConfig("build", opts)),
  packageManifests: new Map(),                   // shared manifest cache
  versions: new Map(),                           // shared version cache
  tarballMounts: new Map(),                      // shared tarball mounts
  // ... more shared state
})

// CdnPlugin gets a child context with isolated origin
const cdnContext = withContext({ origin: host }, StateContext)
// cdnContext.target.origin is isolated (CDN-specific)
// cdnContext.target.packageManifests is shared (all plugins use it)
```

The `Context.opaque()` wrapper marks certain values as "unproxyable" — they won't be wrapped in a Proxy. This is important for objects like `Map`, `Set`, `Promise`, and `ArrayBuffer` that have methods which break under proxy interception.


### Compression Module

**File:** `compress/compress.ts:160-257`

After bundling, bundlejs compresses the output to give you accurate production size numbers.

| Algorithm | Implementation | Quality range | Notes |
|-----------|---------------|---------------|-------|
| gzip | Native `CompressionStream` API | N/A (browser default) | Fastest, most compatible |
| brotli | WASM | 1-11 | Best compression ratio for web |
| zstd | WASM | 1-11 | Fast decompression, good ratio |
| lz4 | WASM | N/A | Fastest decompression |

Usage:
```javascript
const { compressedSize, uncompressedSize, type } = 
  await compress([bundledCode], { type: "brotli", quality: 5 })
```

The `compress` function accepts an array of `Uint8Array` chunks (supporting multi-file output from code splitting) and returns both compressed and uncompressed sizes.


## Edge Runtime: The Bundling API

**File:** `edge/bundle.ts:15506-15646`

bundlejs runs as an edge function on Deno Deploy. The `bundle()` function is the API entry point:

```
[ HTTP Request ]
  ?q=react&treeshake=true
       |
       v
[ Parse query params ]
  q, treeshake, config, text, share
       |
       v
[ Write entry point to VFS ]
  /index.ts <- "export * from 'react'"
       |
       v
[ build(configObj, FileSystem) ]
  Full esbuild pipeline with all 6 plugins
       |
       v
[ Compress output ]
  gzip/brotli/zstd per config
       |
       v
[ JSON Response ]
  {
    query, version, modules,
    size: { compressedSize, uncompressedSize, type },
    installSize: { total, packages },
    time, warnings?, metafile?
  }
```

The response includes:

- **`size`** — Compressed and uncompressed bundle sizes
- **`installSize`** — Total npm install size and per-package breakdown
- **`modules`** — List of modules with their import/export types
- **`time`** — Human-readable bundle duration
- **`metafile`** — Optional esbuild metafile for bundle analysis (when `?metafile` is set)
- **`warnings`** — Any resolution or bundling warnings


## Configuration Options

### BuildConfig

The full configuration object (`core/types.ts:15891-15921`):

```typescript
{
  // esbuild options (passed through directly)
  esbuild: {
    target: string[],       // ["esnext"] - output syntax level
    format: "esm"|"cjs"|"iife",  // module format
    minify: boolean,        // enable minification
    treeShaking: boolean,   // dead code elimination
    platform: "browser"|"node",  // target platform
    sourcemap: boolean|"inline", // source maps
    external: string[],     // packages to exclude
    // ... all other esbuild options
  },
  
  // bundlejs-specific options
  resolve: ResolverConditions,    // resolution conditions
  "package.json": PackageJson,    // virtual package.json for the bundle
  polyfill: boolean,              // enable Node.js polyfills
  cdn: string,                    // default CDN origin
  alias: Record<string, string>,  // package aliases
  ansi: "html"|"ansi",           // log format
  entryPoints: string[],          // entry file paths
  
  // compression
  compression: {
    type: "gzip"|"brotli"|"zstd"|"lz4",
    quality?: 1-11  // brotli/zstd only
  }
}
```


## Standards-Based Approach

bundlejs is built on web standards rather than Node.js-specific APIs. This is intentional — it's what makes "bundle everywhere" possible.

**Web APIs used throughout:**

| API | Used for | Where |
|-----|----------|-------|
| `fetch` | All HTTP requests, CDN access | HttpPlugin, CdnPlugin, TarballPlugin |
| `URL` | URL parsing and resolution | Everywhere |
| `CompressionStream` / `DecompressionStream` | Native gzip compression | Compression module |
| `crypto.subtle` | SHA-256 hashing for cache keys | TarballPlugin |
| `EventTarget` | Observable context system | Context class |
| `ReadableStream` / `WritableStream` | Tarball streaming extraction | TarballPlugin |

**Package resolution standards implemented:**

| Standard | Coverage |
|----------|----------|
| Node.js `exports` / `imports` | Full conditional exports, subpath patterns, subpath imports |
| `browser` field (string form) | Direct entry point replacement |
| `browser` field (object form) | Module remapping and exclusion |
| Legacy `main` / `module` fields | Fallback resolution |
| JSR registry spec | JSR package resolution |
| npm alias syntax (`npm:pkg@ver`) | Package name aliasing |

This standards-first approach means bundlejs works the same in a browser, a Deno Deploy edge function, or a Node.js process. No filesystem polyfills, no platform-specific code paths for the core resolution logic.


## What bundlejs Adds On Top of esbuild

esbuild provides: parsing, AST construction, module linking, tree-shaking, minification, code splitting, source map generation, and TypeScript support.

bundlejs adds:

| Feature | Why esbuild can't do it alone |
|---------|-------------------------------|
| CDN resolution | esbuild resolves from filesystem; bundlejs resolves from HTTP |
| HTTP fetching with caching | esbuild reads local files; bundlejs fetches over the network |
| Tarball extraction | esbuild doesn't know about npm tarballs |
| Virtual filesystem | esbuild expects real files on disk |
| Node.js polyfills | esbuild marks builtins external; bundlejs provides browser shims |
| `package.json` resolution | esbuild uses Node's resolver; bundlejs reimplements it over HTTP |
| Browser field remapping | Correct handling of both string and object forms |
| Side effects computation | Accurate tree-shaking metadata from `package.json` |
| Multi-algorithm compression | Post-bundle compression for size reporting |
| Extension probing over HTTP | 18-variant probing for extensionless imports |

**What bundlejs explicitly removes or doesn't support:**

| Feature | Reason |
|---------|--------|
| Direct filesystem I/O | No filesystem in browser — VFS only |
| Native Node.js modules (C++ addons) | Can't run native code in WASM |
| `file` / `copy` loaders | No output filesystem for binary assets |
| Some deprecated Node APIs | Excluded from polyfill map |


## Principles Underlying bundlejs

1. **Standards first.** Use web platform APIs (`fetch`, `URL`, `CompressionStream`, `crypto.subtle`) instead of Node.js-specific alternatives. This is what enables cross-runtime portability.

2. **Progressive enhancement.** Graceful fallbacks at every level. Modern `exports` field not present? Fall back to `module` then `main`. Extension not specified? Probe 18 combinations. CDN returns an error? Cache the failure to avoid re-fetching.

3. **Cache everywhere.** Package manifests, resolved versions, HTTP responses, extracted tarballs — everything is cached within a build. HTTP-level caching reduces redundant network requests across builds.

4. **Correct resolution.** Follow the Node.js resolution spec exactly. The browser field bug fix (treating object-form keys as entries) is a good example — correctness matters more than expedience, because incorrect resolution produces wrong bundle sizes.

5. **Composition over configuration.** The plugin pipeline is a linear chain of small, focused plugins. Each plugin has one job. Complex behavior emerges from their composition, not from a single monolithic resolver.

6. **Performance by default.** Parallel HTTP fetching, minimal re-parsing, esbuild's Go-speed bundling, and WASM compression. The edge API returns results in milliseconds for cached packages.

7. **Accurate tree-shaking.** Computing `sideEffects` hints from `package.json` and passing them to esbuild ensures the bundle size you see matches what you'd get in production. Without this, tree-shaking would be too conservative.


## Limitations, Trade-offs, and Gotchas

**CDN dependency.** bundlejs is only as reliable as its CDN. If unpkg.com goes down, resolution fails. The configurable CDN origin mitigates this (switch to jsdelivr.net or esm.sh), but there's no automatic failover between CDNs.

**No persistent cache across builds.** Each build starts with empty caches. The HTTP layer may benefit from browser/edge HTTP caching, but the VFS, manifest cache, and version cache are rebuilt every time. For a size-checking tool this is fine; for a production build tool it would be a bottleneck.

**WASM esbuild is slower than native.** Running esbuild in WebAssembly is roughly 3-5x slower than the native Go binary. bundlejs mitigates this on Deno/Node by using the native binary (`core/init.ts:16328-16388`), but browser builds pay the WASM tax.

**Extension probing generates many HTTP requests.** When an import like `"./utils"` has no extension, bundlejs tries up to 18 URL combinations. Each is an HTTP request. CDN-level caching and HTTP/2 multiplexing help, but this can be slow for deeply nested dependency trees with extensionless imports. Failed probes are cached (`failedExtensionChecks` in the context) to avoid re-trying known failures.

**Browser field handling is a minefield.** The dual-form browser field (string vs. object) is one of npm's most inconsistent conventions. Many packages use it incorrectly, and different bundlers interpret edge cases differently. bundlejs follows the Node.js spec, which means some packages that "work" in webpack might resolve differently.

**No support for dynamic imports at resolution time.** bundlejs resolves static imports. `import("react")` works (esbuild handles it), but the resolution plugins can't resolve imports that are computed at runtime (e.g., `import(someVariable)`).

**Tarball support is limited to specific CDNs.** Currently, only `pkg.pr.new`-style URLs trigger tarball extraction. Arbitrary `.tgz` URLs aren't automatically detected — the TarballPlugin checks against known tarball CDN patterns.


## What to Do Next

If you're building on top of bundlejs or contributing to it, here's the recommended path:

1. **Run the edge API locally.** The edge function (`edge/mod.ts:17498-18003`) is the fastest way to see the full pipeline in action. Hit it with `?q=react` and trace the response.

2. **Read the plugin pipeline** in order. Start with `core/build.ts:18639-18646` where the plugins are registered, then read each plugin's `onResolve` and `onLoad` handlers in order.

3. **Trace a resolution.** Pick a package you know well, and manually walk through the resolution algorithms. Start with the CdnPlugin's `onResolve` handler and follow the code through `parsePackageName`, `getCDNUrl`, `resolveModern`, and `resolveLegacy`.

4. **Understand the Context system.** Read `core/context/context.ts:9246-9500`. The `with()` method and the shared-vs-isolated data model explain how plugins share caches while maintaining independent configuration.

5. **Experiment with the browser field.** Find an npm package with a complex `browser` field (axios is a good example) and trace how `resolveLegacy` handles the remappings. This is where many edge cases live.

6. **Test tarball resolution.** Use `pkg.pr.new` to get a tarball URL for a real package, then trace through the TarballPlugin's extraction and mounting logic.

7. **Explore compression options.** Try different compression algorithms and quality levels through the API. Compare brotli-11 vs gzip for various packages to understand the size/speed tradeoff.

8. **Read the esbuild docs.** bundlejs inherits all of esbuild's configuration options. Understanding esbuild's `target`, `format`, `platform`, `external`, and `conditions` options will help you understand what bundlejs passes through vs. what it intercepts.