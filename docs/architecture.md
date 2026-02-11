# bundlejs: The Complete Architecture Guide

**Bundle anywhere. Bundle everywhere.**

---

## 1. What bundlejs Is (and Why You'd Use It)

bundlejs is a JavaScript/TypeScript bundling service that runs esbuild entirely in WebAssembly — no native binaries, no filesystem, no local install. You give it package names (or raw code), it returns minified, tree-shaken bundles with compressed size measurements. It works as:

- **An HTTP API** deployed on Deno Deploy (edge function)
- **A library** (`@bundle/core`) you can embed in any JavaScript runtime
- **A browser tool** at [bundlejs.com](https://bundlejs.com) for quick package size checks

The problem it solves: "How big will this dependency be in my production bundle?" — answered in seconds, from anywhere, with real esbuild output rather than estimates.

It replaces or complements tools like [bundlephobia](https://bundlephobia.com), but with a critical difference: bundlejs runs a *real* bundler. It doesn't estimate sizes from metadata. It actually bundles, minifies, tree-shakes, and compresses the code, then reports the result.

### Who it's for

- **Library authors** who want to verify their package's bundle footprint
- **Teams** evaluating dependency costs before adopting a package
- **CI pipelines** that need automated bundle size checks via API
- **Developers** building tools that need programmatic bundling without native dependencies

---

## 2. The Mental Model: How to Think About bundlejs

bundlejs is a pipeline. Input code enters at one end, a minified and compressed bundle exits at the other. Every stage in between uses web-standard APIs wherever possible.

```
                        bundlejs Pipeline

  [ User Query ]                (URL params: ?q=react&treeshake=[{useState}])
        |
        v
  [ Edge Function ]             (@bundle/edge — Deno Deploy)
        |  parses query, builds config, checks Redis cache
        v
  [ Core Engine ]               (@bundle/core — esbuild-wasm + plugins)
        |  resolves imports via CDN, fetches packages over HTTP,
        |  bundles in-memory with virtual filesystem
        v
  [ Build Output ]              (minified JS/CSS output files)
        |
        v
  [ Compression ]               (@bundle/compress — gzip/brotli/zstd/lz4)
        |
        v
  [ JSON Response ]             ({ size, input, config, time, ... })
```

**Key insight**: there is no local filesystem. Every file — entry points, npm packages, transitive dependencies — lives in an in-memory virtual filesystem or is fetched over HTTP from a CDN. The esbuild plugins are the mechanism that makes this work.

### What it does NOT do

- It does not install packages to disk (everything is fetched and held in memory)
- It does not run your code (it only bundles and measures)
- It does not support git/file/workspace dependency specifiers (only registry and URL-based specs)
- It does not persist state between requests (each bundle is a fresh build context)

---

## 3. Getting Value Quickly (First 30–60 Minutes)

### Prerequisites

- [Deno](https://deno.land/) installed (the project is a Deno workspace)

### Running locally

```sh
# Clone the repo
git clone https://github.com/okikio/bundlejs-api.git
cd bundlejs-api

# Start the edge function locally
deno serve -A --watch edge/mod.ts
```

The API is now running at `http://localhost:8000`.

### Simplest meaningful invocation

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

### Common early mistakes

1. **Forgetting `UPSTASH_URL`/`UPSTASH_TOKEN` env vars**: Redis caching will silently degrade. The API still works, but every request triggers a fresh build.
2. **Expecting filesystem imports**: bundlejs resolves everything over HTTP. Local `import "./my-file.ts"` only works if that file is written to the virtual filesystem.
3. **Assuming Node.js**: This is a Deno project. Use `deno` commands, not `npm`/`node`.

---

## 4. The Four Modules

bundlejs is a Deno workspace with four packages. Each has a clear responsibility.

```
bundlejs-api/
  ├── core/      @bundle/core       The bundler engine (esbuild + plugins)
  ├── edge/      @bundle/edge       HTTP API layer (Deno Deploy)
  ├── compress/  @bundle/compress   Compression algorithms
  └── utils/     @bundle/utils      Shared utilities (parsing, fetching, resolution)
```

(Defined in the root [deno.jsonc](../deno.jsonc):1-10)

### How they interact

```
  @bundle/edge
    |
    |-- uses --> @bundle/core     (build, transform, init)
    |-- uses --> @bundle/compress (compress bundled output)
    |-- uses --> @bundle/utils    (parsing, version resolution)
    
  @bundle/core
    |-- uses --> @bundle/utils    (npm resolution, fetch, path, conditions)
    
  @bundle/compress
    |-- uses --> @bundle/utils    (encoding, formatting)
```

Dependencies flow downward: `edge → core → utils` and `edge → compress → utils`. The `utils` module has no internal dependencies — it's the foundation.

---

## 5. Module Deep-Dive: `@bundle/utils`

`@bundle/utils` provides the substrate that everything else builds on. It wraps and extends standard libraries for use across the project.

(Package config: [utils/deno.jsonc](../utils/deno.jsonc):1-61)

### Key utilities

| Utility | File | Purpose |
|---------|------|---------|
| Package name parsing | [parse-package-name.ts](../utils/parse-package-name.ts) | Parses `@scope/name@version/path` into structured data |
| npm spec classification | [npm-spec.ts](../utils/npm-spec.ts) | Classifies dependency specs: semver, URL, alias, git, workspace |
| npm registry access | [npm-search.ts](../utils/npm-search.ts) | Fetches metadata, resolves version ranges via registry API |
| JSR registry support | [jsr-spec.ts](../utils/jsr-spec.ts) | Parses `jsr:@scope/name@version` specs, resolves JSR versions |
| Export conditions | [resolve-conditions.ts](../utils/resolve-conditions.ts) | Computes export conditions for multi-runtime resolution |
| Exports/imports resolution | [resolve-exports-imports.ts](../utils/resolve-exports-imports.ts) | Wraps `resolve.exports` for modern `exports`/`imports` field resolution |
| Runtime builtins | [runtime-builtins.ts](../utils/runtime-builtins.ts) | Catalogs Node.js builtins, polyfill mappings, external patterns |
| Fetch + cache | [fetch-and-cache.ts](../utils/fetch-and-cache.ts) | LRU-cached fetch with redirect tracking, stale-while-revalidate |
| Tar streams | [tar.ts](../utils/tar.ts) | Web Streams-based tar extraction |
| Archive detection | [archive-detect.ts](../utils/archive-detect.ts) | Detects compression format from response bytes |
| Semver | [semver.ts](../utils/semver.ts) | Version parsing, range matching |

### Design principle: standards-first

`@bundle/utils` consistently wraps Web APIs rather than Node.js APIs:

- **Fetch API** for HTTP requests (not `node:http`)
- **Web Crypto** for hashing (`crypto.subtle.digest`)
- **ReadableStream/WritableStream** for tar extraction (not `node:stream`)
- **CompressionStream/DecompressionStream** for gzip (not `node:zlib`)
- **TextEncoder/TextDecoder** for string encoding (not `Buffer`)

This is deliberate: bundlejs targets every JavaScript runtime. By building on web standards, the same code runs in Deno Deploy, browsers, Cloudflare Workers, and Node.js without platform-specific shims.

---

## 6. Module Deep-Dive: `@bundle/core`

`@bundle/core` is the heart of bundlejs. It wraps esbuild-wasm with a plugin system that replaces esbuild's filesystem access with HTTP-based package resolution.

(Package config: [core/deno.jsonc](../core/deno.jsonc):1-49)

### Understanding esbuild (the foundation)

esbuild is the bundler that powers bundlejs. To understand bundlejs, you need to understand esbuild's two core operations and its plugin model.

**esbuild's two APIs:**

1. **Build API** (`esbuild.build()`): Takes entry points, resolves imports, bundles everything into output files. Normally reads from and writes to the filesystem.
2. **Transform API** (`esbuild.transform()`): Takes a single string of code, applies transformations (minify, transpile, etc.), returns the result. No filesystem access.

**esbuild's plugin model** provides two hooks:

- **`onResolve`**: Intercepts import path resolution. You tell esbuild *where* an import lives (a URL, a virtual path, etc.) and which namespace it belongs to.
- **`onLoad`**: Intercepts file loading. You provide the *contents* of a file that esbuild resolved via `onResolve`.

This plugin model is the critical enabler for bundlejs. Since esbuild in WASM mode has no filesystem, bundlejs registers plugins that:

1. Resolve bare imports (`"react"`) to CDN URLs (`https://unpkg.com/react@19.0.0/index.js`)
2. Fetch the content over HTTP
3. Return the content to esbuild's `onLoad` hook

esbuild handles everything else: parsing, tree-shaking, scope hoisting, minification, and code generation.

**esbuild's key build options used by bundlejs** (defaults set in [core/build.ts](../core/build.ts):28-56):

| Option | Default | Why |
|--------|---------|-----|
| `bundle` | `true` | Must be true — we're bundling, not just transforming |
| `format` | `"esm"` | ESM output is the primary target |
| `platform` | `"browser"` | Affects which conditions are used for exports resolution |
| `target` | `["esnext"]` | No downlevel transpilation by default |
| `minify` | `true` | Size measurement requires minified output |
| `treeShaking` | `true` | Only include what's actually imported |
| `write` | `false` | Output to memory, not filesystem |
| `outdir` | `"/"` | Virtual output directory |

### What bundlejs adds on top of esbuild

bundlejs extends esbuild with six plugins that collectively replace filesystem access with HTTP-based resolution. It also adds:

1. **Multi-CDN support**: Resolve packages from unpkg, esm.sh, jsdelivr, skypack, JSR, GitHub, or custom CDNs
2. **Virtual filesystem**: An in-memory filesystem for entry points and extracted tarballs
3. **Tarball extraction**: Direct support for `pkg.pr.new` PR preview builds
4. **Compression measurement**: gzip, brotli, zstd, and lz4 size reporting
5. **Node.js polyfills**: Optional browser polyfills for Node.js builtins
6. **Package manifest resolution**: Full `exports`/`imports` field support with browser field handling

### What bundlejs explicitly removes

- **Filesystem access**: No reading from disk. Everything is virtual or HTTP.
- **`node:` built-in support**: Node.js builtins are marked external (or polyfilled) by default. There is no native `fs`, `path`, etc.
- **Git/workspace/link dependencies**: Only registry (semver/tag), URL, and JSR specs are supported. Git refs, `workspace:*`, `link:`, and `file:` specs produce explicit errors ([npm-spec.ts](../utils/npm-spec.ts):1-30).
- **Native binary execution**: Since esbuild runs in WASM, native code execution is impossible. The trade-off is portability.

### Why add functionality on top of esbuild?

esbuild's WASM mode deliberately omits filesystem access. The documentation states:

> "Using this API requires you to use plugins to provide your own file system."

— esbuild changelog (v0.8.21)

bundlejs fills this gap by implementing a complete package resolution pipeline via plugins. This is necessary because:

1. **Edge/browser environments have no filesystem** — bundlejs runs on Deno Deploy, in browsers, and on edge runtimes where `fs.readFileSync` doesn't exist.
2. **npm packages need resolution** — bare imports like `"react"` must be resolved to actual file URLs, which requires fetching `package.json`, resolving `exports` conditions, and following CDN URL patterns.
3. **Size measurement requires real bundles** — estimates from metadata are inaccurate. Only a real bundler produces correct tree-shaken sizes.

### Core API surface

(Exports defined in [core/index.ts](../core/index.ts):1-18)

**`build(opts, filesystem)`** — ([core/build.ts](../core/build.ts):69-171)
The primary entry point. Initializes esbuild, runs a build with all plugins, returns output files with metadata.

**`context(opts, filesystem)`** — ([core/context.ts](../core/context.ts):27-219)
Creates a persistent build context for incremental builds. Same plugin setup as `build()`, but supports `rebuild()`, `cancel()`, and `dispose()`.

**`transform(input, opts)`** — ([core/transform.ts](../core/transform.ts):36-93)
Transforms a single code string without bundling. Uses esbuild's transform API directly.

**`init(opts, [platform, version])`** — ([core/init.ts](../core/init.ts):20-63)
Initializes esbuild. Handles platform detection (Deno, Node, browser, WASM) and WASM module loading. Called automatically by `build()` and `transform()` if esbuild isn't already initialized.

### Platform detection

(Defined in [core/configs/platform.ts](../core/configs/platform.ts):1-15)

bundlejs auto-detects the runtime environment:

```
PLATFORM_AUTO = Deno in globalThis ? "deno"
              : process in globalThis ? "node"
              : "browser"
```

Supported platforms: `"node"`, `"deno"`, `"browser"`, `"edge"`, `"cloudflare"`, `"wasm"`, `"deno-wasm"`.

On non-Node/Deno platforms, esbuild is initialized with a WebAssembly module. The WASM binary is embedded as an ascii85-encoded string in [core/wasm.ts](../core/wasm.ts) and decoded at startup.

### The Event System

(Defined in [core/configs/events.ts](../core/configs/events.ts):1-99)

bundlejs uses the `EventTarget` Web API for lifecycle events. This avoids Node.js-specific event emitters and works in all runtimes.

Events are namespaced with `bundlejs.` prefix:

| Event | When | Payload |
|-------|------|---------|
| `bundlejs.init.start` | esbuild initialization begins | — |
| `bundlejs.init.complete` | esbuild ready | — |
| `bundlejs.init.error` | esbuild init failed | `Error` |
| `bundlejs.build.error` | Build failed | `Error` |
| `bundlejs.logger.info` | Informational log | varies |
| `bundlejs.logger.warn` | Warning | varies |
| `bundlejs.logger.error` | Error log | `Error` |

### The Context System

(Defined in [core/context/context.ts](../core/context/context.ts):1-200)

Plugins share state through a `Context` object — a reactive, hierarchical data container. Conceptually, it's a proxy-based store with inheritance:

- **Shared data**: Properties inherited from parent contexts. Changes propagate bidirectionally.
- **Isolated data**: Properties set in child contexts via `withContext()`. These don't affect the parent.

The `Context` enables two critical patterns:

1. **Plugin state sharing**: All plugins read from and write to the same `LocalState` ([core/types.ts](../core/types.ts):25-48) containing the virtual filesystem, package manifests, version caches, and tarball mounts.
2. **Scoped overrides**: The CDN plugin creates child contexts with `{ origin: host }` so its resolution functions use the right CDN origin without polluting the parent state.

Key context operations:

```ts
fromContext("config", StateContext)   // Read a value
toContext("host", host, StateContext) // Write a value
withContext({ origin }, StateContext) // Create a child context with isolated values
```

### The `LocalState` — plugin shared state

(Defined in [core/types.ts](../core/types.ts):25-48)

Every build creates a `LocalState` that all plugins share:

| Field | Type | Purpose |
|-------|------|---------|
| `filesystem` | `IFileSystem` | In-memory virtual filesystem for entry points and fetched files |
| `config` | `BuildConfig` | Merged build configuration |
| `host` | `string` | Active CDN origin (e.g., `https://unpkg.com`) |
| `versions` | `Map<string, string>` | Resolved package version cache |
| `assets` | `OutputFile[]` | Discovered assets (WASM, workers, etc.) |
| `tarballMounts` | `Map<string, TarballMount>` | Extracted tarball package metadata |
| `tarballInflight` | `Map<string, Promise>` | Deduplicates concurrent tarball fetches |
| `packageManifests` | `Map<string, PackageJson>` | Cached `package.json` manifests |
| `sideEffectsMatchersCache` | `Map<string, SideEffectsMatchers>` | Compiled sideEffects glob patterns |
| `failedExtensionChecks` | `Set<string>` | URLs that failed extension probing (avoid re-trying) |
| `failedManifestUrls` | `Set<string>` | Manifest URLs that 404'd |

---

## 7. The Plugin Chain: How Resolution Works

The six esbuild plugins are registered in a specific order. Order matters because esbuild evaluates `onResolve` callbacks in registration order — the first plugin that returns a result wins.

(Plugin registration: [core/build.ts](../core/build.ts):128-135)

```ts
plugins: [
  AliasPlugin(StateContext),              // 1. Alias rewrites
  ExternalPlugin(StateContext),           // 2. External marking / polyfills
  VirtualFileSystemPlugin(StateContext),  // 3. In-memory files
  TarballPlugin(StateContext),            // 4. Tarball URL extraction
  HttpPlugin(StateContext),               // 5. HTTP URL loading
  CdnPlugin(StateContext),               // 6. Bare import → CDN URL
]
```

### The resolution flow

When esbuild encounters an import, it passes through the plugin chain:

```
import "react"
    |
    v
1. AliasPlugin
    |  Is "react" in the alias map? (e.g., alias: { "react": "preact/compat" })
    |  YES → rewrite path, delegate to HttpResolution
    |  NO  → pass through
    v
2. ExternalPlugin  
    |  Is "react" a Node.js builtin? (fs, path, etc.)
    |  YES + polyfill=false → mark external, return empty export
    |  YES + polyfill=true  → rewrite to polyfill package, delegate to CdnResolution
    |  NO  → pass through
    v
3. VirtualFileSystemPlugin
    |  Is it an absolute path (/index.tsx) or relative (./foo)?
    |  YES → check in-memory filesystem, probe extensions
    |  Is it a URL or bare import?
    |  → pass through (URLs and bare imports are NOT handled here)
    v
4. TarballPlugin
    |  Is it a tarball CDN URL? (e.g., https://pkg.pr.new/...)
    |  YES → fetch tarball, extract to VFS, resolve entry point
    |  Is the importer inside an extracted tarball? (self-reference check)
    |  YES → resolve against the tarball's package.json exports
    |  NO  → pass through
    v
5. HttpPlugin
    |  Is it an HTTP/HTTPS URL?
    |  YES → fetch content, determine loader, discover assets
    |  Is it a relative import within an HTTP module? (./debounce from https://esm.sh/lodash)
    |  YES → resolve relative to parent's final URL
    |  Is it a bare import? (referenced from an HTTP namespace module)
    |  YES → delegate to CdnResolution  
    v
6. CdnPlugin
    |  Bare import "react" → CdnResolution algorithm:
    |    - Check subpath imports (#internal/...)
    |    - Parse package name + look up version from manifest
    |    - Classify dependency spec (semver, URL, alias, unsupported)
    |    - Fetch package.json from CDN registry
    |    - Resolve entry point via exports → legacy fields → defaults
    |    - Construct final CDN URL
    |    - Return { path: "https://unpkg.com/react@19.0.0/index.js", namespace: "http-url" }
```

### Plugin #1: AliasPlugin

(Defined in [core/plugins/alias.ts](../core/plugins/alias.ts):1-119)

Rewrites package names before any other resolution. Configured via `config.alias`.

```ts
// Config
{ alias: { "fs": "memfs", "react": "preact/compat" } }

// Effect: import "fs" → resolves as import "memfs"
```

Also handles `node:` prefixed imports. If a `node:*` import has no alias and `polyfill` is false, it's immediately marked external.

### Plugin #2: ExternalPlugin

(Defined in [core/plugins/external.ts](../core/plugins/external.ts):1-225)

Handles Node.js builtins and custom external patterns. Two modes:

- **`polyfill: false`** (default): Node.js builtins are marked external, returning an empty `export default {}`. A warning is emitted.
- **`polyfill: true`**: Builtins are rewritten to browser polyfill packages (e.g., `fs → memfs`, `path → path-browserify`) and routed through CdnResolution.

Polyfill mappings come from `@bundle/utils/runtime-builtins` ([runtime-builtins.ts](../utils/runtime-builtins.ts):1-100), which catalogs ~50 Node.js builtins with their browser polyfill packages and cross-runtime support metadata.

### Plugin #3: VirtualFileSystemPlugin

(Defined in [core/plugins/fs.ts](../core/plugins/fs.ts):1-307)

Provides an in-memory filesystem using three targeted `onResolve` handlers:

1. **VFS-prefixed paths** (`vfs:`, `virtual:`) — any namespace
2. **Absolute paths** (`/index.tsx`) — any namespace
3. **Relative paths** (`./component.tsx`) — VFS namespace only

This design is deliberate. By limiting relative path handling to VFS-namespace importers, the plugin avoids intercepting relative imports inside HTTP-fetched modules (which belong to the HttpPlugin).

Resolution follows esbuild's filesystem resolver pattern:
1. Exact path match
2. Extension probing (`.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json`)
3. Directory → `index.*` fallback

(Extension list: [core/utils/loader.ts](../core/utils/loader.ts):6)

### Plugin #4: TarballPlugin

(Defined in [core/plugins/tar.ts](../core/plugins/tar.ts):1-769)

Handles tarball-based package sources (currently `pkg.pr.new` for PR preview builds). The flow:

1. Detect tarball URL by CDN style (`getCDNStyle(url.origin) === "tarball"`)
2. Parse URL to extract package spec + subpath ([`parseTarballUrl`](../core/plugins/tar.ts#L169))
3. Fetch and extract tarball into VFS under `/__tarballs__/<hash>/` ([`fetchAndExtractTarball`](../core/plugins/tar.ts#L330))
4. Resolve entry point via `exports`/legacy fields from extracted `package.json`
5. Return VFS path in `virtual-filesystem` namespace

The plugin also handles **self-reference imports** — when code inside an extracted tarball imports its own package name, the plugin resolves it against the tarball's manifest instead of fetching from a CDN.

Inflight deduplication ensures the same tarball is only fetched and extracted once, even if multiple imports reference it concurrently.

Archive detection uses `@bundle/utils/archive-detect` to inspect response bytes and determine compression format (gzip, zstd, etc.) before extraction.

### Plugin #5: HttpPlugin

(Defined in [core/plugins/http.ts](../core/plugins/http.ts):1-421)

The workhorse plugin. Handles all HTTP/HTTPS URL resolution and content loading.

**Resolution** ([`HttpResolution`](../core/plugins/http.ts#L271)):
- Direct HTTP URLs → HTTP namespace
- Bare imports from within HTTP modules → delegate to CdnResolution
- Relative imports → resolve against the **final URL** (after redirects) stored in `pluginData.url`

**Loading** (`onLoad`):
1. Probe for correct extension using `determineExtension()` — tries path variants like `""`, `.js`, `.mjs`, `.ts`, `/index.js`, etc. ([core/plugins/http.ts](../core/plugins/http.ts#L167-194))
2. Fetch content via `fetchPkg()` — follows redirects, stores final URL
3. Write to virtual filesystem (for bundle analysis)
4. Discover assets via `fetchAssets()` — finds `new URL("...", import.meta.url)` patterns for WASM/worker loading
5. Return content with inferred loader and the final URL in `pluginData`

**Critical detail**: The `pluginData.url` field carries the **redirected** URL. When `https://esm.sh/lodash@latest` redirects to `https://esm.sh/lodash@4.17.21`, relative imports inside that file resolve against `4.17.21`, not `latest`. This is how version stability works.

### Plugin #6: CdnPlugin

(Defined in [core/plugins/cdn.ts](../core/plugins/cdn.ts):1-649)

The most complex plugin. Resolves bare imports (like `"react"`) to CDN URLs through a multi-step algorithm.

The full `CdnResolution` algorithm ([core/plugins/cdn.ts](../core/plugins/cdn.ts):133-649):

**Step 1 — Build manifest context**
Merge the user-provided `package.json` config with inherited manifest data from `pluginData.manifest`. This determines which versions of dependencies to use.

**Step 2 — Subpath imports (`#internal/...`)**
Node.js subpath imports are resolved against the *importer's* manifest (not the root manifest). This is critical for packages like `vfile` that use `#minpath` internally.

**Step 3 — JSR specifiers (`jsr:@scope/name`)**
Parse with `parseJSRSpec()`, resolve version range, fetch version metadata for exports, construct direct JSR module URL. Falls back to esm.sh proxy on failure.

**Step 4 — Bare imports**
1. Parse package name and version from import path
2. Look up version in inherited manifest dependencies
3. Classify the dependency spec:
   - **URL spec** → route through `build.resolve()` (TarballPlugin or HttpPlugin handles it)
   - **Alias spec** (`npm:@tanstack/react-query@^5`) → unwrap alias, continue resolution
   - **Unsupported spec** (git, file, workspace, link) → return error
   - **Registry spec** (semver/tag) → continue to CDN resolution

**Step 5 — CDN resolution for registry specs**
1. Resolve exact version via npm registry API
2. Fetch `package.json` from `https://unpkg.com/<name>@<version>/package.json`
3. Resolve entry point through combined resolution:
   - **Modern**: `exports` field with computed conditions
   - **Legacy**: `main` → `module` → `browser` (string form) → `unpkg` → `bin`
   - **Browser remapping**: If `browser` field is an object, it's a remapping layer applied on top of the resolved entry
4. Construct final CDN URL: `https://unpkg.com/<name>@<version><resolved-path>`
5. Emit through `determineExtension()` for extension probing
6. Return with `sideEffects` metadata and inherited peer dependencies

---

## 8. The Resolution Algorithm: Five Real Scenarios

The CDN resolution algorithm handles many edge cases. Here are five concrete scenarios that exercise different paths through the code.

### Scenario 1: Simple bare import

```ts
import { useState } from "react";
```

**Resolution path:**
1. AliasPlugin → no alias → pass
2. ExternalPlugin → `react` is not a builtin → pass
3. VirtualFileSystemPlugin → not absolute/relative → pass
4. TarballPlugin → not a URL → pass
5. HttpPlugin → not a URL → pass
6. CdnPlugin → bare import detected:
   - `parsePackageName("react")` → `{ name: "react", version: null, path: "" }`
   - No version in import → check manifest deps → nothing → `assumedVersion = "latest"`
   - Spec type: registry (tag)
   - `resolveVersion("react@latest")` → `"19.0.0"`
   - Fetch `https://unpkg.com/react@19.0.0/package.json`
   - `resolvePackageEntry(manifest, ".", conditions)` → `exports["."]` → `"./index.js"`
   - Final URL: `https://unpkg.com/react@19.0.0/index.js`
   - Return `{ path: "https://unpkg.com/react@19.0.0/index.js", namespace: "http-url" }`

### Scenario 2: Scoped package with subpath export

```ts
import { QueryClient } from "@tanstack/react-query/build/modern";
```

**Resolution path (CdnPlugin):**
1. `parsePackageName("@tanstack/react-query/build/modern")` → `{ name: "@tanstack/react-query", version: null, path: "/build/modern" }`
2. `assumedVersion = "latest"` → `resolveVersion()` → `"5.62.0"`
3. Fetch `https://unpkg.com/@tanstack/react-query@5.62.0/package.json`
4. Subpath `/build/modern` → try `exports["./build/modern"]`:
   - `resolveModern(manifest, "./build/modern", conditions)` → resolves via `exports` field
   - Returns `"./build/modern/index.js"`
5. Final URL: `https://unpkg.com/@tanstack/react-query@5.62.0/build/modern/index.js`

### Scenario 3: npm alias with URL-based version (PR preview)

```json
{
  "dependencies": {
    "@tanstack/react-query": "https://pkg.pr.new/@tanstack/react-query@7988"
  }
}
```

```ts
import { useQuery } from "@tanstack/react-query";
```

**Resolution path:**
1. CdnPlugin: bare import `@tanstack/react-query`
2. Version from manifest: `"https://pkg.pr.new/@tanstack/react-query@7988"`
3. `parseNpmSpec("https://pkg.pr.new/...")` → `kind: "url"`
4. `isUrlSpec(spec)` → `true` → call `build.resolve(url)` to re-enter plugin chain
5. TarballPlugin intercepts: `getCDNStyle("https://pkg.pr.new") === "tarball"` → `true`
6. `parseTarballUrl()` → `{ name: "@tanstack/react-query", version: "7988", subpath: "" }`
7. Fetch tarball, extract to VFS at `/__tarballs__/<hash>/`
8. Read extracted `package.json`, resolve entry point via `exports`
9. Return `{ path: "/__tarballs__/<hash>/build/modern/index.js", namespace: "virtual-filesystem" }`

### Scenario 4: JSR specifier

```ts
import { join } from "jsr:@std/path@^1.0.0/posix";
```

**Resolution path (CdnPlugin):**
1. `looksLikeJSRSpec("jsr:@std/path@^1.0.0/posix")` → `true`
2. `parseJSRSpec(...)` → `{ scope: "std", name: "path", version: "^1.0.0", subpath: "/posix" }`
3. `resolveJSRVersion({ scope: "std", name: "path", version: "^1.0.0" })` → `"1.0.8"`
4. Get version metadata: `https://jsr.io/@std/path/1.0.8_meta.json`
5. Look up `exports["./posix"]` → `"./posix/mod.ts"`
6. Build module URL: `https://jsr.io/@std/path/1.0.8/posix/mod.ts`
7. Probe with `determineExtension()` → URL confirmed
8. Return `{ path: "https://jsr.io/@std/path/1.0.8/posix/mod.ts", namespace: "http-url" }`

### Scenario 5: Subpath imports (`#internal`)

A package `vfile` has in its `package.json`:
```json
{
  "imports": { "#minpath": { "browser": "./lib/minpath.browser.js", "default": "./lib/minpath.js" } }
}
```

Code inside `vfile`:
```ts
import { resolve } from "#minpath";
```

**Resolution path (CdnPlugin):**
1. `argPath` starts with `#` → subpath import handler
2. Use **importer's manifest** (passed via `pluginData.manifest`), not the root manifest
3. `resolveModern(importerManifest, "#minpath", conditions)` → resolves via `imports` field
4. Browser conditions → `"./lib/minpath.browser.js"`
5. Rewrite path to `vfile@3.0.1/lib/minpath.browser.js`
6. Continue through normal CDN URL construction

### Scenario 6: Node.js builtin with polyfill enabled

```ts
import { readFileSync } from "fs";
```

With `{ polyfill: true }`:

**Resolution path:**
1. AliasPlugin → no alias for `fs` → pass
2. ExternalPlugin:
   - `isExternal("fs")` → `"fs"` (match)
   - `polyfill: true` → `isAlias("fs", PolyfillMap)` → match: `"memfs"`
   - Create CdnResolution context with polyfill package
   - Delegate `CdnResolution({ path: "memfs" })` → resolves `memfs` from CDN
3. Returns CDN URL for `memfs` package

### Scenario 7: Relative import inside an HTTP-fetched module

```ts
// Inside https://esm.sh/lodash@4.17.21/lodash.js
import debounce from "./debounce.js";
```

**Resolution path:**
1. This import is in the `http-url` namespace
2. VirtualFileSystemPlugin: relative import but namespace is `http-url`, not `virtual-filesystem` → skip
3. HttpPlugin `onResolve` (namespace filter: `http-url`):
   - `argPath = "./debounce.js"` starts with `.` → relative import
   - Base URL from `pluginData.url` = `"https://esm.sh/lodash@4.17.21/lodash.js"` (the redirected URL)
   - `resolvedPath = urlJoin("https://esm.sh/lodash@4.17.21/lodash.js", "../", "./debounce.js")`
   - → `"https://esm.sh/lodash@4.17.21/debounce.js"`
4. Return `{ path: "https://esm.sh/lodash@4.17.21/debounce.js", namespace: "http-url" }`

---

## 9. Configuration Reference

### BuildConfig

(Defined in [core/types.ts](../core/types.ts):51-93)

```ts
interface BuildConfig {
  // esbuild options (passed directly to esbuild.build())
  esbuild?: {
    target?: string[];         // Default: ["esnext"]
    format?: "esm" | "cjs" | "iife";  // Default: "esm"
    platform?: "browser" | "node" | "neutral";  // Default: "browser"
    minify?: boolean;          // Default: true
    treeShaking?: boolean;     // Default: true
    sourcemap?: boolean | "inline" | "external";
    metafile?: boolean;
    external?: string[];       // Additional external packages
    define?: Record<string, string>;
    logLevel?: string;
    // ... all standard esbuild BuildOptions
  };

  // bundlejs-specific options
  entryPoints?: string[];      // Default: ["/index.tsx"]
  cdn?: string;                // Default: "https://unpkg.com"
                               // Options: "unpkg", "esm.sh", "esm", "jsr",
                               //          "skypack", "jsdelivr", "deno", "github", etc.
  alias?: Record<string, string>;  // Package aliases: { "fs": "memfs" }
  polyfill?: boolean;          // Default: false (polyfill Node.js builtins)
  "package.json"?: object;     // Dependency versions and manifest data
  ansi?: "html" | "html-and-ansi" | "ansi";  // Log format
  resolve?: {                  // Export condition overrides
    runtime?: string;
    conditions?: string[];
  };

  // Initialization
  init?: {
    platform?: Platform;       // Auto-detected
    version?: string;          // esbuild version (default: "0.27.2")
    wasmModule?: WebAssembly.Module;  // Pre-compiled WASM module
    wasmURL?: string;          // URL to esbuild WASM binary
  };
}
```

### CompressConfig

(Defined in [compress/types.ts](../compress/types.ts):1-15)

```ts
type CompressConfig =
  | CompressionType                    // "gzip" | "brotli" | "zstd" | "lz4"
  | {
      type?: CompressionType;          // Compression algorithm
      quality?: 1-11;                  // Quality level (brotli/zstd only)
    };
```

### CDN Options

(CDN scheme mapping: [core/utils/cdn-format.ts](../core/utils/cdn-format.ts):109-122)

| Config value | CDN URL | Style |
|-------------|---------|-------|
| `"unpkg"` (default) | `https://unpkg.com` | npm |
| `"esm.sh"` or `"esm"` | `https://esm.sh` | npm |
| `"skypack"` | `https://cdn.skypack.dev` | npm |
| `"jsdelivr"` | `https://cdn.jsdelivr.net/npm` | npm |
| `"esm.run"` | `https://cdn.jsdelivr.net/npm` | npm |
| `"jsr"` | `https://jsr.io` | jsr |
| `"deno"` | `https://deno.land/x` | deno |
| `"github"` | `https://raw.githubusercontent.com` | github |
| `"jsdelivr.gh"` | `https://cdn.jsdelivr.net/gh` | github |
| Any full URL | Used directly | Detected from URL |

---

## 10. Module Deep-Dive: `@bundle/compress`

(Package config: [compress/deno.jsonc](../compress/deno.jsonc):1-21)

Provides multi-algorithm compression for measuring bundle sizes. Algorithms:

| Algorithm | Implementation | Quality configurable |
|-----------|---------------|---------------------|
| **gzip** (default) | Web `CompressionStream` API | No |
| **brotli** | WASM module ([compress/deno/brotli/](../compress/deno/brotli/)) | Yes (1–11) |
| **zstd** | WASM module ([compress/deno/zstd/](../compress/deno/zstd/)) | Yes (1–11) |
| **lz4** | WASM module ([compress/deno/lz4/](../compress/deno/lz4/)) | No |

The `compress()` function ([compress/compress.ts](../compress/compress.ts):30-98):
1. Converts inputs to `Uint8Array`
2. Lazily imports the chosen compression module (WASM is only loaded when needed)
3. Compresses all input buffers
4. Returns both raw and human-readable sizes

**Standards-first again**: gzip uses the native `CompressionStream` API available in all modern runtimes. WASM modules are only used for algorithms that don't have native Web API support.

---

## 11. Module Deep-Dive: `@bundle/edge`

(Package config: [edge/deno.jsonc](../edge/deno.jsonc):1-21)

The HTTP API layer, deployed to Deno Deploy. It:

1. **Parses query parameters** into build configuration
2. **Checks Redis cache** (Upstash) for previously computed results
3. **Runs the build** via `@bundle/core`
4. **Compresses the output** via `@bundle/compress`
5. **Returns JSON** (or badges, files, analysis)

### API Endpoints

(All handled in [edge/mod.ts](../edge/mod.ts):68-503)

| URL | Result |
|-----|--------|
| `/?q=react` | JSON with bundle size |
| `/?q=react&treeshake=[{useState}]` | Tree-shaken size for specific exports |
| `/?q=react&badge` | SVG badge image |
| `/?q=react&badge=detailed` | Badge with module names |
| `/?q=react&badge-raster` | PNG badge |
| `/?q=react&file` | Raw bundled JavaScript |
| `/?q=react&analysis` | esbuild bundle analysis (HTML) |
| `/?q=react&metafile` | esbuild metafile JSON |
| `/?q=react&raw` | Full raw result JSON |
| `/?q=react&warnings` | Build warnings (HTML) |
| `/?q=react&polyfill` | Enable Node.js polyfills |
| `/?q=react&minify=false` | Disable minification |
| `/?q=react&format=cjs` | Output as CommonJS |
| `/?q=react&sourcemap=inline` | Include source maps |
| `/?q=react&config={...}` | JSON5 config object |
| `/?q=react&tsx` | Enable JSX/TSX support |

### Query Parameter Parsing

(Defined in [edge/parse-query.ts](../edge/parse-query.ts):1-200)

The `q` parameter supports multiple packages separated by commas:

```
/?q=react,vue,@tanstack/react-query
```

The `(import)` prefix changes a module from export to import:

```
/?q=(import)react,vue
→ import * from "react";
  export * from "vue";
```

The `treeshake` parameter uses bracket syntax for per-package exports:

```
/?treeshake=[{useState}],[*],[{computed}]
→ export { useState } from "react";
  export * from "vue";
  export { computed } from "...";
```

The `share` parameter accepts LZ-string compressed code for large inputs.

The `text` parameter accepts raw code as a string.

The `config` parameter accepts a JSON5 configuration object.

### Caching Strategy

The edge function uses a two-tier caching strategy:

1. **Redis (Upstash)**: Results are cached by a key derived from the full configuration + input. TTL is 24 hours. Badge images are cached separately.
2. **Module-level cache**: For single-module exports with no mutations, results are also stored under a package-specific key for cross-query hits.

Cache invalidation endpoints:
- `/delete-cache` — Deletes the cache entry for the current query
- `/no-cache` — Bypasses cache for the current request
- `/clear-all-cache-123` — Administrative cache flush

---

## 12. The Virtual Filesystem

(Defined in [core/utils/filesystem.ts](../core/utils/filesystem.ts):1-100)

The virtual filesystem is the abstraction that replaces disk access. It implements the `IFileSystem<T>` interface:

```ts
interface IFileSystem<T> {
  files(): Promise<Map<string, T>>;     // Direct access to storage
  get(path: string): Promise<Content | null>;  // Read file
  has(path: string): Promise<boolean>;         // Check existence
  set(path: string, content?: Content): Promise<void>;  // Write file
  delete(path: string): Promise<boolean | void>;  // Remove file
  clear?(): Promise<void>;              // Wipe all files
}
```

The default implementation (`useFileSystem()`) uses a simple `Map<string, Uint8Array>` — efficient and portable.

Files enter the VFS from three sources:
1. **User entry point**: Written by the edge function before build starts
2. **HTTP fetches**: Content stored after download (for bundle analysis)
3. **Tarball extraction**: Package files extracted from `.tgz` archives

---

## 13. Tree-Shaking and Side Effects

bundlejs enables esbuild's tree-shaking by default (`treeShaking: true`). But tree-shaking only works well when the bundler knows which modules have side effects.

The `sideEffects` field in `package.json` is the primary signal:

- `"sideEffects": false` → All code is safe to tree-shake
- `"sideEffects": ["*.css", "./src/polyfill.js"]` → Only listed files have side effects

bundlejs implements side effects computation in [core/utils/side-effects.ts](../core/utils/side-effects.ts):

1. Read the `sideEffects` field from the resolved `package.json`
2. If `false` → mark the module as side-effect-free
3. If an array → compile glob patterns, match against the resolved module path
4. Cache compiled matchers per package (via `sideEffectsMatchersCache`)

The computed `sideEffects` value is passed to esbuild via the `onResolve` result, enabling esbuild to drop unused imports from side-effect-free modules.

---

## 14. Export Condition Resolution

(Defined in [utils/resolve-conditions.ts](../utils/resolve-conditions.ts):1-150)

Modern packages use conditional exports to provide different code for different environments:

```json
{
  "exports": {
    ".": {
      "import": "./esm/index.js",
      "require": "./cjs/index.js",
      "browser": "./browser/index.js",
      "default": "./esm/index.js"
    }
  }
}
```

bundlejs computes the appropriate conditions based on:

- **esbuild's `platform`**: `"browser"` → adds `browser` condition; `"node"` → adds `node` condition
- **Import kind**: `import-statement` → `import` condition; `require-call` → `require` condition
- **Runtime**: Optional `runtime` field for Deno, Bun, Cloudflare Workers, etc.
- **Custom conditions**: User-provided via `config.resolve.conditions`

Condition priority order (browser platform, ESM):

```
["import", "browser", "module", "default"]
```

The resolver supports 10+ runtime profiles including Deno, Bun, Electron (main/renderer), React Native, Cloudflare Workers, and Vercel Edge.

---

## 15. Using bundlejs as a Building Block

### As a library

```ts
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

### With a custom filesystem

```ts
import { build, useFileSystem, setFile } from "@bundle/core";

const fs = useFileSystem();
const fsInstance = await fs;
await setFile(fsInstance, "/index.ts", `export { useState } from "react";`);

const result = await build(
  { entryPoints: ["/index.ts"] },
  fs
);
```

### In CI pipelines

```sh
# Check bundle size of a package
curl "https://deno.bundlejs.com/?q=@tanstack/react-query&treeshake=[{useQuery}]"

# Get just the badge for README
# https://deno.bundlejs.com/?q=my-package&badge
```

### As an importable bundle

The `/?file` endpoint returns the raw bundled JavaScript, which can be imported directly:

```ts
import { something } from "https://deno.bundlejs.com/?q=my-package&file";
```

---

## 16. Principles Underlying bundlejs

### 1. Web Standards First

Every API choice favors web platform standards over runtime-specific APIs. `fetch()` over `http.request()`. `ReadableStream` over `Node.js streams`. `crypto.subtle` over `node:crypto`. `CompressionStream` over `zlib`. This isn't dogma — it's a strategic choice that enables running the same code in Deno Deploy, browsers, Cloudflare Workers, and Node.js.

### 2. Real Bundling, Not Estimation

bundlejs runs esbuild. It doesn't estimate sizes from package metadata. It performs actual tree-shaking, dead code elimination, scope hoisting, and minification. The output size is the production-accurate size.

### 3. HTTP as the Filesystem

The internet is the filesystem. npm's registry is the dependency resolver. CDN servers are the file servers. This inverts the traditional bundler model where everything starts from disk.

### 4. Progressive Enhancement

Node.js builtins degrade gracefully (external or polyfilled). Missing manifests fall back to URL-based resolution. Failed CDNs produce warnings, not crashes. Each layer provides a fallback.

### 5. Bundle Everywhere

The end goal is a bundler that runs anywhere JavaScript runs. The same `@bundle/core` library works:
- On the edge (Deno Deploy, Cloudflare Workers)
- In the browser (via esbuild-wasm)
- On the server (Deno, Node.js)
- In CI (via the HTTP API)

This enables scenarios like emulating Node.js on the browser (via polyfills), bundling using an API endpoint, or running the full bundler client-side.

---

## 17. Limitations, Trade-offs, and Gotchas

### Performance vs. native esbuild

WASM esbuild is slower than native esbuild. For large bundles, expect 2–5x overhead. The trade-off is universal portability.

### No git/workspace/link dependencies

Dependency specs like `git+https://...`, `workspace:*`, `link:../path`, and `file:./local.tgz` produce explicit errors. Only npm registry (semver/tags), URL, and JSR specs are supported. (Inferred from [npm-spec.ts](../utils/npm-spec.ts) — `isUnsupportedSpec` returns true for these types.)

### CDN-dependent resolution

Accuracy of resolution depends on the CDN. unpkg supports `package.json` file access (enabling proper exports resolution). Some CDNs don't. bundlejs will warn:

> "You may want to change CDNs. The current CDN doesn't support package.json files."

(Warning from [core/plugins/cdn.ts](../core/plugins/cdn.ts) CDN resolution fallback path.)

### Extension probing overhead

When CDN responses lack file extensions, bundlejs probes up to 18 path variants (`""`, `".js"`, `".mjs"`, `".ts"`, `/index.js`, etc.). This is necessary but adds latency for packages with extensionless imports. Failed probes are cached to avoid repeated requests.

(Variants defined in [core/plugins/http.ts](../core/plugins/http.ts#L167-194))

### No persistent caching in core

`@bundle/core` itself has no persistent cache. The LRU cache in `fetch-and-cache.ts` is in-memory and resets per process. The Redis cache layer exists only in `@bundle/edge`. If you embed `@bundle/core` in your own tool, you'll want to add caching.

### Side effects accuracy

The `sideEffects` computation depends on `package.json` being accurately fetched and the glob patterns being correctly compiled. Some packages have incorrect `sideEffects` declarations, which can cause over-aggressive or insufficient tree-shaking. This is a package ecosystem problem, not a bundlejs bug.

---

## 18. What to Do Next

1. **Run locally**: `deno serve -A --watch edge/mod.ts` — get a working local instance.
2. **Try the API**: Hit `http://localhost:8000/?q=preact` and inspect the JSON response.
3. **Read the plugin chain**: Start at [core/build.ts](../core/build.ts#L128-135) where plugins are registered. Follow imports from there.
4. **Trace a resolution**: Add `console.log` to `CdnResolution` in [core/plugins/cdn.ts](../core/plugins/cdn.ts) and watch how `react` resolves through the system.
5. **Try tree-shaking**: Compare `/?q=lodash-es` vs `/?q=lodash-es&treeshake=[{debounce}]` to see tree-shaking in action.
6. **Embed in your own code**: Import from `@bundle/core` directly and build something with the programmatic API.
7. **Explore CDN options**: Try `/?q=react&config={"cdn":"esm.sh"}` vs `/?q=react&config={"cdn":"jsdelivr"}` and compare size results.
8. **Understand the context system**: Read [core/context/context.ts](../core/context/context.ts) to understand how plugin state inheritance works.
9. **Inspect the compression module**: Swap compression algorithms with `/?q=react&config={"compression":"brotli"}` and observe the size difference.
10. **Read the resolution utilities**: [utils/resolve-conditions.ts](../utils/resolve-conditions.ts) and [core/utils/cdn-resolution.ts](../core/utils/cdn-resolution.ts) contain the logic that determines which file a package import points to.

---

*This document reflects the state of the `simplify-edge-functions` branch. File paths and line numbers are evidence from the codebase as reviewed.*
