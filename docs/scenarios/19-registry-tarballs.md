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

## Detection: `isTarballUrl()`

Previously: `getCDNStyle(url.origin) === "tarball"` — only matched `pkg.pr.new`.

Now two categories:
1. **CDN-style** — `getCDNStyle()` returns `"tarball"` (pkg.pr.new)
2. **Extension-based** — delegated to `archive-detect`'s `detectArchiveFromPathHint()`

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
     getOrCreateMount(packageUrl) → fetch, extract to VFS
                │
                ▼
     resolvePackageEntry(manifest, subpath, conditions) → "./expo-sqlite/migrator.js"
                │
                ▼
     Return { path: "/__tarballs__/<hash>/expo-sqlite/migrator.js", namespace: "vfs" }
```

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

## Changes Made

| File | Change |
|------|--------|
| `core/plugins/tar.ts` | `findTarballSplitInPathname()` — walks path segments, delegates to `detectArchiveFromPathHint()` |
| `core/plugins/tar.ts` | `isTarballUrl()` — uses `findTarballSplitInPathname()` instead of custom regex |
| `core/plugins/tar.ts` | `parseGenericTarballUrl()` — uses `findTarballSplitInPathname()` instead of custom regex |
| `core/plugins/tar.ts` | Removed `ALL_TAR_EXTENSIONS`, `TARBALL_EXT_IN_PATH_RE`, `TARBALL_SPLIT_RE` constants |
| `core/plugins/tar.ts` | `TarResolution()` — routes between parsers based on URL type |
| `core/plugins/tar.ts` | `fetchAndExtractTarball()` — removed redundant content-type check |
