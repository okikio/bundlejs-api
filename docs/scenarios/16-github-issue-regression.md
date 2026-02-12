# Scenario 16 — GitHub Issue Regression Coverage

> Maps all 71 issues from [okikio/bundlejs](https://github.com/okikio/bundlejs/issues)
> to existing or new test coverage in `bundlejs-api`.

## Overview

This scenario covers real-world bugs and feature requests reported by users.
Each issue is classified into one of three categories:

| Category | Meaning |
|---|---|
| **Bundling Logic** | Relates to resolution, plugins, build pipeline, extension probing |
| **UI / Docs / Infra** | Frontend-only, documentation, CI/CD — NOT testable in this repo |
| **Feature Request** | New capability not yet implemented |

---

## Issue Classification

### Bundling-Logic Issues (Tested)

These issues tie directly into the build/resolution pipeline and are covered
by existing or new tests.

| # | Title | Root Cause | Covered By |
|---|---|---|---|
| 2 | `node:` imports error | Missing node: prefix stripping | Tests 09.1–09.6 |
| 13 | Ignore peer dependencies | Peer dep resolution | Test 11.7 |
| 22 | Exclude peer deps + composition | Same as #13 | Test 11.7 |
| 31 | `browser` attribute not used | Browser field remapping | Tests 04.1–04.8 |
| 36 | Failed to fetch dependencies | CDN fetch error handling | Test 11.9 |
| 37 | &bundle produces different results | Query parsing | Edge layer (not core) |
| 38 | Analyze by `import` identifier | Tree-shaking named exports | Test 07 |
| 39 | Duplicate dependencies | Dedup of shared transitive deps | **Test 16.7** |
| 41 | Could not build codemirror 6 | Complex exports/conditions | Test 01 |
| 42 | Error downloading packages | CDN fetch errors | Test 11.9 |
| 47 | Size reported is off | Compression calculation | Compress module (not core) |
| 49 | Incorrect treeshake size | Tree-shaking + compression | Test 07 |
| 51 | Treeshake doesn't work for badges | Tree-shaking | Test 07 |
| 57 | Fail to bundle npm CLI | Heavy Node.js-only package | **Test 16.8** |
| 58 | Incorrect URL for Redux Toolkit | Subpath exports resolution | Tests 01, 02 |
| 59 | Failed to build node-libcurl | Native .node addon | **Test 16.8** |
| 60 | No longer works with unpkg | CDN host resolution | **Test 16.5** |
| 61 | Build failed for recharts | CJS/ESM interop | **Test 16.9** |
| 63 | Build fails for remix-hook-form | Node builtins in transitive deps | **Test 16.6** |
| 65 | Config externals shortcut | Feature: auto-external peerDeps | **Test 16.3** |
| 66 | Exclude `await import()` | Dynamic imports + external config | **Test 16.3** |
| 67 | "Do not know how to load path" | Extension probing failure | **Test 16.1** |
| 68 | Failed for tippy.js | CSS/extension in packages | **Test 16.9** |
| 70 | Can't load jest@29.7.0 | Heavy Node.js-only package | **Test 16.8** |
| 72 | Too much recursion | Circular deps / deep chain | **Test 16.10** |
| 77 | No matching export `toSignal` | Exports field resolution + .d.ts | **Test 16.1** |
| 78 | Support for tarballs | Tarball resolution | Tests 08, 15 |
| 79 | Incorrect entry file from unpkg | Entry point resolution | Tests 01, 03 |
| 83 | Can't build jsonstream-next | Case-sensitive package name | **Test 16.10** |
| 87 | "Do not know how to load path" | Browser field → source .ts path | **Test 16.2** |
| 88 | Framer motion error | Complex package resolution | **Test 16.9** |
| 92 | react-native@1000.0.0/cli.js | Invalid version / platform dep | **Test 16.2** |
| 93 | Badge wrong cache | Caching (edge layer) | Edge module (not core) |
| 94 | Platform option not work | Platform conditions | Tests 05, 12 |
| 95 | Optional peer deps inconsistency | Peer dep handling | Test 11.7 |
| 96 | Badges stopped working | Badge generation (edge layer) | Edge module (not core) |
| 97 | "Do not know how to load path" | Subpath bare import resolution | **Test 16.1** |

### UI / Docs / Infra Issues (Not Tested Here)

| # | Title | Why Not Tested |
|---|---|---|
| 4 | Safari issues | Browser UI |
| 7 | Theme toggle | Frontend |
| 8 | Theme switcher | Frontend |
| 9 | Loading spinner | Frontend |
| 10 | CSS raw files | Frontend |
| 11 | URL queries | Frontend |
| 12 | App loading issues | Frontend |
| 14 | Source code size display | Frontend |
| 15 | Library version spec | Frontend |
| 16 | Eval button | Frontend |
| 18 | Rename btn-share | Frontend |
| 21 | Error squiggles display | Frontend |
| 23 | Safari ES modules | Frontend |
| 26 | npms.io flaky | External service |
| 27 | "How to use" docs | Documentation |
| 28 | Output copying | Frontend |
| 30 | Badges with size label | Badge generation |
| 35 | mangleProps RegExp | esbuild option pass-through |
| 46 | Client package version | Frontend |
| 48 | getRequest failed | Edge networking |
| 50 | API error message | Edge layer |
| 54 | Multiple badges | Badge generation |
| 55 | Badge caching | Badge caching |
| 56 | Package.json versions | Frontend |
| 62 | CORS badges | Badge CORS |
| 71 | Security polyfill.io | Security advisory |
| 73 | Console color contrast | Frontend |
| 76 | Add package size | Frontend feature |
| 80 | Replace denoflate | Compression library swap |
| 82 | Input textarea | Frontend |
| 84 | Document badge params | Documentation |
| 85 | Config query string | Frontend/URL parsing |

---

## Bug Pattern Analysis

### Pattern 1: "Do not know how to load path" (Issues #67, #87, #92, #97)

**Root cause**: Extension probing failure in `determineExtension()` when the
CDN cannot find the exact file. Two sub-patterns:

1. **Subpath bare imports without exports field** (#97, #67):
   A CDN-fetched module does `from 'react-remove-scroll-bar/constants'`.
   If `react-remove-scroll-bar` doesn't declare `./constants` in its
   `exports` field, the CDN plugin falls back to direct URL construction:
   `https://unpkg.com/react-remove-scroll-bar@2.3.8/constants`.
   Extension probing then tries `/constants`, `/constants.js`, etc. but
   the actual file is at `/dist/es2015/constants.js`.

2. **Browser field pointing to source paths** (#87):
   The `browser` field in `@opentelemetry/api@0.15.0` maps to
   `./src/platform/browser/index.ts` — a TypeScript source file that
   doesn't exist in the published dist.

### Pattern 2: Platform-specific dependencies (Issues #59, #70, #92)

Packages like `react-native`, `node-libcurl`, `jest` rely heavily on
Node.js builtins or native addons. These SHOULD produce meaningful
error messages rather than cryptic "Do not know how to load path" errors.

### Pattern 3: Complex package resolution (Issues #41, #61, #68, #88)

Large packages with many transitive dependencies, CSS imports, or mixed
CJS/ESM formats. These test the full pipeline under load.

---

## Test Strategy

New test file: `core/tests/16-github-issue-regression.test.ts`

### Unit Tests

- **16.1**: Subpath bare import resolution — validates that CdnResolution
  correctly resolves subpath imports with and without exports field
- **16.2**: Browser field edge cases — source path mapping, platform deps
- **16.3**: External config patterns — dynamic imports, custom externals

### Integration Tests

- **16.5**: CDN host variants — unpkg, esm.sh
- **16.6**: Node builtins in transitive deps
- **16.7**: Multiple packages with shared deps (deduplication)
- **16.8**: Expected failures — Node-only packages produce errors
- **16.9**: Complex real-world packages (regression checks)
- **16.10**: Deep dependencies and edge cases
