# Scenario 08 — Non-npm Resolution (JSR, Tarballs, Import Maps)

> Tests resolution paths that bypass the standard npm CDN pipeline — JSR registry, tarball extraction, and import map remapping.


## JSR Resolution

> **[JSR](https://jsr.io)** (JavaScript Registry) is a TypeScript-first package registry. Key differences from npm: `.ts` source files served directly, scoped by default (`@scope/name`), semver-native resolution via JSON API. See [JSR API docs](https://jsr.io/docs/api).


### 8.1 — Basic JSR import

**What it tests:** The `jsr:` prefix triggers a completely different resolution path from npm.

**Package:** `jsr:@std/path@1.0.0`

```
/?q=jsr:@std/path@1.0.0
```

Expected resolution:
1. CdnPlugin detects `jsr:` prefix
2. `parseJSRSpec()` → scope: `std`, name: `path`, version: `1.0.0`
3. Fetches `https://jsr.io/@std/path/1.0.0_meta.json`
4. Resolves `"."` through the JSR `exports` map → `./mod.ts`
5. Final URL: `https://jsr.io/@std/path/1.0.0/mod.ts`

**Regression signal:** If the resolver tries to fetch from `https://unpkg.com/jsr:@std/path` (treating it as an npm package), JSR detection is broken.


### 8.2 — JSR with semver range

**What it tests:** JSR version resolution for `^` and `~` ranges against the registry API.

```
/?q=jsr:@std/path@^1.0.0
```

Expected: the resolver calls `https://jsr.io/@std/path/meta.json` → gets all versions → finds the highest matching non-yanked version for `^1.0.0` (e.g., `1.1.4`) → uses that version.

**Regression signal:** If the exact string `^1.0.0` appears in the resolved URL (not resolved to a concrete version), semver resolution is broken.


### 8.3 — JSR with subpath export

**What it tests:** JSR packages can have subpath exports, resolved through the version metadata's `exports` field.

```
/?q=jsr:@std/path@1.0.0/posix
```

Expected: version metadata contains `{ "exports": { ".": "./mod.ts", "./posix": "./posix/mod.ts" } }` → resolves `"./posix"` → `./posix/mod.ts` → `https://jsr.io/@std/path/1.0.0/posix/mod.ts`.

**Regression signal:** If subpath imports from JSR packages resolve to the root `mod.ts` instead of the subpath, the exports resolution for JSR is not applying.


### 8.4 — JSR fallback to esm.sh proxy

**What it tests:** When direct JSR resolution fails (network error, 404, etc.), bundlejs falls back to `esm.sh`'s JSR proxy.

Expected fallback URL: `https://esm.sh/jsr/@std/path@1.0.0`.

**Regression signal:** If JSR resolution fails hard (no fallback), the esm.sh proxy fallback is missing.


### 8.5 — JSR TypeScript source handling

**What it tests:** JSR packages serve TypeScript (`.ts`) source files directly. The bundler must handle TypeScript without a separate compile step.

```
/?q=jsr:@hono/hono@4.11.9
```

Expected: the resolved file is `.ts` → esbuild's TypeScript loader handles it natively. No transpile errors.

**Regression signal:** If TypeScript files from JSR produce syntax errors, esbuild's loader is not being set correctly for `.ts` files from JSR URLs.


---

## Tarball Extraction

> bundlejs supports tarball-based package sources via the TarballPlugin. Currently routes URLs from [pkg.pr.new](https://pkg.pr.new). The tarball is fetched, decompressed, extracted into VFS under `/__tarballs__/<sha256-hash>/`, and resolved through `exports`/legacy fields.


### 8.6 — Tarball from pkg.pr.new

**What it tests:** The full tarball pipeline — fetch, detect format, decompress, extract to VFS, resolve entry.

```
/?q=@tanstack/react-query&config={"package.json":{"dependencies":{"@tanstack/react-query":"https://pkg.pr.new/@tanstack/react-query@7988"}}}
```

Expected:
1. CdnPlugin classifies `https://pkg.pr.new/...` as `UrlSpec`
2. TarballPlugin intercepts → `getCDNStyle()` returns `"tarball"`
3. Fetches `.tgz` → gzip detection → decompress → extract
4. Files written to VFS at `/__tarballs__/<hash>/`
5. Reads extracted `package.json` → resolves entry point
6. Returns VFS path to the entry

**Regression signal:** If tarball URLs produce a resolution error instead of extracting, the TarballPlugin routing or extraction pipeline is broken.


### 8.7 — Tarball content-addressed caching

**What it tests:** The same tarball URL is only fetched once per build, even if multiple dependencies reference it.

If two packages both depend on the same tarball URL:

Expected: the first resolution fetches and extracts. The second resolution finds `/__tarballs__/<hash>/` already in VFS → skips fetch.

**Regression signal:** If the same tarball is fetched twice (visible in network logs), the VFS mount check or hash computation is broken.


### 8.8 — Tarball self-reference imports

**What it tests:** Code inside an extracted tarball that imports itself by package name resolves against the local VFS mount, not the CDN.

If `@tanstack/react-query` tarball code does:
```javascript
import { QueryClient } from "@tanstack/react-query";
```

Expected: the TarballPlugin detects that the import path matches `manifest.name` → resolves against the local VFS mount instead of fetching from CDN.

**Regression signal:** If self-references inside tarballs trigger CDN fetches (potentially fetching a *different* version than the tarball), the self-reference detection is broken.


---

## Import Maps

> [Import maps](https://html.spec.whatwg.org/multipage/webappapis.html#import-maps) are a WHATWG HTML standard that remap bare specifiers without a bundler. bundlejs supports them for remapping package names and scoping overrides.


### 8.9 — Basic import map remapping

**What it tests:** A bare import is remapped to a different URL via the `imports` section.

```json
{
  "imports": {
    "lodash": "https://esm.sh/lodash-es@4.17.21",
    "react": "https://esm.sh/preact@10.24.0/compat"
  }
}
```

When user code does `import { debounce } from "lodash"`:

Expected: import map rewrites `"lodash"` → `"https://esm.sh/lodash-es@4.17.21"` → HttpPlugin handles the URL.

When user code does `import { useState } from "react"`:

Expected: `"react"` → `"https://esm.sh/preact@10.24.0/compat"` → Preact's compat layer is bundled instead of React.

**Regression signal:** If the original packages (lodash, react) are fetched despite the import map, the map is not being consulted.


### 8.10 — Scoped import map overrides

**What it tests:** The `scopes` section overrides imports for specific URL prefixes.

```json
{
  "imports": {
    "react": "https://esm.sh/react@19.0.0"
  },
  "scopes": {
    "/vendor/": {
      "react": "https://esm.sh/react@18.3.0"
    }
  }
}
```

Expected: code at a path matching `/vendor/` gets `react@18.3.0`. Code elsewhere gets `react@19.0.0`.

The spec requires scopes to be sorted by key length (longest first). If `/vendor/lib/` and `/vendor/` both exist, longer matches take priority.

**Regression signal:** If all code gets the same version regardless of scope, scope matching is broken.


### 8.11 — Import map prefix matching

**What it tests:** Import map keys ending with `/` act as prefix matchers.

```json
{
  "imports": {
    "lodash/": "https://esm.sh/lodash-es@4.17.21/"
  }
}
```

When user code does `import debounce from "lodash/debounce"`:

Expected: prefix `"lodash/"` matches → appends the remainder → `"https://esm.sh/lodash-es@4.17.21/debounce"`.

**Regression signal:** If prefix matching does not work (only exact matches), the `/`-suffix key handling is broken.
