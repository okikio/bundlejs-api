# Scenario 13 — CDN Format, Loader, Filesystem & Plugin Utility Correctness

> Unit-level tests for the utility modules that back the plugin pipeline. These are pure-function tests (no network, no builds) that verify inputs → outputs for every utility consumed by plugins.

```
  ┌─────────────────────────┐
  │  Plugin Pipeline Utils  │
  │                         │
  │  cdn-format.ts          │ ← CDN style detection, URL generation
  │  loader.ts              │ ← extension → esbuild loader mapping
  │  side-effects.ts        │ ← sideEffects field computation
  │  cdn-resolution.ts      │ ← path normalization, entry resolution
  │  filesystem.ts          │ ← virtual FS CRUD, validation
  │  plugins/fs.ts          │ ← VFS path resolution & probing
  │  plugins/alias.ts       │ ← alias detection
  │  plugins/external.ts    │ ← node builtin & custom externals
  │  plugins/tar.ts         │ ← tarball URL parsing
  │  utils/url.ts           │ ← URL joining, encoding
  │  utils/path.ts          │ ← bare import detection
  └─────────────────────────┘
```


## 13.1 — CDN Style Detection (`getCDNStyle`)

**What it tests:** Classifying a URL or scheme string into one of `npm | jsr | github | deno | tarball | other`.

**Key behaviors:**
- Scheme prefixes (`esm:`, `jsr:`, `github:`, etc.) route to the correct style
- Full URL patterns (`https://esm.sh/...`, `https://jsr.io/...`) are recognized
- `jsdelivr.gh:` is detected as `github`, not `npm` (requires the npm scheme regex to demand a colon — see Bug Fix 13.1a below)
- Bare package names and unknown URLs default to `"other"`

**Bug Fix 13.1a — `jsdelivr.gh:` misclassified as npm:**

The original npm scheme regex used `\:?` (optional colon):

```
/^(skypack|esm|esm\.sh|unpkg|jsdelivr|esm\.run)\:?/
```

This caused `jsdelivr.gh:user/repo` to match `jsdelivr` (8 chars) at position 0,
with the colon being optional. The more-specific github check for `^(jsdelivr\.gh|github)` never ran because npm matched first.

Fix: require the colon → `\:` instead of `\:?`.

**Regression signal:** If `getCDNStyle("jsdelivr.gh:user/repo")` returns `"npm"`, the npm regex is too greedy again.


## 13.2 — CDN Origin Resolution (`getCDNOrigin`)

**What it tests:** Mapping an import string to its CDN origin URL (with trailing `/`).

**Key behaviors:**
- Each scheme prefix maps to a specific origin (e.g., `esm:` → `https://esm.sh/`)
- Bare packages use a configurable default CDN (defaults to `https://unpkg.com/`)
- Custom CDN URLs get a trailing `/` normalized (no double slashes)

**Regression signal:** If origins are wrong, all CDN fetches fail with 404s.


## 13.3 — Pure Import Path (`getPureImportPath`)

**What it tests:** Stripping CDN scheme prefixes and host+path prefixes from URLs.

**Key behaviors:**
- `esm:react@18` → `react@18`
- `https://esm.sh/react@18` → `react@18`
- `https://cdn.jsdelivr.net/npm/vue@3` → `vue@3`
- Bare package names pass through unchanged

**Regression signal:** If stripping fails, package name parsing breaks downstream.


## 13.4 — CDN URL Construction (`getCDNUrl`)

**What it tests:** End-to-end URL construction from an import string.

Returns `{ import, path, origin, cdn, url }`:
- `import`: original string
- `path`: pure path (post-stripping)
- `origin`: CDN origin URL
- `url`: full constructed URL object

**Regression signal:** Incorrect URL construction causes all CDN resolution to fail.


## 13.5 — JSR Specifier Parsing (`parseJSRSpecifier`)

**What it tests:** Decomposing `jsr:@scope/name@version/subpath` into structured parts.

**Key behaviors:**
- Extracts scope, name, version, subpath
- Returns `null` for non-JSR specifiers
- Returns `null` for invalid formats (missing scope, uppercase letters)
- Version and subpath are optional

**Regression signal:** JSR resolution breaks for valid specifiers.


## 13.6 — JSR URL Helpers

**`getJSRDirectUrl(scope, name, version, subpath?)`:**
- Default subpath is `/mod.ts`
- Subpaths without leading `/` get one added

**`getJSRProxyUrl(scope, name, version?, subpath?)`:**
- Constructs `https://esm.sh/jsr/@scope/name@version/subpath`
- Works with and without version

**Regression signal:** JSR resolution constructs wrong URLs.


## 13.7 — Loader Inference (`inferLoader`)

**What it tests:** Mapping file extensions to esbuild loader types.

**Key design decision:** bundlejs treats `.js` as `ts` and `.jsx` as `tsx`. This enables parsing TypeScript syntax and JSX in `.js` files — critical for CDN mode where package source may contain either.

| Extension | Loader | Reason |
|:----------|:-------|:-------|
| `.ts`, `.mts`, `.cts` | `ts` | TypeScript |
| `.tsx` | `tsx` | TypeScript + JSX |
| `.js`, `.mjs`, `.cjs` | `ts` | TS parser handles JS superset |
| `.jsx` | `tsx` | TS parser handles JSX |
| `.css`, `.scss` | `css` | Stylesheets |
| `.json` | `json` | Data |
| `.png`, `.jpeg`, `.ttf` | `dataurl` | Binary assets |
| `.svg`, `.html`, `.txt` | `text` | Text assets |
| `.wasm` | `file` | WebAssembly |
| *(no ext)* | `ts` | Fallback — assume TypeScript |
| *(unknown)* | `text` | Safe fallback for unknowns |

**Regression signal:** If `.js` → `js` instead of `ts`, TS syntax in CDN packages breaks.


## 13.8 — Side Effects Computation

### `normalizePkgRelPath`
Strips `./`, `/`, query strings, and hash fragments from package-relative paths.

### `isJsLikePath`
Returns `true` for JS/TS extensions, `false` for CSS/JSON/WASM/etc. Extensionless paths return `true` (conservative).

### `normalizeSideEffectsPattern`
- Glob without `/` → prepends `**/` (matches at any depth)
- Glob with `/` → used as-is
- Strips leading `./`, trims whitespace

### `compileSideEffectsMatchers`
Compiles an array of glob strings into regex matchers. Skips non-string entries.

### `computeEsbuildSideEffects`
Core decision function for tree-shaking:

```
  null manifest → undefined (no info, be conservative)
  sideEffects: true → undefined (has side effects)
  sideEffects: false → false, UNLESS path is CSS
  sideEffects: [...] → false if path NOT in list, undefined if IN list
  CSS paths → always undefined (CSS always has side effects in CDN mode)
```

**Regression signal:** If CSS is incorrectly marked side-effect-free, styles are tree-shaken away.


## 13.9 — Path Normalization & Joining (`cdn-resolution.ts`)

### `normalizeResolvedPath`
- `./dist/index.js` → `/dist/index.js`
- `dist/index.js` → `/dist/index.js`
- `/dist/index.js` → `/dist/index.js` (already absolute)

### `joinSubpaths`
Joins two subpath segments with `/`, stripping redundant slashes:
- `("base///", "///extra")` → `"base/extra"`
- `("", "extra")` → `"extra"`

### `applyPathRemapping`
Applies browser/react-native/electron path remappings.
Generates path variants (`./lib/node.js`, `lib/node.js`, `/lib/node.js`) for matching.

### `applyManifestRemappings`
Iterates REMAPPING_FIELDS in priority order: `react-native` > `electron` > `browser`.
Only applies if the matching condition is active. Returns `{ path, excluded, matchedField }`.

**Regression signal:** If the field priority order changes, wrong remapping is applied for multi-platform packages.


## 13.10 — Package Entry Resolution (`resolvePackageEntry`)

**What it tests:** The combined modern + legacy entry resolution algorithm.

1. Try `exports` field first (modern)
2. Fall back to legacy fields (`browser` → `module` → `main`)
3. Apply path remappings to legacy entry points
4. Default to `./index.js` if nothing resolves

**Key behaviors:**
- `exports` always takes priority over legacy fields
- `browser: false` (boolean) excludes the entire package
- `allowLiteralSubpath` uses the subpath directly as a last resort

**Regression signal:** If the exports → legacy fallback chain breaks, half of npm won't resolve.


## 13.11 — Peer Dependencies (`computePeerDependencies`)

**What it tests:** Merging peer dependencies from manifests with version stabilization.

**Key behaviors:**
- Self-peering: always includes `{ [packageName]: packageVersion }`
- Merges `peerDependencies` from both initial and resolved manifests
- `initialDeps` override peer versions (version pinning)
- Non-npm CDN uses `initialDeps` version for self if available

**Regression signal:** Missing peer deps cause "module not found" errors in CDN bundles.


## 13.12 — Virtual Filesystem (`filesystem.ts`)

**What it tests:** The in-memory VFS used for user-supplied files.

**Key behaviors:**
- `isValid`: `null`, `undefined`, `NaN` → `false`; `0`, `""`, `false`, `Uint8Array` → `true`
- Round-trip: `setFile` + `getFile` preserves string and binary content
- `setFile` with `null`/`undefined` content is a no-op (does NOT store)
- `deleteFile` removes files, returns `false` for non-existent
- `hasFile` checks key existence; `fileExists` validates content via `isValid`

**Regression signal:** If `isValid` rejects empty string, empty files are treated as missing.


## 13.13 — VFS Path Resolution (`plugins/fs.ts`)

**What it tests:** `resolveVfsPath` — the extension probing and index fallback algorithm.

```
  resolveVfsPath("/src/index", extensions)
  
  1. Exact match: /src/index         → found? return
  2. Extension probe:
     /src/index.tsx                   → found? return
     /src/index.ts                    → found? return
     /src/index.jsx                   → found? return
     ...
  3. Index fallback (if enabled):
     /src/index/index.tsx             → found? return
     /src/index/index.ts              → found? return
     ...
  4. null (nothing found)
```

**Key behaviors:**
- Extension probing respects `RESOLVE_EXTENSIONS` order (`.tsx` before `.ts`)
- `enableIndexFallback=false` skips the directory/index probing step
- `stripAnyPrefix` normalizes VFS-style paths (`vfs:`, `virtual:`)

**Regression signal:** If extension order is wrong, `.ts` files shadow `.tsx` files.


## 13.14 — Alias Detection (`plugins/alias.ts`)

**What it tests:** `isAlias` — determines if an import should be aliased.

**Key behaviors:**
- Bare imports matching an alias key → returns the key
- Subpath imports (`lodash/get` with alias for `lodash`) → returns `lodash`
- Relative paths (`./local`) → `false` (never aliased)
- `#` imports pass through the guard (they are checked against aliases)
- No match → `undefined`

**Important design note:** The guard condition is:
```ts
if (!isBareImport(id) && !/^#/.test(id) && !looksLikeJSRSpec(id)) return false;
```
This means `#` imports ARE eligible for aliasing — the `!/^#/` check prevents the early `false` return. This is intentional so that subpath imports can be aliased via config.

**Regression signal:** If `#` imports are rejected by isAlias, configured aliases for private imports break.


## 13.15 — External Detection (`plugins/external.ts`)

**What it tests:** `isExternal` — determines if an import is a Node.js builtin or configured external.

**Key behaviors:**
- Node builtins (`fs`, `path`, `crypto`) are external by default
- `node:` prefix is stripped before matching
- Subpaths match parent (`fs/promises` → `fs`)
- Custom externals extend the builtin list
- Non-builtin packages return `undefined`

**Regression signal:** If builtin detection breaks, polyfills aren't applied in browser builds.


## 13.16 — Tarball URL Parsing (`plugins/tar.ts`)

**What it tests:** `parseTarballUrl` — parsing `pkg.pr.new` URLs into structured package info.

**Key behaviors:**
- Compact form: `/@scope/name@version/subpath`
- Non-compact form: `/owner/repo/name@version`
- Missing version → defaults to `"latest"` (configurable)
- Known non-package routes (`template/`, `badge/`) → throw or return empty with `ignoreError`
- Query and hash are stripped from `packageUrl`

**`stripPackagePrefix`:**
- Strips `package/` prefix from tarball paths
- `"package/dist/index.js"` → `"dist/index.js"`
- `"package"` (without `/`) → unchanged

**Regression signal:** If tarball parsing breaks, PR preview builds fail.


## 13.17 — URL Utilities (`utils/url.ts`)

### `encodeWhitespace`
Encodes spaces → `%20`, tabs → `%09`. Non-whitespace unchanged.

### `urlJoin`
Joins URL segments using `new URL()` resolution:
- `urlJoin("https://esm.sh/react@18/index.js", "../utils.js")` → `".../utils.js"` (parent nav works)

### `toURLPath`
Converts a URL to a filesystem-safe path: `"https://esm.sh/react"` → `"/esm_sh/react"` (dots → underscores in host).

**Regression signal:** If `urlJoin` doesn't handle `../`, relative imports inside CDN packages break.


## 13.18 — Bare Import Detection (`utils/path.ts`)

**What it tests:** `isBareImport` — distinguishes package specifiers from relative/absolute/special paths.

| Input | Result | Reason |
|:------|:-------|:-------|
| `react` | `true` | Simple package |
| `@scope/pkg` | `true` | Scoped package |
| `node:fs` | `true` | Syntactically bare (handled by other plugins) |
| `./local` | `false` | Relative path |
| `../up` | `false` | Relative path |
| `/absolute` | `false` | Absolute path |
| `#internal` | `false` | Subpath import (special resolution) |
| `data:...` | `false` | Data URL |

**Regression signal:** If `#` imports are classified as bare, they go through npm resolution instead of subpath import resolution.
