# Scenario 11 — Edge Cases, Errors, and Stress Tests

> Tests error handling, unsupported dependency types, cyclic dependencies, aliasing, and other corner cases that push bundlejs to its limits.


## Unsupported Dependency Types

> `parseNpmSpec()` classifies every dependency version. Some types require filesystem or git access that bundlejs does not have.


### 11.1 — `git:` dependency produces clear error

**What it tests:** Git-based dependencies are rejected with an informative error.

```
/?q=test-git&config={"package.json":{"dependencies":{"test-git":"github:user/repo#semver:^1.0.0"}}}
```

Expected: `parseNpmSpec()` classifies as `git` type → CdnPlugin returns a descriptive error explaining that git dependencies are not supported in a CDN/edge environment.

**Regression signal:** If this silently succeeds (fetching something unexpected from a CDN) or crashes, the git spec detection is broken.


### 11.2 — `workspace:` dependency produces clear error

**What it tests:** Workspace protocol dependencies are rejected.

```
/?q=test-ws&config={"package.json":{"dependencies":{"test-ws":"workspace:*"}}}
```

Expected: classified as unsupported → clear error.

**Regression signal:** If the resolver tries to fetch `workspace:*` as a version string from npm, the workspace protocol detection is missing.


### 11.3 — `link:` dependency produces clear error

```
/?q=test-link&config={"package.json":{"dependencies":{"test-link":"link:../sibling"}}}
```

Expected: rejected with an error explaining that `link:` requires local filesystem access.


---

## Aliasing

### 11.4 — npm alias unwrapping

**What it tests:** The `npm:` prefix in dependency versions aliases one package to another.

```
/?q=my-react&config={"package.json":{"dependencies":{"my-react":"npm:preact@10.25.4"}}}
```

With entry code: `export * from "my-react";`

Expected: `parseNpmSpec("npm:preact@10.25.4")` → `AliasSpec` → CdnPlugin unwraps → `effectiveName = "preact"`, `effectiveVersion = "10.25.4"` → fetches preact from CDN.

**Regression signal:** If the resolver tries to fetch a package literally named `my-react` from npm, alias unwrapping is broken.


### 11.5 — AliasPlugin rewrites before other plugins

**What it tests:** The AliasPlugin (registered first in the plugin chain) rewrites import paths before any resolution happens.

```
/?q=preact@10.25.4&config={"alias":{"react":"preact/compat"}}
```

With entry code: `export { useState } from "react";`

Expected: AliasPlugin rewrites `"react"` → `"preact/compat"` → CdnPlugin resolves `preact/compat` → fetches from CDN. The bundle contains Preact, not React.

**Regression signal:** If React is fetched despite the alias, the AliasPlugin is not intercepting before CdnPlugin.


### 11.6 — Nested alias rejection

**What it tests:** `npm:npm:foo` (nested alias) is explicitly rejected.

```
/?q=test-nested&config={"package.json":{"dependencies":{"test-nested":"npm:npm:foo@1.0.0"}}}
```

Expected: rejected with an error.

**Regression signal:** If nested aliases are silently unwrapped (attempting to fetch `npm:foo` as a package name), the double-alias detection is missing.


---

## Cyclic Dependencies

### 11.7 — Simple peer dependency cycle

**What it tests:** bundlejs handles packages where A depends on B which peer-depends on A.

**Package:** `react@19.0.0` + `react-dom@19.0.0`

```
/?q=react-dom@19.0.0
```

`react-dom` peer-depends on `react`. When resolving `react-dom`, the resolver encounters `react` as a peer dependency → adds it to the resolution context via `computePeerDependencies()` → resolves `react` normally.

Expected: both packages are bundled without infinite loops. The `computePeerDependencies()` function adds the current package to the peer deps map (cyclic dependency handling).

**Regression signal:** If the resolution hangs or produces a stack overflow, cyclic dependency handling is broken.


### 11.8 — Tightly coupled dependency web

**What it tests:** Angular-style dependency networks where many packages peer-depend on each other.

```
/?q=@angular/common@19.1.4
```

`@angular/common` peer-depends on `@angular/core`. `@angular/core` peer-depends on `rxjs` and `zone.js`. This creates a multi-node dependency graph.

Expected: resolution completes without loops. Each package is fetched once and version-pinned through peer deps.

**Regression signal:** If the resolver enters an infinite loop fetching the same package repeatedly, the cyclic dependency detection (via `peerDependencies[packageName]` self-entry) is not working.


---

## Error Handling

### 11.9 — Nonexistent package

**What it tests:** Requesting a package that does not exist on npm.

```
/?q=this-package-does-not-exist-12345
```

Expected: CdnPlugin tries to fetch `package.json` → 404 → returns a clear error: "Package not found."

**Regression signal:** If the error is cryptic or the request hangs, 404 handling for missing packages is broken.


### 11.10 — Nonexistent version

**What it tests:** Requesting a version that does not exist.

```
/?q=react@999.0.0
```

Expected: CDN returns 404 for `react@999.0.0/package.json` → clear error about version not found.

**Regression signal:** If the resolver silently falls back to `latest` or hangs, version 404 handling is broken.


### 11.11 — Empty package (no JS files)

**What it tests:** A package that has a `package.json` but no actual JavaScript files.

```
/?q=test-empty&config={"package.json":{"name":"test-empty","version":"1.0.0","main":"./index.js"}}
```

With no VFS file at `/index.js`:

Expected: the entry point resolves to a URL → PackagePlugin's HTTP `onLoad` handler tries to fetch it → 404 → clear error.

**Regression signal:** If empty packages silently produce empty bundles (no error), the 404 handling for entry point files is missing.


---

## Stress Tests

### 11.12 — Package with many transitive dependencies

**What it tests:** bundlejs can handle deep dependency trees without timeouts or memory exhaustion.

```
/?q=webpack@5.96.1
```

Webpack has hundreds of transitive dependencies. This pushes the resolution and fetching pipeline to its limits.

Expected: completes (eventually) with a large bundle size. All transitive dependencies are resolved and fetched.

**Regression signal:** If the build times out or runs out of memory, there may be a leak in the resolution cache or unbounded concurrent fetches.


### 11.13 — Multiple packages in one query

**What it tests:** Comma-separated packages in the `q` parameter.

```
/?q=react@19.0.0,react-dom@19.0.0,preact@10.25.4
```

Expected: each package is resolved independently. The final bundle contains all three. Shared dependencies (if any) are deduplicated by esbuild.

**Regression signal:** If only the first package is bundled or packages interfere with each other's resolution, the multi-package parsing is broken.


### 11.14 — Very deep exports nesting

**What it tests:** Exports conditions nested beyond what's seen in real packages.

Synthetic:

```json
{
  "exports": {
    ".": {
      "browser": {
        "production": {
          "import": {
            "default": "./dist/browser.prod.esm.js"
          }
        },
        "default": "./dist/browser.esm.js"
      },
      "default": "./dist/index.js"
    }
  }
}
```

Expected: with `browser` + `production` conditions → resolves through 4 levels → `./dist/browser.prod.esm.js`.

**Regression signal:** If the resolver cannot handle deeply nested conditions (returns the wrong level's `default`), there is a maximum nesting depth issue.


### 11.15 — Special characters in package names

**What it tests:** Scoped packages with unusual (but valid) characters.

```
/?q=@anthropic-ai/sdk@1.0.0
```

Expected: scoped packages with hyphens resolve correctly. The `@` and `/` are handled in URL encoding.

```
/?q=@anthropic-ai/sdk@1.0.0/streaming
```

Expected: subpath exports resolve correctly for packages with complex scoped names.

**Regression signal:** If URL encoding breaks scoped package names, the CDN URL construction has an encoding bug.


---

## VFS Interaction

### 11.16 — VFS file takes precedence over CDN

**What it tests:** Files in the virtual filesystem are resolved before CDN fetches.

The VirtualFileSystemPlugin runs before HttpPlugin and CdnPlugin. A file at `/my-module.js` in VFS should shadow any CDN module with the same path.

Expected: `import "/my-module.js"` → VFS finds it → resolved from memory, no network request.

**Regression signal:** If VFS files are ignored and the resolver falls through to CDN, plugin ordering is wrong.


### 11.17 — Relative imports between VFS files

**What it tests:** Relative imports between VFS files resolve within VFS, not delegating to HTTP.

```javascript
// /index.tsx (VFS)
import { utils } from "./utils.ts";
```

```javascript
// /utils.ts (VFS)
export const utils = "hello";
```

Expected: the relative import `"./utils.ts"` is resolved by VirtualFileSystemPlugin (since the importer is in VFS namespace) → found in VFS → loaded from memory.

**Regression signal:** If VFS-to-VFS relative imports fail or accidentally delegate to HttpPlugin, the namespace scoping in VirtualFileSystemPlugin is broken.
