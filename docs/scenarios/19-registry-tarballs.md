# Scenario 19: Registry Tarballs & Generic `.tgz` URLs

## Problem

The TarballPlugin originally only supported `pkg.pr.new` URLs. Users need to import
directly from npm registry tarballs (and other `.tgz`/`.tar.gz` sources) — with subpath
support — so they are not locked into a single tarball provider.

Example use cases:
- Pin a specific registry tarball: `https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz`
- Import a subpath from a tarball: `https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator`
- GitHub release tarballs: `https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz`

## URL Anatomy

```
https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator
├──────────────── tarball URL (for fetching) ──────────────────┤├── subpath ────┤
```

The **tarball extension** (`.tgz` or `.tar.gz`) is the split point:
- Everything up to and including the extension → fetch URL
- Everything after → subpath for `exports`/`main` resolution

## Detection: `isTarballUrl()` and `isTarballPath()`

Previously: `getCDNStyle(url.origin) === "tarball"` — only matched `pkg.pr.new`.

Now two categories:
1. **CDN-style** — `getCDNStyle()` returns `"tarball"` (pkg.pr.new)
2. **Extension-based** — delegated to `archive-detect`'s `detectArchiveFromPathHint()`

`isTarballUrl(url)` checks CDN-style first, then delegates to `isTarballPath(url.pathname)`.

`isTarballPath(path)` is the path-based counterpart — use it for VFS paths or any non-URL
string. Both ultimately call `findTarballSplitInPathname()`.

### How it works: `findTarballSplitInPathname()`

Rather than building custom regex from archive-detect's extension lists (which duplicates
the detection logic), we walk pathname segments and call `detectArchiveFromPathHint()` on
each segment. This function is the **single source of truth** for "does this filename look
like a tarball?" — it handles:

- Multi-extension priority (`.tar.gz` before `.tar`)
- Short conventions (`.tgz`, `.txz`, `.tzst`, `.tbz2`, etc.)
- Ambiguous cases (`.gz` alone → `isTarballLike: false`)
- Confidence and container/compression classification

The first tarball-like segment is the split point:
- Everything up to and including that segment → tarball fetch URL
- Everything after → subpath for `exports`/`main` resolution

This way the tar plugin has **zero extension-matching logic of its own** — detection
is fully delegated to `archive-detect`. Add a new extension there and it's automatically
recognized here.

## Parsing: Two Paths

### 19.1 — pkg.pr.new URLs → `parseTarballUrl()`
Unchanged. Uses the existing compact/non-compact path parsing specific to pkg.pr.new.

### 19.2 — Generic tarball URLs → `parseGenericTarballUrl()`
New function. Splits the pathname at the archive extension to produce:
- `tarballUrl` — the fetch URL (no query/hash)
- `subpath` — remaining path segments (may be empty)

## Resolution Flow in `TarResolution()`

The plugin handles three branches:

### Branch 1: HTTP tarball URLs
```
args.path = "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator"
                │
                ▼
        isTarballUrl(url) → true (.tgz in pathname)
                │
                ▼
     getCDNStyle(url.origin) === "tarball"?
        ├── yes → parseTarballUrl()       (pkg.pr.new)
        └── no  → parseGenericTarballUrl() (registry/generic)
                │
                ▼
     { subpath: "/expo-sqlite/migrator",
       packageUrl: "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz" }
                │
                ▼
     getOrCreateMount(packageUrl) → fetchAndExtractTarball() → extract to VFS
                │
                ▼
     resolvePackageEntry(manifest, subpath, conditions) → "./expo-sqlite/migrator.js"
                │
                ▼
     Return { path: "/__tarballs__/<hash>/expo-sqlite/migrator.js", namespace: "vfs" }
```

### Branch 2: VFS tarball paths
```
args.path = "/packages/my-lib.tgz/lib/index"
                │
                ▼
        isTarballPath(args.path) → true
                │
                ▼
     findTarballSplitInPathname(args.path)
       → { tarballPath: "/packages/my-lib.tgz", subpath: "/lib/index" }
                │
                ▼
     getOrCreateMount(tarballPath) → fetchAndExtractTarball(vfsPath) → read via getFile() → extract to VFS
                │
                ▼
     resolvePackageEntry(manifest, subpath, conditions) → "./lib/index.js"
                │
                ▼
     Return { path: "/__tarballs__/<hash>/lib/index.js", namespace: "vfs" }
```

### Branch 3: Self-reference imports from within extracted tarballs
```
args.path = "drizzle-orm"  (bare import from inside /__tarballs__/<hash>/...)
                │
                ▼
     Importer is inside /__tarballs__/<hash>/ → find mount by hash
                │
                ▼
     Mount manifest.name matches "drizzle-orm" → self-reference
                │
                ▼
     resolvePackageEntry(manifest, "", conditions) → entry point within same mount
```

### Plugin order requirement

The TarballPlugin **must be registered before VirtualFileSystemPlugin** in [core/build.ts](../../core/build.ts).
Without this ordering, a VFS path like `/packages/my-lib.tgz` would be claimed by VFS as a raw
blob before the TarballPlugin could intercept and extract it.

### `fetchAndExtractTarball()` — dual source support

`fetchAndExtractTarball(source, ...)` accepts two kinds of sources:
- **HTTP URL** (string starting with `http://` or `https://`) — fetched via `fetchWithCache`
- **VFS path** (anything else) — reads raw bytes via `getFile()`, wraps in `new Response(bytes)`

Both codepaths then feed into the same `detectArchiveFromResponse()` → decompress → untar pipeline.

## Scenarios

### 19.3 — npm registry tarball, root import
```ts
import { sql } from "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz";
```
- Detected via `.tgz` extension
- No subpath → resolves via `exports["."]` or `main`

### 19.4 — npm registry tarball, subpath import
```ts
import { useMigrations } from "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator";
```
- subpath = `/expo-sqlite/migrator`
- Resolves via `exports["./expo-sqlite/migrator"]`

### 19.5 — Scoped package tarball
```ts
import { useQuery } from "https://registry.npmjs.org/@tanstack/react-query/-/react-query-5.0.0.tgz";
```
- Scoped packages use `/@scope/name/-/name-version.tgz` pattern
- Same detection and parsing applies

### 19.6 — GitHub release tarball
```ts
import { helper } from "https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz";
```
- `.tar.gz` extension detected
- Same extraction path, different origin

### 19.7 — Multiple imports from same tarball
```ts
import { sql } from "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz";
import { drizzle } from "https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite";
```
- Both imports share the same mount (deduplication via `getTarballKey`)
- Different subpaths resolve to different entry points

### 19.7a — Implicit package-root fallback inside tarballs

When a tarball package has no usable `exports`, `main`, `module`, or `browser`
entry, shared resolution returns the historical `./index.js` placeholder plus
`usedDefaultRootFallback = true`.

TarballPlugin does **not** treat that as a literal filename. Instead it probes
from the extracted package root using bundlejs's bounded CommonJS-style fallback:
- `index.js`
- `index.json`

This is what allows `spdx-exceptions`-style tarball packages and extensionless
`main: "./index"` tarball packages to land on `index.json` without turning
every explicit `index.js` path into a directory probe.

### 19.8 — Self-reference from within extracted tarball
If `drizzle-orm/expo-sqlite/index.js` contains:
```ts
import { sql } from "drizzle-orm";
```
The existing self-reference handling in `TarResolution` detects that the importer
is inside the same tarball and resolves against the mount's manifest.

### 19.9 — Content-type flexibility
npm registry returns `application/octet-stream` for `.tgz` downloads.
The old code had a hard check for `application/tar+gzip` content-type.
Now removed — `detectArchiveFromResponse()` (magic-byte based) is authoritative.

### 19.10 — Non-tarball `.tgz` URL (edge case)
If a URL contains `.tgz` but isn't actually a tarball (extremely rare),
`detectArchiveFromResponse()` will detect the mismatch and throw with
a diagnostic explaining what was expected vs. what was found.

### 19.11 — VFS tarball, root import
```ts
// Pre-populate VFS with a tarball file, then import from it
import { helper } from "/packages/my-lib.tgz";
```
- Detected via `isTarballPath()` — absolute VFS path with `.tgz` extension
- `fetchAndExtractTarball()` reads raw bytes via `getFile()` instead of HTTP fetch
- Extracts to `/__tarballs__/<hash>/`, resolves via `exports["."]` or `main`

### 19.12 — VFS tarball, subpath import
```ts
import { migrator } from "/packages/my-lib.tgz/utils/migrator";
```
- `findTarballSplitInPathname()` splits at `.tgz` → tarball path + subpath
- Same extraction and resolution pipeline as HTTP tarballs

### 19.13 — Relative VFS tarball path (from inside VFS)
```ts
// Importer is at /src/index.ts in VFS
import { fn } from "../vendor/my-lib.tgz";
```
- TarballPlugin resolves the relative path against the importer's directory
- Only absolute paths enter the tarball pipeline (relative paths are resolved first)

## Changes Made

| File | Change |
|------|--------|
| `core/plugins/tar.ts` | `findTarballSplitInPathname()` — walks path segments, delegates to `detectArchiveFromPathHint()` |
| `core/plugins/tar.ts` | `isTarballPath()` — NEW path-based counterpart to `isTarballUrl()` |
| `core/plugins/tar.ts` | `isTarballUrl()` — CDN-style check OR delegates to `isTarballPath()` |
| `core/plugins/tar.ts` | `parseGenericTarballUrl()` — uses `findTarballSplitInPathname()` instead of custom regex |
| `core/plugins/tar.ts` | `fetchAndExtractTarball()` — generalized to accept both HTTP URLs and VFS paths |
| `core/plugins/tar.ts` | `TarResolution()` — 3 branches: HTTP URLs, VFS paths, self-references |
| `core/plugins/tar.ts` | Removed `ALL_TAR_EXTENSIONS`, `TARBALL_EXT_IN_PATH_RE`, `TARBALL_SPLIT_RE` constants |
| `core/plugins/tar.ts` | Removed redundant content-type check |
| `core/build.ts` | Plugin order: TarballPlugin moved before VirtualFileSystemPlugin |
| `core/utils/cdn-format.ts` | Added `"registry"` CDN style, `"npm"` / `"npm.registry"` / `"jsr.registry"` schemes |
| `core/plugins/cdn.ts` | REGISTRY_CDN branch for tarball-based bare import resolution |
| `core/plugins/cdn.ts` | Scoped package manifest fetch uses CDN-native URL (no `%2f` encoding) |
| `core/plugins/cdn.ts` | Scoped registry support via `getRegistryForPackage()` / `.npmrc` config |
| `core/plugins/http.ts` | Registry mode propagation — registry host takes priority over CDN-follows-parent |
| `utils/npm-search.ts` | `getPackageOfVersion()` — scoped package fallback to full packument |
| `utils/npm-search.ts` | `getNpmTarballUrl()`, `getPackageTarballUrl()` — tarball URL construction |
| `utils/npmrc.ts` | NEW — `.npmrc` parser, `getRegistryForPackage()`, `normalizeRegistryConfig()` |
| `core/types.ts` | `BuildConfig.registry` — accepts string or `RegistryConfig` |

## Registry Tarball Mode

### Overview

When `cdn: "npm.registry"` (or `cdn: "npm"`) is set, **all bare imports** are resolved
by fetching whole-package tarballs from `registry.npmjs.org` instead of individual files
from a CDN like unpkg.com or esm.sh.

```
┌───── User code ──────┐          ┌─── Registry ────┐
│ import "react"       │ ──────▶  │ registry.npmjs  │
│ import "@scope/pkg"  │          │   .org/react/-  │
└──────────────────────┘          │  /react-18.tgz  │
                                  └────────┬────────┘
                                           │ extract
                                           ▼
                                  ┌─── VFS mount ────┐
                                  │  /__tarballs__/  │
                                  │    <hash>/...    │
                                  │  resolve via     │
                                  │  exports/main    │
                                  └──────────────────┘
```

### Why use registry mode?

- **Fewer HTTP requests**: Large packages with many internal imports (lodash-es, @aws-sdk/*)
  generate hundreds of individual HTTP fetches in CDN mode. Registry mode collapses this
  into a single tarball download + local VFS resolution.
- **Exact npm parity**: Uses the exact same files that `npm install` would produce.
- **No CDN quirks**: Eliminates CDN-specific redirect/resolution differences.

### Transitive dependency propagation

When registry mode is active, **all** bare imports from within extracted tarballs also
resolve through the registry. The flow:

1. CdnPlugin resolves bare import → REGISTRY_CDN branch → tarball extraction → VFS
2. esbuild encounters bare imports in extracted files → back to CdnPlugin
3. CdnPlugin still has the registry origin → REGISTRY_CDN branch again

HttpResolution also respects registry mode: when the configured host is a registry CDN,
it takes priority over the CDN-follows-parent behavior, ensuring all transitive deps
flow through the registry.

### Scoped package `%2f` encoding issue

The npm registry API requires scoped package names to encode `/` as `%2f` in URL paths:
```
GET /@scope%2fname            ← works (packument)
GET /@scope%2fname/1.0.0      ← may fail on some registries/proxies
```

Some HTTP infrastructure (Cloudflare, Nginx, etc.) decodes `%2f` before routing, turning
the 2-segment path into 3 segments and breaking the registry router.

**Fix**: Two complementary strategies:
1. **CDN mode** (`NPM_CDN`): For scoped packages, the manifest variant uses the CDN-native
   URL format (`@scope/name@version/package.json`) instead of the registry API endpoint.
2. **`getPackageOfVersion()`**: When the version-specific endpoint fails for a scoped
   package, falls back to fetching the full packument and extracting the version from
   `pkg.versions[version]`.

## `.npmrc` Support

### Scoped registries

The `registry` config in `BuildConfig` accepts:
- A string: default registry URL or raw `.npmrc` content
- A `RegistryConfig` object with optional `scopedRegistries`

```ts
// Structured config
{
  cdn: "npm.registry",
  registry: {
    scopedRegistries: {
      "@jsr": "https://npm.jsr.io",
      "@mycompany": "https://npm.mycompany.com/"
    }
  }
}

// Or raw .npmrc content
{
  cdn: "npm.registry",
  registry: "@jsr:registry=https://npm.jsr.io\n@mycompany:registry=https://npm.mycompany.com/"
}
```

### Resolution order

For each bare import, `getRegistryForPackage()` checks:
1. Scoped registry override (by `@scope` prefix)
2. Default registry from config
3. Fallback to npm public registry (`https://registry.npmjs.org`)
