# bundlejs Resolution Scenarios

> A comprehensive suite of resolution scenarios that exercise every code path in bundlejs's Node.js module resolution implementation. Each scenario uses **real npm packages** (pinned versions) and describes expected behavior, API URLs to test, and regression signals.

## Purpose

These scenarios serve three goals:

1. **Validation** — Verify that every resolution path works correctly with real-world packages
2. **Regression prevention** — Each scenario describes what breaks if a specific code path fails (this is how the browser field remapping bug would have been caught)
3. **Spec coverage** — Map every relevant section of the [Node.js module resolution algorithm](https://nodejs.org/api/packages.html) to a concrete test

## How to Use

**Manual testing:** Each scenario includes an API URL. Start the local server (`deno serve -A --watch edge/mod.ts`) and hit the URLs:

```sh
# Quick smoke test — does basic resolution work?
curl "http://localhost:8000/?q=preact@10.25.4" | jq .size

# Platform comparison — do conditions branch correctly?
curl "http://localhost:8000/?q=solid-js@1.9.4" | jq .size
curl "http://localhost:8000/?q=solid-js@1.9.4&config={\"resolve\":{\"runtime\":\"deno\"}}" | jq .size
```

**Automated testing:** These docs are structured to support future test automation. Each scenario has:
- A deterministic API URL
- An expected resolution target (the file path the resolver should produce)
- A regression signal (what observable behavior changes if the scenario breaks)

## Scenario Index

### Modern Resolution

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 1.1 | Simple conditional exports | `preact@10.25.4` | [01-conditional-exports.md](01-conditional-exports.md) |
| 1.2 | Deeply nested conditions (3 levels) | `solid-js@1.9.4` | [01-conditional-exports.md](01-conditional-exports.md) |
| 1.3 | Node-specific CJS/ESM nesting | `vue@3.5.13` | [01-conditional-exports.md](01-conditional-exports.md) |
| 1.4 | 2×2 matrix: format × platform | `uuid@11.0.5` | [01-conditional-exports.md](01-conditional-exports.md) |
| 1.5 | Single-string exports | `chalk@5.4.1` | [01-conditional-exports.md](01-conditional-exports.md) |
| 1.6 | Array fallbacks in exports | `yargs@17.7.2` | [01-conditional-exports.md](01-conditional-exports.md) |
| 1.7 | Explicit `null` exclusion | *(synthetic)* | [01-conditional-exports.md](01-conditional-exports.md) |

### Subpath Patterns and Imports

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 2.1 | Basic wildcard pattern | `solid-js@1.9.4` | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |
| 2.2 | Explicit key priority over wildcard | `solid-js@1.9.4` | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |
| 2.3 | Wildcard + conditional exports | `rxjs@7.8.1` | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |
| 2.4 | Overlapping explicit vs wildcard | `rxjs@7.8.1` | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |
| 2.5 | Conditional `#` import | `chalk@5.4.1` | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |
| 2.6 | Unconditional `#` import | `chalk@5.4.1` | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |
| 2.7 | Failed `#` import = hard error | *(spec behavior)* | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |
| 2.8 | Self-referencing through exports | `yargs@17.7.2` | [02-subpath-patterns-and-imports.md](02-subpath-patterns-and-imports.md) |

### Legacy Field Resolution

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 3.1 | Only `main` field | `isarray@2.0.5` | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.1a | Extensionless `main` | `ms@2.1.3` | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.2 | `module` field (ESM entry) | `lodash-es@4.17.21` | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.3 | `browser` string form | `signal-exit@4.1.0` | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.4 | No entry point fields at all | *(synthetic)* | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.5 | `unpkg`/`jsdelivr` CDN fields | `vue@3.5.13` | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.6 | `type: "module"` + `main` | *(synthetic)* | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.7 | `jsnext:main` (extremely legacy) | `moment@2.30.1` | [03-legacy-fields.md](03-legacy-fields.md) |
| 3.8 | `exports` takes precedence over legacy | `signal-exit@4.1.0` | [03-legacy-fields.md](03-legacy-fields.md) |

### Browser Field Remapping

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 4.1 | Internal path remapping | `readable-stream@4.7.0` | [04-browser-field-remapping.md](04-browser-field-remapping.md) |
| 4.2 | Bare module exclusion (`false`) | `axios@1.7.9` | [04-browser-field-remapping.md](04-browser-field-remapping.md) |
| 4.3 | Path prefix variants (`./`, `/`, bare) | *(synthetic)* | [04-browser-field-remapping.md](04-browser-field-remapping.md) |
| 4.4 | All-false browser field | *(synthetic)* | [04-browser-field-remapping.md](04-browser-field-remapping.md) |
| 4.5 | Browser field ignored on non-browser | `readable-stream@4.7.0` | [04-browser-field-remapping.md](04-browser-field-remapping.md) |
| 4.6 | Edge runtime: `browser` condition ≠ `browserField` | `readable-stream@4.7.0` | [04-browser-field-remapping.md](04-browser-field-remapping.md) |
| 4.7 | **Relative import remapping (HttpPlugin)** | `@exodus/bytes@1.13.0` | [04-browser-field-remapping.md](04-browser-field-remapping.md) |
| 4.8 | Relative import exclusion (`false`) | *(synthetic)* | [04-browser-field-remapping.md](04-browser-field-remapping.md) |

### Platform-Specific Remapping

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 5.1 | React Native string-form entry | `react-native-safe-area-context@5.1.0` | [05-platform-remapping.md](05-platform-remapping.md) |
| 5.2 | React Native object-form remapping | `@exodus/bytes@1.13.0` | [05-platform-remapping.md](05-platform-remapping.md) |
| 5.3 | Priority: react-native > browser | `@exodus/bytes@1.13.0` | [05-platform-remapping.md](05-platform-remapping.md) |
| 5.4 | Electron renderer remapping | *(synthetic)* | [05-platform-remapping.md](05-platform-remapping.md) |
| 5.5 | No matching field = pass-through | `@exodus/bytes@1.13.0` | [05-platform-remapping.md](05-platform-remapping.md) |
| 5.6 | Non-browser `false` exclusion | *(synthetic)* | [05-platform-remapping.md](05-platform-remapping.md) |
| 5.7 | Entry vs relative: two code paths | `@exodus/bytes@1.13.0` | [05-platform-remapping.md](05-platform-remapping.md) |

### Relative Imports and CDN Behavior

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 6.1 | Post-redirect URL as resolve base | `react@19.0.0` | [06-relative-imports.md](06-relative-imports.md) |
| 6.2 | Extension probing (18 combos) | `events@3.3.0` | [06-relative-imports.md](06-relative-imports.md) |
| 6.3 | Failed probe caching | *(behavior)* | [06-relative-imports.md](06-relative-imports.md) |
| 6.4 | Absolute path in HTTP module | *(behavior)* | [06-relative-imports.md](06-relative-imports.md) |
| 6.5 | Bare import delegates to CdnPlugin | `axios@1.7.9` | [06-relative-imports.md](06-relative-imports.md) |
| 6.6 | `new URL(...)` asset discovery | *(behavior)* | [06-relative-imports.md](06-relative-imports.md) |
| 6.7 | JSR specifier inside HTTP module | `jsr:@std/path@1.0.0` | [06-relative-imports.md](06-relative-imports.md) |
| 6.8 | `#` import inside HTTP module | `chalk@5.4.1` | [06-relative-imports.md](06-relative-imports.md) |

### Tree-Shaking and Side Effects

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 7.1 | `sideEffects: false` | `lodash-es@4.17.21` | [07-tree-shaking.md](07-tree-shaking.md) |
| 7.2 | Glob patterns in `sideEffects` | `three@0.171.0` | [07-tree-shaking.md](07-tree-shaking.md) |
| 7.3 | Extension-based glob | *(synthetic)* | [07-tree-shaking.md](07-tree-shaking.md) |
| 7.4 | Explicit file list | `react-native-reanimated@3.16.7` | [07-tree-shaking.md](07-tree-shaking.md) |
| 7.5 | No `sideEffects` field (conservative) | `moment@2.30.1` | [07-tree-shaking.md](07-tree-shaking.md) |
| 7.6 | sideEffects + conditional exports | `solid-js@1.9.4` | [07-tree-shaking.md](07-tree-shaking.md) |
| 7.7 | CSS excluded from optimization | *(behavior)* | [07-tree-shaking.md](07-tree-shaking.md) |

### Non-npm Resolution

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 8.1 | Basic JSR import | `jsr:@std/path@1.0.0` | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.2 | JSR semver range | `jsr:@std/path@^1.0.0` | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.3 | JSR subpath export | `jsr:@std/path@1.0.0/posix` | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.4 | JSR fallback to esm.sh | *(error path)* | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.5 | JSR TypeScript handling | `jsr:@hono/hono@4.11.9` | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.6 | Tarball from pkg.pr.new | *(via config)* | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.7 | Tarball content-addressed caching | *(behavior)* | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.8 | Tarball self-reference | *(behavior)* | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.9 | Import map basic remapping | *(via config)* | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.10 | Import map scopes | *(via config)* | [08-non-npm-resolution.md](08-non-npm-resolution.md) |
| 8.11 | Import map prefix matching | *(via config)* | [08-non-npm-resolution.md](08-non-npm-resolution.md) |

### Builtins and Polyfills

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 9.1 | Builtin exclusion (default) | `fs-extra@11.2.0` | [09-builtins-and-polyfills.md](09-builtins-and-polyfills.md) |
| 9.2 | Builtin polyfill mode | `fs-extra@11.2.0` | [09-builtins-and-polyfills.md](09-builtins-and-polyfills.md) |
| 9.3 | `node:` prefix stripping | `@noble/hashes@1.7.1` | [09-builtins-and-polyfills.md](09-builtins-and-polyfills.md) |
| 9.4 | `"fs"` = `"node:fs"` equivalence | `events@3.3.0` | [09-builtins-and-polyfills.md](09-builtins-and-polyfills.md) |
| 9.5 | Builtin inside CDN module | `axios@1.7.9` | [09-builtins-and-polyfills.md](09-builtins-and-polyfills.md) |
| 9.6 | Polyfill output format compat | *(behavior)* | [09-builtins-and-polyfills.md](09-builtins-and-polyfills.md) |

### Dual Package, Format, and Platform

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 10.1 | CJS vs ESM via exports | `uuid@11.0.5` | [10-dual-package-hazard.md](10-dual-package-hazard.md) |
| 10.2 | Pure ESM (`type: "module"`) | `chalk@5.4.1` | [10-dual-package-hazard.md](10-dual-package-hazard.md) |
| 10.3 | Legacy dual (main + module) | *(synthetic)* | [10-dual-package-hazard.md](10-dual-package-hazard.md) |
| 10.4 | Output format wrapping | `preact@10.25.4` | [10-dual-package-hazard.md](10-dual-package-hazard.md) |
| 10.5 | Platform defines | `react@19.0.0` | [10-dual-package-hazard.md](10-dual-package-hazard.md) |
| 10.6 | Target syntax | `preact@10.25.4` | [10-dual-package-hazard.md](10-dual-package-hazard.md) |
| 10.7 | Minification toggle | `preact@10.25.4` | [10-dual-package-hazard.md](10-dual-package-hazard.md) |

### Edge Cases, Errors, and Stress Tests

| # | Scenario | Key packages | File |
|:--|:---------|:-------------|:-----|
| 11.1 | `git:` dependency error | *(synthetic)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.2 | `workspace:` dependency error | *(synthetic)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.3 | `link:` dependency error | *(synthetic)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.4 | npm alias unwrapping | *(synthetic)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.5 | AliasPlugin priority | `preact@10.25.4` | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.6 | Nested alias rejection | *(synthetic)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.7 | Peer dependency cycle | `react-dom@19.0.0` | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.8 | Tightly coupled dep web | `@angular/common@19.1.4` | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.9 | Nonexistent package | *(error path)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.10 | Nonexistent version | *(error path)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.11 | Empty package | *(synthetic)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.12 | Deep dependency tree | `webpack@5.96.1` | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.13 | Multiple packages in query | `react, react-dom, preact` | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.14 | Very deep exports nesting | *(synthetic)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.15 | Special chars in package names | `@anthropic-ai/sdk@1.0.0` | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.16 | VFS precedence over CDN | *(behavior)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |
| 11.17 | VFS-to-VFS relative imports | *(behavior)* | [11-edge-cases-and-errors.md](11-edge-cases-and-errors.md) |

### Runtime-Specific Conditions

| # | Scenario | Runtimes tested | File |
|:--|:---------|:---------------|:-----|
| 12.1 | Default browser conditions | browser | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.2 | Deno runtime | deno | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.3 | Bun runtime | bun | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.4 | Cloudflare Workers | workerd | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.5 | Vercel Edge | edge-light | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.6 | React Native | react-native | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.7 | Electron main | electron-main | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.8 | Electron renderer | electron-renderer | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.9 | Custom conditions | *(user config)* | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.10 | Condition deduplication | electron-renderer | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.11 | `require` from CJS format | *(format config)* | [12-runtime-conditions.md](12-runtime-conditions.md) |
| 12.12 | Conditions flow to HttpPlugin | `@exodus/bytes@1.13.0` | [12-runtime-conditions.md](12-runtime-conditions.md) |


### Utility Correctness (Pure Functions)

| # | Scenario | Key modules | File |
|:--|:---------|:------------|:-----|
| 13.1 | CDN style detection | `cdn-format.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.1a | `jsdelivr.gh:` regex fix | `cdn-format.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.2 | CDN origin resolution | `cdn-format.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.3 | Pure import path stripping | `cdn-format.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.4 | CDN URL construction | `cdn-format.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.5 | JSR specifier parsing | `cdn-format.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.6 | JSR URL helpers | `cdn-format.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.7 | Loader inference (JS→TS) | `loader.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.8 | Side effects computation | `side-effects.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.9 | Path normalization & joining | `cdn-resolution.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.10 | Package entry resolution | `cdn-resolution.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.11 | Peer dependency merging | `cdn-resolution.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.12 | Virtual filesystem CRUD | `filesystem.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.13 | VFS path resolution & probing | `plugins/fs.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.14 | Alias detection (`#` passthrough) | `plugins/alias.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.15 | External/builtin detection | `plugins/external.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.16 | Tarball URL parsing | `plugins/tar.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.17 | URL utilities (join, encode, path) | `utils/url.ts` | [13-utility-correctness.md](13-utility-correctness.md) |
| 13.18 | Bare import detection | `utils/path.ts` | [13-utility-correctness.md](13-utility-correctness.md) |

### Plugin Pipeline Correctness

| # | Scenario | Key modules | File |
|:--|:---------|:------------|:-----|
| 15.1 | Extension probing (`AllEndingVariants`) | `plugins/http.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.2 | Polyfill map shape & completeness | `plugins/external.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.3 | External package detection edge cases | `plugins/external.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.4 | Alias guard conditions | `plugins/alias.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.5 | VFS namespace scoping | `plugins/fs.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.6 | Tarball entry resolution fallback chain | `plugins/tar.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.7 | Alias + External interaction (ordering) | `plugins/alias.ts`, `plugins/external.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.8 | CDN style → plugin routing | `utils/cdn-format.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.9 | `pluginData` contract (url, manifest, packageBaseUrl) | `plugins/http.ts`, `plugins/cdn.ts` | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.10 | Plugin namespace uniqueness | all plugins | [15-plugin-pipeline.md](15-plugin-pipeline.md) |
| 15.11 | Integration: VFS→CDN, alias, external, polyfill, format | full pipeline | [15-plugin-pipeline.md](15-plugin-pipeline.md) |

### GitHub Issue Regression

| # | Scenario | Key modules | File |
|:--|:---------|:------------|:-----|
| 16 | Regression tests for specific GitHub issues | various | [16-github-issue-regression.md](16-github-issue-regression.md) |

### JSX in `.js` Files

| # | Scenario | Key modules | File |
|:--|:---------|:------------|:-----|
| 18.1 | JSX in `.js` file gets `tsx` loader | `loader.ts` | [18-jsx-in-js-files.md](18-jsx-in-js-files.md) |
| 18.2 | Non-JSX `.js` file stays `ts` loader | `loader.ts` | [18-jsx-in-js-files.md](18-jsx-in-js-files.md) |
| 18.3 | `.ts` files never upgraded | `loader.ts` | [18-jsx-in-js-files.md](18-jsx-in-js-files.md) |
| 18.4 | `containsJSX` byte-level detection | `loader.ts` | [18-jsx-in-js-files.md](18-jsx-in-js-files.md) |

### Registry Tarballs & VFS Tarballs

| # | Scenario | Key modules | File |
|:--|:---------|:------------|:-----|
| 19.1 | isTarballUrl detection (CDN + extension) | `plugins/tar.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |
| 19.2 | parseGenericTarballUrl (split URL/subpath) | `plugins/tar.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |
| 19.3 | parseTarballUrl (pkg.pr.new) unchanged | `plugins/tar.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |
| 19.4 | TarResolution routing (pkg.pr.new vs registry) | `plugins/tar.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |
| 19.5 | resolvePackageEntry with subpaths | `plugins/tar.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |
| 19.6 | stripPackagePrefix | `plugins/tar.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |
| 19.7 | Edge cases (case-insensitive, multi-ext, archive-detect) | `plugins/tar.ts`, `archive-detect.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |
| 19.8 | VFS tarball path detection (isTarballPath) | `plugins/tar.ts` | [19-registry-tarballs.md](19-registry-tarballs.md) |

### Flow Type Stripping

| # | Scenario | Key modules | File |
|:--|:---------|:------------|:-----|
| 20.1 | `@flow` pragma triggers detection | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.2 | `import typeof` triggers detection (no pragma) | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.3 | `opaque type` triggers detection | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.4 | Flow utility types (`$Exact`, `$Diff`, etc.) | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.5 | Known-package fast path (`react-native`) | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.6 | URL heuristic detects react-native in CDN paths | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.7 | Non-Flow `.js` file is not detected | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.8 | TypeScript `import type` is not misidentified | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.9 | Full stripping via `flow-remove-types` | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.10 | Regex fallback handles `import typeof` | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.11 | `maybeStripFlow` conditional processing | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.12 | HttpPlugin strips Flow from CDN content | `plugins/http.ts`, `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.13 | VFS plugin strips Flow from tarball-extracted content | `plugins/fs.ts`, `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.14 | Lazy loading of `flow-remove-types` | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.15 | Block comment `@flow` pragma | `flow-strip.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |
| 20.16 | Flow + JSX co-occurrence | `flow-strip.ts`, `loader.ts` | [20-flow-type-stripping.md](20-flow-type-stripping.md) |


## Coverage Map

This table maps each scenario to the source file and function it exercises:

| Resolution path | Source | Key function | Scenarios |
|:----------------|:-------|:-------------|:----------|
| Modern exports resolution | `cdn-resolution.ts` | `resolveModern()` | 1.1–1.7, 2.1–2.4 |
| Subpath imports (`#`) | `cdn-resolution.ts` | `resolveModern()` | 2.5–2.7 |
| Legacy field resolution | `cdn-resolution.ts` | `resolveLegacy()` | 3.1–3.8 |
| Browser field remapping (entry) | `cdn-resolution.ts` | `applyPathRemapping()` | 4.1–4.6 |
| Manifest field remapping (relative) | `cdn-resolution.ts` | `applyManifestRemappings()` | 4.7–4.8, 5.2–5.6 |
| Condition computation | `resolve-conditions.ts` | `getResolverConditions()` | 12.1–12.12 |
| Runtime defaults | `resolve-conditions.ts` | `getRuntimeDefaults()` | 12.2–12.8 |
| HttpPlugin resolution | `http.ts` | `HttpResolution()` | 6.1–6.8 |
| Extension probing | `http.ts` | `determineExtension()` | 6.2–6.3 |
| JSR resolution | `cdn.ts` + `jsr-spec.ts` | JSR-specific path | 8.1–8.5 |
| Tarball extraction | `tar.ts` | TarballPlugin | 8.6–8.8 |
| Import maps | `resolve-import-map.ts` | WHATWG algorithm | 8.9–8.11 |
| Builtin handling | `external.ts` | ExternalPlugin | 9.1–9.6 |
| Side effects | `side-effects.ts` | `computeEsbuildSideEffects()` | 7.1–7.7 |
| Alias rewriting | `alias.ts` | AliasPlugin | 11.4–11.6 |
| Peer dependencies | `cdn-resolution.ts` | `computePeerDependencies()` | 11.7–11.8 |
| CDN URL construction | `cdn-format.ts` | `getCDNUrl()` | 11.15, 13.1–13.6 |
| VFS resolution | `fs.ts` | VirtualFileSystemPlugin | 11.16–11.17, 13.12–13.13 |
| Loader inference | `loader.ts` | `inferLoader()` | 13.7 |
| CDN style detection | `cdn-format.ts` | `getCDNStyle()` | 13.1 |
| JSR specifiers | `cdn-format.ts` | `parseJSRSpecifier()` | 13.5–13.6 |
| Tarball parsing | `tar.ts` | `parseTarballUrl()` | 13.16, 19.3 |
| Tarball URL detection | `tar.ts` | `isTarballUrl()`, `isTarballPath()` | 19.1, 19.7, 19.8 |
| Tarball URL splitting | `tar.ts` | `findTarballSplitInPathname()` | 19.2, 19.7, 19.8 |
| Tarball subpath resolution | `tar.ts` | `resolvePackageEntry()` (tar) | 19.5 |
| VFS tarball detection | `tar.ts` | `isTarballPath()` | 19.8 |
| JSX content detection | `loader.ts` | `containsJSX()` | 18.1–18.4 |
| Loader upgrade (JSX in JS) | `loader.ts` | `inferLoader()` | 18.1–18.3 |
| URL utilities | `url.ts` | `encodeWhitespace()`, `urlJoin()` | 13.17 |
| Bare import detection | `path.ts` | `isBareImport()` | 13.18 |
| Extension probing variants | `http.ts` | `AllEndingVariants` | 15.1 |
| Polyfill map | `external.ts` | `PolyfillMap` | 15.2 |
| Tarball entry resolution | `tar.ts` | `resolvePackageEntry()` (tar) | 15.6 |
| Plugin namespace isolation | all plugins | namespace constants | 15.10 |
| Full pipeline integration | all plugins | `buildWithEntry()` | 15.11 |
| Flow detection | `flow-strip.ts` | `containsFlow()` | 20.1–20.8, 20.15 |
| Flow stripping | `flow-strip.ts` | `stripFlowTypes()`, `maybeStripFlow()` | 20.9–20.13, 20.16 |
| Flow lazy loading | `flow-strip.ts` | `loadFlowRemoveTypes()` | 20.14 |
| Flow regex fallback | `flow-strip.ts` | `regexStripFlow()` | 20.10 |

## What Would Have Caught the Browser Remapping Bug

The original bug — relative imports inside CDN-fetched packages not getting browser field remappings applied — would have been caught by:

- **Scenario 4.7** (direct test of relative import remapping with `@exodus/bytes`)
- **Scenario 5.2** (react-native variant of the same bug)
- **Scenario 5.7** (explicitly tests that entry and relative remapping are two separate code paths)
- **Scenario 12.12** (tests that conditions propagate from CdnPlugin to HttpPlugin)
