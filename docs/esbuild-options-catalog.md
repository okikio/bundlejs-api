# esbuild BuildOptions — Complete Catalog for bundlejs

> Comprehensive inventory of every esbuild Build API option, cross-referenced
> against bundlejs's current URL parameter surface and categorized by
> suitability for exposure as a URL param in a bundling service.

**Source versions:**

- esbuild types: `esbuild-wasm@0.25.4` (`lib/main.d.ts`)
- esbuild docs: <https://esbuild.github.io/api/>
- bundlejs schema: `edge/_shared/bundle/schema.ts` (`BundleQuerySchema`)
- bundlejs parser: `edge/_shared/bundle/parse.ts`
- bundlejs core types: `core/types.ts` (`BuildConfig`)
- bundlejs defaults: `core/build.ts` (`BUILD_CONFIG`)

---

## Legend

| Category | Meaning |
|----------|---------|
| **A — Already exposed** | Direct URL param today (`?format=esm`, `?minify`, etc.) |
| **B — Good candidate** | Simple type, commonly needed, safe to expose as a URL param |
| **C — Better in `config` JSON5** | Complex object/array, rarely needed, or expert-only |
| **D — Not applicable** | Filesystem-bound, service-incompatible, or runtime-only |

---

## Current bundlejs URL params (Category A reference)

From `BundleQuerySchema` and `parseQueryToConfig`:

| URL param | Maps to | Notes |
|-----------|---------|-------|
| `?q` / `?query` | entry module specifiers | Comma-separated |
| `?treeshake` | import/export selections | Bracket grammar |
| `?share` | LZ-compressed input code | — |
| `?text` | Plain text input code | — |
| `?config` | JSON5 `BuildConfig` blob | Escape hatch for anything |
| `?tsx` / `?jsx` | `config.tsx` (loader hint) | Boolean |
| `?polyfill` | `config.polyfill` | Boolean |
| `?minify` | `esbuild.minify` | Boolean |
| `?pretty` | `esbuild.minify` (inverted) | Boolean |
| `?sourcemap` | `esbuild.sourcemap` | `true`/`false`/`inline`/`external`/`both` |
| `?format` | `esbuild.format` | `esm`/`cjs`/`iife` |
| `?metafile` | `esbuild.metafile` | Boolean |
| `?analysis` / `?analyze` | enable analysis output | Boolean or `verbose` |
| `?badge` | badge generation | `detailed`/`minified` |
| `?badge-style` | shields.io style | String |
| `?badge-raster` / `?png` | PNG badge | Boolean |
| `?file` | return bundled code | Boolean |
| `?raw` | return raw JSON result | Boolean |
| `?warnings` / `?warning` | return warnings | Boolean |
| `?cache` | cache control | `use`/`bypass`/`refresh` |
| `?v` | DSL spec version | `1` |
| `?base` | default bracket payload | String |

---

## Complete esbuild BuildOptions catalog

### CommonOptions (shared by Build and Transform)

These fields exist on `CommonOptions` and are inherited by both `BuildOptions`
and `TransformOptions`.

---

#### 1. `sourcemap`

| Property | Value |
|----------|-------|
| **CLI flag** | `--sourcemap` / `--sourcemap=inline` / `--sourcemap=external` / `--sourcemap=both` / `--sourcemap=linked` |
| **API field** | `sourcemap` |
| **Type** | `boolean \| 'linked' \| 'inline' \| 'external' \| 'both'` |
| **Default** | `false` |
| **Description** | Generate source maps. `linked` writes a separate `.map` file with a `//# sourceMappingURL` comment; `inline` appends as base64; `external` writes without comment; `both` = `inline` + `external`. |
| **Category** | **A — Already exposed** as `?sourcemap` |

---

#### 2. `legalComments`

| Property | Value |
|----------|-------|
| **CLI flag** | `--legal-comments=none\|inline\|eof\|linked\|external` |
| **API field** | `legalComments` |
| **Type** | `'none' \| 'inline' \| 'eof' \| 'linked' \| 'external'` |
| **Default** | `eof` when bundling, `inline` otherwise |
| **Description** | Controls preservation/placement of `@license` / `@preserve` comments. |
| **Category** | **B — Good candidate** — simple enum, useful for users who want license comments stripped or consolidated. |

---

#### 3. `sourceRoot`

| Property | Value |
|----------|-------|
| **CLI flag** | `--source-root=<url>` |
| **API field** | `sourceRoot` |
| **Type** | `string` |
| **Default** | (none) |
| **Description** | Sets the `sourceRoot` field in source maps. All paths are relative to this. |
| **Category** | **C — Better in `config`** — rarely needed, only useful when source maps are on. |

---

#### 4. `sourcesContent`

| Property | Value |
|----------|-------|
| **CLI flag** | `--sources-content=false` |
| **API field** | `sourcesContent` |
| **Type** | `boolean` |
| **Default** | `true` |
| **Description** | Whether to include original source code in source maps. Disabling reduces source map size. |
| **Category** | **C — Better in `config`** — niche, only matters when sourcemaps are enabled. |

---

#### 5. `format`

| Property | Value |
|----------|-------|
| **CLI flag** | `--format=esm\|cjs\|iife` |
| **API field** | `format` |
| **Type** | `'iife' \| 'cjs' \| 'esm'` |
| **Default** | Depends on platform: `iife` (browser), `cjs` (node), `esm` (neutral) |
| **Description** | Output module format. |
| **Category** | **A — Already exposed** as `?format` |

---

#### 6. `globalName`

| Property | Value |
|----------|-------|
| **CLI flag** | `--global-name=<name>` |
| **API field** | `globalName` |
| **Type** | `string` |
| **Default** | `"BundledCode"` (bundlejs default) |
| **Description** | Global variable name for IIFE exports. Supports compound paths like `a.b.c`. |
| **Category** | **B — Good candidate** — simple string, useful when `format=iife`. Could be `?global-name=MyLib`. |

---

#### 7. `target`

| Property | Value |
|----------|-------|
| **CLI flag** | `--target=es2020,chrome80` |
| **API field** | `target` |
| **Type** | `string \| string[]` |
| **Default** | `["esnext"]` (bundlejs default) |
| **Description** | Target environments for syntax downleveling. Accepts language versions (`es2020`) and browser names with versions (`chrome80`, `node18`, `firefox100`, etc.). |
| **Category** | **B — Good candidate** — commonly needed, comma-separated string maps cleanly to URL param. `?target=es2020` or `?target=es2020,chrome80`. |

---

#### 8. `supported`

| Property | Value |
|----------|-------|
| **CLI flag** | `--supported:bigint=false` |
| **API field** | `supported` |
| **Type** | `Record<string, boolean>` |
| **Default** | (auto from `target`) |
| **Description** | Override individual syntax feature support (e.g. disable `bigint`, enable `decorators`). |
| **Category** | **C — Better in `config`** — complex record, dozens of possible keys, expert-only. |

---

#### 9. `platform`

| Property | Value |
|----------|-------|
| **CLI flag** | `--platform=browser\|node\|neutral` |
| **API field** | `platform` |
| **Type** | `'browser' \| 'node' \| 'neutral'` |
| **Default** | `"browser"` (bundlejs default) |
| **Description** | Target platform. Controls default format, main fields, conditions, and built-in polyfill behavior. |
| **Category** | **B — Good candidate** — simple enum, commonly needed. `?platform=node`. |

---

#### 10. `mangleProps`

| Property | Value |
|----------|-------|
| **CLI flag** | `--mangle-props=<regex>` |
| **API field** | `mangleProps` |
| **Type** | `RegExp` |
| **Default** | (none) |
| **Description** | Rename properties matching the regex to shorter names. **Unsafe** — can break code. |
| **Category** | **C — Better in `config`** — RegExp type doesn't serialize to URL, dangerous, expert-only. |

---

#### 11. `reserveProps`

| Property | Value |
|----------|-------|
| **CLI flag** | `--reserve-props=<regex>` |
| **API field** | `reserveProps` |
| **Type** | `RegExp` |
| **Default** | (none) |
| **Description** | Exclude properties matching the regex from mangling. |
| **Category** | **C — Better in `config`** — RegExp, only relevant with `mangleProps`. |

---

#### 12. `mangleQuoted`

| Property | Value |
|----------|-------|
| **CLI flag** | `--mangle-quoted` |
| **API field** | `mangleQuoted` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Also mangle quoted property names (string literals in property position). |
| **Category** | **C — Better in `config`** — only relevant with `mangleProps`. |

---

#### 13. `mangleCache`

| Property | Value |
|----------|-------|
| **CLI flag** | `--mangle-cache=<file>` |
| **API field** | `mangleCache` |
| **Type** | `Record<string, string \| false>` |
| **Default** | (none) |
| **Description** | Persistent mapping of original→mangled property names for consistent renaming across builds. |
| **Category** | **D — Not applicable** — file-based persistence, no meaning in a stateless service. |

---

#### 14. `drop`

| Property | Value |
|----------|-------|
| **CLI flag** | `--drop:console` / `--drop:debugger` |
| **API field** | `drop` |
| **Type** | `('console' \| 'debugger')[]` |
| **Default** | `[]` |
| **Description** | Remove `console.*` calls or `debugger` statements from output. |
| **Category** | **B — Good candidate** — simple enum array, commonly requested. `?drop=console` or `?drop=console,debugger`. |

---

#### 15. `dropLabels`

| Property | Value |
|----------|-------|
| **CLI flag** | `--drop-labels=DEV,TEST` |
| **API field** | `dropLabels` |
| **Type** | `string[]` |
| **Default** | `[]` |
| **Description** | Remove labeled statements with the given label names. |
| **Category** | **C — Better in `config`** — niche use case, comma-separated string possible but rarely needed. |

---

#### 16. `minify`

| Property | Value |
|----------|-------|
| **CLI flag** | `--minify` |
| **API field** | `minify` |
| **Type** | `boolean` |
| **Default** | `true` (bundlejs default) |
| **Description** | Enable all minification (whitespace + identifiers + syntax). |
| **Category** | **A — Already exposed** as `?minify` / `?pretty` |

---

#### 17. `minifyWhitespace`

| Property | Value |
|----------|-------|
| **CLI flag** | `--minify-whitespace` |
| **API field** | `minifyWhitespace` |
| **Type** | `boolean` |
| **Default** | `false` (follows `minify`) |
| **Description** | Only minify whitespace (no identifier renaming or syntax transforms). |
| **Category** | **C — Better in `config`** — granular control, `?minify` suffices for most users. |

---

#### 18. `minifyIdentifiers`

| Property | Value |
|----------|-------|
| **CLI flag** | `--minify-identifiers` |
| **API field** | `minifyIdentifiers` |
| **Type** | `boolean` |
| **Default** | `false` (follows `minify`) |
| **Description** | Only rename local variables to shorter names. |
| **Category** | **C — Better in `config`** — granular, rarely needed independently. |

---

#### 19. `minifySyntax`

| Property | Value |
|----------|-------|
| **CLI flag** | `--minify-syntax` |
| **API field** | `minifySyntax` |
| **Type** | `boolean` |
| **Default** | `false` (follows `minify`) |
| **Description** | Only apply syntax-level size optimizations (e.g., `a === undefined || a === null ? 1 : a` → `a ?? 1`). |
| **Category** | **C — Better in `config`** — granular, rarely needed independently. |

---

#### 20. `lineLimit`

| Property | Value |
|----------|-------|
| **CLI flag** | `--line-limit=<n>` |
| **API field** | `lineLimit` |
| **Type** | `number` |
| **Default** | `0` (disabled) |
| **Description** | Wrap output lines after approximately this many bytes. Increases file size slightly. |
| **Category** | **C — Better in `config`** — niche formatting concern. |

---

#### 21. `charset`

| Property | Value |
|----------|-------|
| **CLI flag** | `--charset=utf8` |
| **API field** | `charset` |
| **Type** | `'ascii' \| 'utf8'` |
| **Default** | `'ascii'` |
| **Description** | `utf8` preserves non-ASCII characters instead of escaping them as `\uXXXX`. |
| **Category** | **C — Better in `config`** — rarely needed, minor output difference. |

---

#### 22. `treeShaking`

| Property | Value |
|----------|-------|
| **CLI flag** | `--tree-shaking=true\|false` |
| **API field** | `treeShaking` |
| **Type** | `boolean` |
| **Default** | `true` when bundling (bundlejs default) |
| **Description** | Enable/disable dead-code elimination (declaration-level). |
| **Category** | **B — Good candidate** — boolean, commonly toggled. `?tree-shaking=false`. Already passable via `?config={"esbuild":{"treeShaking":false}}`. |

---

#### 23. `ignoreAnnotations`

| Property | Value |
|----------|-------|
| **CLI flag** | `--ignore-annotations` |
| **API field** | `ignoreAnnotations` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Ignore `/* @__PURE__ */` and `sideEffects` annotations. Useful when annotations are incorrect. |
| **Category** | **C — Better in `config`** — debugging escape hatch, rarely needed. |

---

#### 24. `jsx`

| Property | Value |
|----------|-------|
| **CLI flag** | `--jsx=transform\|preserve\|automatic` |
| **API field** | `jsx` |
| **Type** | `'transform' \| 'preserve' \| 'automatic'` |
| **Default** | `"transform"` (bundlejs default) |
| **Description** | JSX handling mode. `transform` = classic React.createElement; `automatic` = React 17+ auto-import; `preserve` = keep JSX as-is. |
| **Category** | **B — Good candidate** — simple enum, useful for Preact/Solid users. `?jsx=automatic`. Note: `?jsx` currently just means "enable JSX support" (boolean), not the mode. |

---

#### 25. `jsxFactory`

| Property | Value |
|----------|-------|
| **CLI flag** | `--jsx-factory=h` |
| **API field** | `jsxFactory` |
| **Type** | `string` |
| **Default** | `"React.createElement"` |
| **Description** | Function called for each JSX element (classic mode). |
| **Category** | **B — Good candidate** — simple string, useful with Preact (`h`). `?jsx-factory=h`. |

---

#### 26. `jsxFragment`

| Property | Value |
|----------|-------|
| **CLI flag** | `--jsx-fragment=Fragment` |
| **API field** | `jsxFragment` |
| **Type** | `string` |
| **Default** | `"React.Fragment"` |
| **Description** | Component used for JSX fragments (classic mode). |
| **Category** | **B — Good candidate** — simple string, pairs with `jsxFactory`. `?jsx-fragment=Fragment`. |

---

#### 27. `jsxImportSource`

| Property | Value |
|----------|-------|
| **CLI flag** | `--jsx-import-source=preact` |
| **API field** | `jsxImportSource` |
| **Type** | `string` |
| **Default** | `"react"` |
| **Description** | Package to auto-import JSX factory from (automatic mode). |
| **Category** | **B — Good candidate** — simple string, essential for non-React JSX libs. `?jsx-import-source=preact`. |

---

#### 28. `jsxDev`

| Property | Value |
|----------|-------|
| **CLI flag** | `--jsx-dev` |
| **API field** | `jsxDev` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Enable JSX development mode (injects file/line info into JSX elements). Only works with `jsx=automatic`. |
| **Category** | **C — Better in `config`** — development-only, not useful for size analysis. |

---

#### 29. `jsxSideEffects`

| Property | Value |
|----------|-------|
| **CLI flag** | `--jsx-side-effects` |
| **API field** | `jsxSideEffects` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Treat JSX expressions as having side effects (disable `@__PURE__` annotation). |
| **Category** | **C — Better in `config`** — niche, only for non-virtual-DOM JSX libs. |

---

#### 30. `define`

| Property | Value |
|----------|-------|
| **CLI flag** | `--define:KEY=VALUE` |
| **API field** | `define` |
| **Type** | `Record<string, string>` |
| **Default** | `{}` |
| **Description** | Replace global identifiers with constant expressions at build time. |
| **Category** | **C — Better in `config`** — record type, variable number of keys. `?config={"esbuild":{"define":{"process.env.NODE_ENV":"\"production\""}}}`. |

---

#### 31. `pure`

| Property | Value |
|----------|-------|
| **CLI flag** | `--pure:console.log` |
| **API field** | `pure` |
| **Type** | `string[]` |
| **Default** | `[]` |
| **Description** | Mark global function calls as pure (removable if unused). |
| **Category** | **C — Better in `config`** — string array, variable length, expert use. |

---

#### 32. `keepNames`

| Property | Value |
|----------|-------|
| **CLI flag** | `--keep-names` |
| **API field** | `keepNames` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Preserve `.name` on functions/classes even when minifying. |
| **Category** | **B — Good candidate** — boolean, useful for frameworks that rely on `.name`. `?keep-names`. |

---

#### 33. `color`

| Property | Value |
|----------|-------|
| **CLI flag** | `--color=true\|false` |
| **API field** | `color` |
| **Type** | `boolean` |
| **Default** | `true` (bundlejs default) |
| **Description** | Enable/disable ANSI color in error/warning messages. |
| **Category** | **D — Not applicable** — internal logging detail, controlled by bundlejs's `ansi` config. |

---

#### 34. `logLevel`

| Property | Value |
|----------|-------|
| **CLI flag** | `--log-level=silent\|error\|warning\|info\|debug\|verbose` |
| **API field** | `logLevel` |
| **Type** | `'verbose' \| 'debug' \| 'info' \| 'warning' \| 'error' \| 'silent'` |
| **Default** | `"info"` (bundlejs default) |
| **Description** | Controls which messages esbuild prints. |
| **Category** | **C — Better in `config`** — debugging, not useful for typical users. Service controls logging. |

---

#### 35. `logLimit`

| Property | Value |
|----------|-------|
| **CLI flag** | `--log-limit=<n>` |
| **API field** | `logLimit` |
| **Type** | `number` |
| **Default** | `10` |
| **Description** | Maximum number of log messages before truncation. `0` = unlimited. |
| **Category** | **C — Better in `config`** — debugging detail. |

---

#### 36. `logOverride`

| Property | Value |
|----------|-------|
| **CLI flag** | `--log-override:TYPE=LEVEL` |
| **API field** | `logOverride` |
| **Type** | `Record<string, LogLevel>` |
| **Default** | `{}` |
| **Description** | Override log level for individual message types. |
| **Category** | **C — Better in `config`** — complex record, expert debugging tool. |

---

#### 37. `tsconfigRaw`

| Property | Value |
|----------|-------|
| **CLI flag** | `--tsconfig-raw='{"compilerOptions":{...}}'` |
| **API field** | `tsconfigRaw` |
| **Type** | `string \| TsconfigRaw` |
| **Default** | (none) |
| **Description** | Inline tsconfig.json content (avoids filesystem). Useful for Transform API or passing TS config without a file. |
| **Category** | **C — Better in `config`** — complex JSON object, passable via `config.esbuild.tsconfigRaw`. |

---

### BuildOptions-only fields

These fields only exist on `BuildOptions` (not `TransformOptions`).

---

#### 38. `bundle`

| Property | Value |
|----------|-------|
| **CLI flag** | `--bundle` |
| **API field** | `bundle` |
| **Type** | `boolean` |
| **Default** | `true` (bundlejs default — always on) |
| **Description** | Enable bundling (inline imported dependencies). |
| **Category** | **D — Not applicable** — bundlejs always bundles. The entire point of the service. |

---

#### 39. `splitting`

| Property | Value |
|----------|-------|
| **CLI flag** | `--splitting` |
| **API field** | `splitting` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Enable code splitting (shared chunks between entry points). Only works with `esm` format. |
| **Category** | **D — Not applicable** — requires multiple entry points and `outdir`, service returns a single bundle. |

---

#### 40. `preserveSymlinks`

| Property | Value |
|----------|-------|
| **CLI flag** | `--preserve-symlinks` |
| **API field** | `preserveSymlinks` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Resolve files by original path instead of real path (after following symlinks). |
| **Category** | **D — Not applicable** — no symlinks in a virtual filesystem. |

---

#### 41. `outfile`

| Property | Value |
|----------|-------|
| **CLI flag** | `--outfile=<path>` |
| **API field** | `outfile` |
| **Type** | `string` |
| **Default** | (none) |
| **Description** | Output file path for single-entry builds. |
| **Category** | **D — Not applicable** — service returns output in-memory, no filesystem write. |

---

#### 42. `metafile`

| Property | Value |
|----------|-------|
| **CLI flag** | `--metafile=<path>` |
| **API field** | `metafile` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Generate build metadata JSON (input/output analysis). |
| **Category** | **A — Already exposed** as `?metafile` |

---

#### 43. `outdir`

| Property | Value |
|----------|-------|
| **CLI flag** | `--outdir=<dir>` |
| **API field** | `outdir` |
| **Type** | `string` |
| **Default** | (none) |
| **Description** | Output directory for multi-entry builds. |
| **Category** | **D — Not applicable** — service returns output in-memory. |

---

#### 44. `outbase`

| Property | Value |
|----------|-------|
| **CLI flag** | `--outbase=<dir>` |
| **API field** | `outbase` |
| **Type** | `string` |
| **Default** | (lowest common ancestor of entry points) |
| **Description** | Base directory for replicating input directory structure in output. |
| **Category** | **D — Not applicable** — no meaningful directory structure in service context. |

---

#### 45. `external`

| Property | Value |
|----------|-------|
| **CLI flag** | `--external:fs` / `--external:*.png` |
| **API field** | `external` |
| **Type** | `string[]` |
| **Default** | `[]` |
| **Description** | Exclude packages/files from the bundle (preserved as imports in output). Supports wildcards. |
| **Category** | **B — Good candidate** — commonly needed to exclude peer deps. `?external=react,react-dom`. Comma-separated maps naturally to URL param. |

---

#### 46. `packages`

| Property | Value |
|----------|-------|
| **CLI flag** | `--packages=external` |
| **API field** | `packages` |
| **Type** | `'bundle' \| 'external'` |
| **Default** | `'bundle'` |
| **Description** | When `external`, all package imports are excluded from the bundle. |
| **Category** | **C — Better in `config`** — niche, defeats the purpose of a bundling service in most cases. |

---

#### 47. `alias`

| Property | Value |
|----------|-------|
| **CLI flag** | `--alias:old=new` |
| **API field** | `alias` |
| **Type** | `Record<string, string>` |
| **Default** | `{}` |
| **Description** | Substitute one package name for another before resolution. |
| **Category** | **C — Better in `config`** — record type. bundlejs has its own `config.alias` on `BuildConfig` that merges into this. |

---

#### 48. `loader`

| Property | Value |
|----------|-------|
| **CLI flag** | `--loader:.ext=type` |
| **API field** | `loader` |
| **Type** | `Record<string, Loader>` where `Loader = 'js' \| 'jsx' \| 'ts' \| 'tsx' \| 'css' \| 'json' \| 'text' \| 'base64' \| 'binary' \| 'dataurl' \| 'file' \| 'copy' \| 'local-css' \| 'empty' \| 'default'` |
| **Default** | inferred from file extension |
| **Description** | Map file extensions to content loaders. |
| **Category** | **C — Better in `config`** — record type with many possible entries. `?config={"esbuild":{"loader":{".svg":"text"}}}`. |

---

#### 49. `resolveExtensions`

| Property | Value |
|----------|-------|
| **CLI flag** | `--resolve-extensions=.ts,.js,.json` |
| **API field** | `resolveExtensions` |
| **Type** | `string[]` |
| **Default** | `['.tsx', '.ts', '.jsx', '.js', '.css', '.json']` |
| **Description** | Implicit file extensions tried during module resolution. |
| **Category** | **C — Better in `config`** — rarely changed, string array. |

---

#### 50. `mainFields`

| Property | Value |
|----------|-------|
| **CLI flag** | `--main-fields=module,main` |
| **API field** | `mainFields` |
| **Type** | `string[]` |
| **Default** | Depends on platform: `['browser','module','main']` (browser), `['main','module']` (node) |
| **Description** | package.json fields to check for entry point resolution. |
| **Category** | **C — Better in `config`** — expert-level, rarely changed from platform defaults. |

---

#### 51. `conditions`

| Property | Value |
|----------|-------|
| **CLI flag** | `--conditions=custom1,custom2` |
| **API field** | `conditions` |
| **Type** | `string[]` |
| **Default** | `[]` (platform auto-adds `browser`/`node` + `import`/`require`/`default`) |
| **Description** | Custom export conditions for package.json `exports` field resolution. |
| **Category** | **B — Good candidate** — simple comma-separated list, increasingly important for modern packages. `?conditions=worker,production`. |

---

#### 52. `write`

| Property | Value |
|----------|-------|
| **CLI flag** | (CLI always writes) |
| **API field** | `write` |
| **Type** | `boolean` |
| **Default** | `true` (CLI/JS), `false` (Go) |
| **Description** | Whether to write output to the filesystem or return in-memory. |
| **Category** | **D — Not applicable** — service always uses `write: false` to get in-memory output. |

---

#### 53. `allowOverwrite`

| Property | Value |
|----------|-------|
| **CLI flag** | `--allow-overwrite` |
| **API field** | `allowOverwrite` |
| **Type** | `boolean` |
| **Default** | `false` |
| **Description** | Allow output files to overwrite input files. |
| **Category** | **D — Not applicable** — no filesystem writes in service. |

---

#### 54. `tsconfig`

| Property | Value |
|----------|-------|
| **CLI flag** | `--tsconfig=<path>` |
| **API field** | `tsconfig` |
| **Type** | `string` |
| **Default** | auto-discovered `tsconfig.json` |
| **Description** | Path to a tsconfig.json file. |
| **Category** | **D — Not applicable** — filesystem path, use `tsconfigRaw` instead in `config`. |

---

#### 55. `outExtension`

| Property | Value |
|----------|-------|
| **CLI flag** | `--out-extension:.js=.mjs` |
| **API field** | `outExtension` |
| **Type** | `Record<string, string>` |
| **Default** | (none) |
| **Description** | Custom output file extensions. |
| **Category** | **D — Not applicable** — output file naming doesn't apply in service. |

---

#### 56. `publicPath`

| Property | Value |
|----------|-------|
| **CLI flag** | `--public-path=https://cdn.example.com/` |
| **API field** | `publicPath` |
| **Type** | `string` |
| **Default** | (none) |
| **Description** | Base path prepended to external file loader outputs. |
| **Category** | **C — Better in `config`** — rarely needed in a size-analysis service. |

---

#### 57. `entryNames`

| Property | Value |
|----------|-------|
| **CLI flag** | `--entry-names=[dir]/[name]-[hash]` |
| **API field** | `entryNames` |
| **Type** | `string` |
| **Default** | (none) |
| **Description** | Template for output file names of entry points. |
| **Category** | **D — Not applicable** — output naming not relevant in service. |

---

#### 58. `chunkNames`

| Property | Value |
|----------|-------|
| **CLI flag** | `--chunk-names=chunks/[name]-[hash]` |
| **API field** | `chunkNames` |
| **Type** | `string` |
| **Default** | (none) |
| **Description** | Template for code-split chunk file names. |
| **Category** | **D — Not applicable** — no code splitting in service. |

---

#### 59. `assetNames`

| Property | Value |
|----------|-------|
| **CLI flag** | `--asset-names=assets/[name]-[hash]` |
| **API field** | `assetNames` |
| **Type** | `string` |
| **Default** | (none) |
| **Description** | Template for asset file names (file loader). |
| **Category** | **D — Not applicable** — output naming not relevant in service. |

---

#### 60. `inject`

| Property | Value |
|----------|-------|
| **CLI flag** | `--inject:./shim.js` |
| **API field** | `inject` |
| **Type** | `string[]` |
| **Default** | `[]` |
| **Description** | Auto-import files that replace global variables with module imports. |
| **Category** | **D — Not applicable** — requires filesystem paths to injectable files. |

---

#### 61. `banner`

| Property | Value |
|----------|-------|
| **CLI flag** | `--banner:js=//comment` |
| **API field** | `banner` |
| **Type** | `Record<string, string>` (keys: `'js'`, `'css'`) |
| **Default** | `{}` |
| **Description** | Prepend arbitrary string to beginning of JS/CSS output. |
| **Category** | **C — Better in `config`** — record type, niche use (license headers, etc.). |

---

#### 62. `footer`

| Property | Value |
|----------|-------|
| **CLI flag** | `--footer:js=//comment` |
| **API field** | `footer` |
| **Type** | `Record<string, string>` (keys: `'js'`, `'css'`) |
| **Default** | `{}` |
| **Description** | Append arbitrary string to end of JS/CSS output. |
| **Category** | **C — Better in `config`** — record type, niche use. |

---

#### 63. `entryPoints`

| Property | Value |
|----------|-------|
| **CLI flag** | positional args / `--entry-points` |
| **API field** | `entryPoints` |
| **Type** | `string[] \| Record<string, string> \| { in: string, out: string }[]` |
| **Default** | `["/index.tsx"]` (bundlejs default) |
| **Description** | Input files to bundle. |
| **Category** | **D — Not applicable** — bundlejs constructs entry points from `?q` / `?text` / `?share` params. Exposed as `config.entryPoints` on `BuildConfig` but filtered out in parser. |

---

#### 64. `stdin`

| Property | Value |
|----------|-------|
| **CLI flag** | piped stdin |
| **API field** | `stdin` |
| **Type** | `StdinOptions` (`{ contents, resolveDir?, sourcefile?, loader? }`) |
| **Default** | (none) |
| **Description** | Provide input as an in-memory string instead of a file. |
| **Category** | **D — Not applicable** — bundlejs handles input via `?text` / `?share` / `?q`. |

---

#### 65. `plugins`

| Property | Value |
|----------|-------|
| **CLI flag** | (not available in CLI) |
| **API field** | `plugins` |
| **Type** | `Plugin[]` |
| **Default** | `[]` |
| **Description** | Custom build plugins (resolve/load hooks). |
| **Category** | **D — Not applicable** — plugins are code, not serializable via URL. bundlejs has its own plugin pipeline (CDN, HTTP, Tar, etc.). |

---

#### 66. `absWorkingDir`

| Property | Value |
|----------|-------|
| **CLI flag** | `cd <dir>` (working directory) |
| **API field** | `absWorkingDir` |
| **Type** | `string` |
| **Default** | `process.cwd()` |
| **Description** | Working directory for resolving relative paths. |
| **Category** | **D — Not applicable** — no meaningful working directory in a virtual filesystem service. |

---

#### 67. `nodePaths`

| Property | Value |
|----------|-------|
| **CLI flag** | `NODE_PATH=dir1:dir2` (env var) |
| **API field** | `nodePaths` |
| **Type** | `string[]` |
| **Default** | `[]` |
| **Description** | Additional directories to search for packages (like `NODE_PATH`). |
| **Category** | **D — Not applicable** — filesystem paths, no meaning in service. |

---

### Serve-only / Context-only options (NOT on BuildOptions)

These are **not** part of `BuildOptions` but are listed on the esbuild docs
under "General options":

| Option | Notes | Category |
|--------|-------|----------|
| `cancel` | Programmatic API for canceling incremental builds | **D** — service API, not a build option |
| `rebuild` | Programmatic API for incremental rebuilds | **D** — service API |
| `serve` | Start a dev server (host, port, servedir, keyfile, certfile, fallback, cors) | **D** — dev server, not applicable |
| `watch` | File-system watcher for auto-rebuild | **D** — dev server, not applicable |
| `live reload` | Serve + watch combination | **D** — dev server |

---

### Logging-only options (NOT on BuildOptions)

| Option | API | Type | Category |
|--------|-----|------|----------|
| `formatMessages` | standalone function | `(messages, options) → string[]` | **D** — utility function, not a build option |
| `analyzeMetafile` | standalone function | `(metafile, options) → string` | **D** — used internally by `?analysis`, not a build option |

---

## Summary by category

### A — Already exposed as direct URL params (7)

| esbuild field | URL param |
|---------------|-----------|
| `minify` | `?minify` / `?pretty` |
| `sourcemap` | `?sourcemap` |
| `format` | `?format` |
| `metafile` | `?metafile` |
| `jsx` (enable) | `?jsx` / `?tsx` (boolean only) |
| — | `?analysis` / `?analyze` |
| — | `?polyfill` (bundlejs-specific) |

### B — Good candidates for new URL params (12)

| esbuild field | Proposed URL param | Type | Why |
|---------------|-------------------|------|-----|
| `target` | `?target=es2020,chrome80` | `string \| string[]` | Most-requested after format/minify. Controls syntax downleveling. |
| `platform` | `?platform=node` | `enum` | Simple 3-value enum, affects resolution + output. |
| `globalName` | `?global-name=MyLib` | `string` | Essential when `format=iife`. |
| `treeShaking` | `?tree-shaking=false` | `boolean` | Sometimes users need to disable it. |
| `external` | `?external=react,react-dom` | `string[]` | Very commonly needed for peer dependencies. |
| `conditions` | `?conditions=worker` | `string[]` | Increasingly important for modern packages. |
| `keepNames` | `?keep-names` | `boolean` | Useful for framework users (Angular, etc.). |
| `drop` | `?drop=console` | `enum[]` | Commonly requested production optimization. |
| `legalComments` | `?legal-comments=none` | `enum` | Control license comment handling. |
| `jsxFactory` | `?jsx-factory=h` | `string` | Essential for Preact/custom JSX. |
| `jsxFragment` | `?jsx-fragment=Fragment` | `string` | Pairs with jsxFactory. |
| `jsxImportSource` | `?jsx-import-source=preact` | `string` | Essential for automatic JSX mode. |

### C — Better left in `config` JSON5 (22)

| esbuild field | Why `config` is better |
|---------------|------------------------|
| `sourceRoot` | Niche, only with sourcemaps |
| `sourcesContent` | Niche, only with sourcemaps |
| `supported` | Complex record, dozens of keys |
| `mangleProps` | RegExp type, unsafe, expert |
| `reserveProps` | RegExp, depends on mangleProps |
| `mangleQuoted` | Depends on mangleProps |
| `dropLabels` | Niche |
| `minifyWhitespace` | Granular minify control |
| `minifyIdentifiers` | Granular minify control |
| `minifySyntax` | Granular minify control |
| `lineLimit` | Niche formatting |
| `charset` | Rarely needed |
| `ignoreAnnotations` | Debugging escape hatch |
| `jsxDev` | Dev-only, not for size analysis |
| `jsxSideEffects` | Niche JSX libs |
| `define` | Record type, variable keys |
| `pure` | String array, variable length |
| `logLevel` | Service controls logging |
| `logLimit` | Service controls logging |
| `logOverride` | Complex record |
| `tsconfigRaw` | Complex JSON object |
| `alias` (esbuild) | Record type (bundlejs has own `config.alias`) |
| `loader` | Record type, many entries |
| `resolveExtensions` | Rarely changed |
| `mainFields` | Expert, platform sets defaults |
| `packages` | Defeats purpose of bundling service |
| `publicPath` | Rarely needed |
| `banner` | Record type |
| `footer` | Record type |

### D — Not applicable (17)

| esbuild field | Why not applicable |
|---------------|--------------------|
| `bundle` | Always `true` in bundlejs |
| `splitting` | Requires outdir, multi-entry |
| `preserveSymlinks` | No real filesystem |
| `outfile` | In-memory output |
| `outdir` | In-memory output |
| `outbase` | In-memory output |
| `write` | Always `false` (in-memory) |
| `allowOverwrite` | No filesystem writes |
| `tsconfig` | Filesystem path |
| `outExtension` | Output naming |
| `entryNames` | Output naming |
| `chunkNames` | Output naming |
| `assetNames` | Output naming |
| `inject` | Filesystem paths |
| `entryPoints` | Constructed from `?q` |
| `stdin` | Handled by `?text`/`?share` |
| `plugins` | Code, not serializable |
| `absWorkingDir` | No real working directory |
| `nodePaths` | Filesystem paths |
| `mangleCache` | Persistent state |
| `color` | Internal logging |
| `cancel` / `rebuild` / `serve` / `watch` | Context/server APIs |

---

## bundlejs-specific `BuildConfig` fields (not from esbuild)

These are bundlejs extensions on `BuildConfig` that wrap or augment esbuild:

| Field | Type | URL param? | Notes |
|-------|------|------------|-------|
| `init` | `InitOptions` | No | Internal WASM init config, filtered out in parser |
| `cdn` | `string` | No (in `config`) | Default CDN host for package resolution |
| `polyfill` | `boolean` | `?polyfill` | Enable Node.js built-in polyfills |
| `registry` | `string \| RegistryConfig` | No (in `config`) | Custom npm registry |
| `remapFalse` | `RemapFalseBehavior` | No (in `config`) | How to handle `false` in browser/exports maps |
| `alias` | `Record<string, string>` | No (in `config`) | Package aliases (separate from esbuild's alias) |
| `ansi` | `string` | No | Log format, internal |
| `entryPoints` | same as esbuild | No | Filtered out in parser |
| `resolve` | `ResolverConditionInputs` | No (in `config`) | Custom resolution condition config |
| `package.json` | `PackageJson` | No (in `config`) | Root package.json for dependency versions |

### BundleConfig extensions (edge layer):

| Field | Type | URL param? | Notes |
|-------|------|------------|-------|
| `compression` | `CompressConfig` | No (in `config`) | Compression algorithm selection |
| `analysis` | `boolean \| string` | `?analysis` / `?analyze` | Enable analysis output |
| `tsx` | `boolean` | `?tsx` / `?jsx` | Enable JSX/TSX loader |
