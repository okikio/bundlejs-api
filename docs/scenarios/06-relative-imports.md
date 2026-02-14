# Scenario 06 — Relative Imports, CDN Redirects, and Extension Probing

> Tests how the HttpPlugin resolves relative imports inside CDN-fetched modules, handles CDN redirects, and probes for missing extensions.


## 6.1 — Relative import resolved against final (post-redirect) URL

**What it tests:** CDNs frequently redirect. The HttpPlugin uses the *final* URL (after redirects) as the base for resolving relative imports.

**Package:** `react@19.0.0`

```
/?q=react@19.0.0&config={"cdn":"esm.sh"}
```

When `esm.sh` serves `react@19.0.0`, the initial URL may redirect. For example:

```
Request:  https://esm.sh/react@19.0.0
Redirect: https://esm.sh/react@19.0.0/es2022/index.js
```

Inside `index.js`:
```javascript
export { useState } from "./hooks.js";
```

Expected: `"./hooks.js"` is resolved against the **final URL** `https://esm.sh/react@19.0.0/es2022/index.js` → `https://esm.sh/react@19.0.0/es2022/hooks.js`.

If the resolver used the *original* URL (`https://esm.sh/react@19.0.0`), it would try `https://esm.sh/react@19.0.0/hooks.js` — wrong directory.

**Regression signal:** If relative imports 404 on CDNs that redirect (especially esm.sh, which restructures output directories), the resolver is using the pre-redirect URL.


## 6.2 — Extension probing for extensionless imports

**What it tests:** When an internal import has no file extension, the HttpPlugin probes up to 18 combinations.

The probe matrix:
```
  2 path variants ("", "/index")
  × 9 extensions (.js, .mjs, .ts, .tsx, .cjs, .jsx, .mts, .cts, "")
  = 18 total probes
```

**Package:** Many packages have extensionless internal imports (common in webpack-built packages).

```
/?q=events@3.3.0
```

The `events` package has `"main": "./events.js"`. If internal code does:
```javascript
import { EventEmitter } from "./events";
```

Expected: the HttpPlugin tries `./events.js`, `./events.mjs`, `./events.ts`, etc., and `./events/index.js`, `./events/index.mjs`, etc. The first successful HEAD response wins.

**Regression signal:** If extensionless imports always fail with 404s, extension probing is broken.


## 6.3 — Failed probes are cached

**What it tests:** The `failedExtensionChecks` set prevents repeating HEAD requests for URLs that already 404'd.

When resolving `import "./nonexistent"` inside a package:

Expected: the HttpPlugin probes 18 combinations. Each failed probe is added to `failedExtensionChecks`. If the same extensionless path is imported from another file, the cached failures avoid redundant network requests.

**Regression signal:** If network logs show the same 404 URL being fetched multiple times, the negative cache is not working.


## 6.4 — Relative import with absolute path inside HTTP module

**What it tests:** An absolute path import (starting with `/`) inside an HTTP-fetched module is resolved against the CDN origin.

If code inside `https://unpkg.com/react@19.0.0/index.js` does:
```javascript
import init from "/shared/init.js";
```

Expected: resolved as `https://unpkg.com/shared/init.js` (against the origin, not the package path).

**Regression signal:** If absolute imports inside HTTP modules produce resolution errors, the absolute-path handling in `HttpResolution` is broken.


## 6.5 — Bare import inside HTTP module delegates to CdnPlugin

**What it tests:** When an HTTP-fetched module does `import "lodash"` (a bare import), the HttpPlugin delegates to `CdnResolution` instead of trying to resolve it as a URL.

**Package:** Any package with transitive dependencies.

```
/?q=axios@1.7.9
```

When `axios` internally imports `follow-redirects` or `form-data`:

Expected: the bare import `"follow-redirects"` is detected by `isBareImport()` → delegated to `CdnResolution()` → resolved against the CDN as a fresh package.

**Regression signal:** If bare imports inside HTTP modules cause 404s (the HttpPlugin trying to resolve `"follow-redirects"` as a relative path), the delegation to CdnResolution is broken.


## 6.6 — `new URL("...", import.meta.url)` asset discovery

**What it tests:** PackagePlugin's HTTP `onLoad` handler scans fetched source for `new URL("...", import.meta.url)` patterns to discover WASM files and web workers.

**Use case:** Packages that load WASM binaries or web workers at runtime use this pattern. The bundler needs to fetch these assets alongside the module.

**Synthetic example:**

```javascript
const wasmUrl = new URL("./processor.wasm", import.meta.url);
const worker = new Worker(new URL("./worker.js", import.meta.url));
```

Expected: PackagePlugin's HTTP `onLoad` handler extracts `"./processor.wasm"` and `"./worker.js"` from the pattern, resolves them against the module's URL, fetches them, and adds them to the `assets` array.

**Regression signal:** If WASM/worker assets are missing from the build output, the URL pattern scanning is broken.


## 6.7 — JSR specifier inside HTTP module

**What it tests:** When an HTTP-fetched module uses a JSR specifier like `import "jsr:@std/encoding"`, the HttpPlugin detects it via `looksLikeJSRSpec()` and delegates to CdnResolution.

```
/?q=jsr:@std/path@1.0.0
```

If the resolved `mod.ts` file internally imports another JSR package:
```typescript
import { encodeBase64 } from "jsr:@std/encoding";
```

Expected: `looksLikeJSRSpec("jsr:@std/encoding")` returns `true` → delegated to `CdnResolution` → JSR resolution path.

**Regression signal:** If JSR specifiers inside HTTP modules cause errors (treated as bare imports that cannot be found on npm), the JSR detection in the HttpPlugin is missing.


## 6.8 — `#`-prefixed imports inside HTTP modules

**What it tests:** Private imports (`#internal`) inside HTTP-fetched packages are delegated to CdnResolution for resolution against the importer's manifest.

**Package:** `chalk@5.4.1`

```
/?q=chalk@5.4.1
```

When chalk's source does `import color from "#supports-color"`:

Expected: the `#` prefix is detected by the regex `/^#/` in HttpResolution → delegated to `CdnResolution` → resolved through the `imports` field of chalk's `package.json`.

**Regression signal:** If `#`-prefixed imports inside HTTP modules produce "not found" errors, the delegation to CdnResolution is missing the `#` pattern check.
