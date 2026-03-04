# BundleJS URL Configuration Parameters

Companion document to the [URL DSL Spec](./url-dsl-spec.md). This spec
defines every URL query parameter that controls the build and response behavior
of BundleJS. The goal is to make the most common esbuild flags accessible as
simple `?key=value` params so users rarely need the `config` JSON blob.

---

## Design principles

1. **Every standalone param MUST have a 1:1 mapping to a well-known option.**
   If it's an esbuild option, name it after the esbuild CLI flag (kebab-case).
   If it's BundleJS-specific, keep it short but unambiguous.

2. **Standalone params override `config` blob values.** If both `?minify=false`
   and `config={"esbuild":{"minify":true}}` appear, the standalone param wins.

3. **Boolean params** follow these rules:
   - Present with no value (`?minify`) → `true`
   - Present with empty value (`?minify=`) → `true`
   - `?minify=true` → `true`
   - `?minify=false` → `false`
   - `?pretty` is the logical inverse of `minify`.

4. **List params** use comma separation: `?external=fs,path,crypto`.

5. **Map params** use `key:value` pairs with comma separation:
   `?define=process.env.NODE_ENV:"production",DEBUG:false`.

6. **The `config` blob remains** as a catch-all for any option too complex for
   a flat URL param. If an option has both a standalone param and a `config`
   equivalent, the standalone param takes priority.

---

## Quick reference table

| Param | Type | Default | esbuild equivalent | Section |
|---|---|---|---|---|
| `v` | `1` | — | — | §1 |
| `q` / `query` | string | `spring-easing` | — | §1 |
| `base` | string | `auto\|default` | — | §1 |
| `treeshake` | string | — | — | §1 |
| `share` | string | — | — | §1 |
| `text` | string | — | — | §1 |
| `config` | JSON5 | — | — | §2 |
| `format` | enum | `esm` | `--format` | §3.1 |
| `platform` | enum | `browser` | `--platform` | §3.2 |
| `target` | string | `esnext` | `--target` | §3.3 |
| `minify` | bool | `true` | `--minify` | §3.4 |
| `pretty` | bool | `false` | inverse of `--minify` | §3.4 |
| `minify-syntax` | bool | — | `--minify-syntax` | §3.4 |
| `minify-whitespace` | bool | — | `--minify-whitespace` | §3.4 |
| `minify-identifiers` | bool | — | `--minify-identifiers` | §3.4 |
| `sourcemap` | bool/enum | `false` | `--sourcemap` | §3.5 |
| `tree-shaking` | bool | `true` | `--tree-shaking` | §3.6 |
| `splitting` | bool | `false` | `--splitting` | §3.7 |
| `global-name` | string | `BundledCode` | `--global-name` | §3.8 |
| `charset` | enum | — | `--charset` | §3.9 |
| `legal-comments` | enum | — | `--legal-comments` | §3.10 |
| `line-limit` | int | — | `--line-limit` | §3.11 |
| `jsx` | enum | `transform` | `--jsx` | §4.1 |
| `jsx-factory` | string | — | `--jsx-factory` | §4.2 |
| `jsx-fragment` | string | — | `--jsx-fragment` | §4.3 |
| `jsx-import-source` | string | — | `--jsx-import-source` | §4.4 |
| `jsx-dev` | bool | `false` | `--jsx-dev` | §4.5 |
| `jsx-side-effects` | bool | `false` | `--jsx-side-effects` | §4.6 |
| `tsx` / `jsx` (flag) | bool | `false` | — | §4.7 |
| `target` | string(s) | `esnext` | `--target` | §5.1 |
| `supported` | map | — | `--supported` | §5.2 |
| `define` | map | — | `--define` | §6.1 |
| `pure` | list | — | `--pure` | §6.2 |
| `drop` | list | — | `--drop` | §6.3 |
| `drop-labels` | list | — | `--drop-labels` | §6.4 |
| `keep-names` | bool | `false` | `--keep-names` | §6.5 |
| `ignore-annotations` | bool | `false` | `--ignore-annotations` | §6.6 |
| `inject` | list | — | `--inject` | §6.7 |
| `banner` | string | — | `--banner:js` | §6.8 |
| `footer` | string | — | `--footer:js` | §6.9 |
| `external` | list | — | `--external` | §7.1 |
| `alias` | map | — | `--alias` | §7.2 |
| `conditions` | list | — | `--conditions` | §7.3 |
| `main-fields` | list | — | `--main-fields` | §7.4 |
| `resolve-extensions` | list | — | `--resolve-extensions` | §7.5 |
| `loader` | map | — | `--loader` | §7.6 |
| `tsconfig-raw` | string | — | `--tsconfig-raw` | §7.7 |
| `log-level` | enum | `info` | `--log-level` | §7.8 |
| `cdn` | enum/string | `esm.sh` | — | §8.1 |
| `compression` | enum | `gzip` | — | §8.2 |
| `compression-quality` | int | — | — | §8.3 |
| `polyfill` | bool | `false` | — | §8.4 |
| `registry` | string | — | — | §8.5 |
| `analysis` / `analyze` | bool/enum | — | `--analyze` | §9.1 |
| `metafile` | bool | — | `--metafile` | §9.2 |
| `file` | bool | — | — | §9.3 |
| `badge` | bool/enum | — | — | §9.4 |
| `badge-style` | string | — | — | §9.5 |
| `badge-raster` / `png` | bool | — | — | §9.6 |
| `warnings` | bool | — | — | §9.7 |
| `raw` | bool | — | — | §9.8 |

---

## 1) Module DSL parameters

These are fully specified in [url-dsl-spec.md](./url-dsl-spec.md). Summary for
completeness:

| Param | Purpose |
|---|---|
| `v` | Spec version. Canonical links MUST include `v=1`. |
| `q` / `query` | Comma-separated module list with optional `(import)` prefix. |
| `base` | Default bracket payload applied to modules without overrides. |
| `treeshake` | Per-module bracket overrides (positional or sparse). |
| `share` | LZ-compressed input code. |
| `text` | Raw input code as a string. |

---

## 2) `config` — JSON5 configuration blob

```
?config={"cdn":"esm.sh","compression":"brotli","esbuild":{"format":"cjs","minify":false}}
```

The `config` param accepts a JSON5 string with the full `BuildConfig` shape.
It is a catch-all for options that have no standalone URL param, or for
combining many options at once. Its structure:

```ts
interface ConfigBlob {
  esbuild?: Partial<ESBUILD.BuildOptions>;
  cdn?: string;
  compression?: CompressionConfig;
  polyfill?: boolean;
  alias?: Record<string, string>;
  registry?: string | RegistryConfig;
  resolve?: ResolverConditionInputs;
  remapFalse?: RemapFalseBehavior;
  "package.json"?: PackageJson;
}
```

**Priority rule:** standalone URL params > `config` blob > server defaults.

---

## 3) Output shape

### 3.1 `format` — output format

```
?format=esm      (default)
?format=cjs
?format=iife
```

Maps to esbuild's [`--format`](https://esbuild.github.io/api/#format).

| Value | Description |
|---|---|
| `esm` | ECMAScript modules. Uses `import`/`export`. |
| `cjs` | CommonJS. Uses `require`/`module.exports`. |
| `iife` | Immediately-invoked function expression. Wraps code in a closure. |

### 3.2 `platform` — target platform

```
?platform=browser    (default)
?platform=node
?platform=neutral
```

Maps to esbuild's [`--platform`](https://esbuild.github.io/api/#platform).
Affects default format, main fields, conditions, and built-in handling.

| Value | Default format | Main fields | Auto conditions |
|---|---|---|---|
| `browser` | `iife` (if bundled) | `browser,module,main` | `browser` |
| `node` | `cjs` (if bundled) | `main,module` | `node` |
| `neutral` | `esm` (if bundled) | *(empty)* | *(none)* |

Note: BundleJS overrides the format to `esm` by default regardless of
platform, since the output is consumed by the size-calculation pipeline.

### 3.3 `target` — language target

```
?target=esnext            (default)
?target=es2020
?target=es2020,chrome80
?target=chrome80,firefox78,safari14
```

Maps to esbuild's [`--target`](https://esbuild.github.io/api/#target).
Comma-separated list of environment targets. Controls which JS/CSS syntax
features esbuild will down-level. Supported targets:

- Language versions: `es2015`..`es2024`, `esnext`
- Browsers: `chrome`, `edge`, `firefox`, `safari`, `ios`, `opera`
- Runtimes: `node`, `deno`, `hermes`, `rhino`
- Legacy: `ie`

Examples:

```
?target=es2018              → down-level to ES2018
?target=chrome90,firefox90  → only down-level for those browsers
```

### 3.4 `minify` — minification

```
?minify             → true (enable all minification)
?minify=false       → disable all minification
?pretty             → same as ?minify=false
?pretty=false       → same as ?minify=true
```

Maps to esbuild's [`--minify`](https://esbuild.github.io/api/#minify).

Additionally, the three sub-flags are available for fine-grained control:

```
?minify-syntax=true
?minify-whitespace=true
?minify-identifiers=false
```

These correspond to esbuild's `--minify-syntax`, `--minify-whitespace`, and
`--minify-identifiers` respectively. When any sub-flag is present, it overrides
the corresponding component of the `minify` setting.

**Default:** `true` (BundleJS minifies by default to measure production size).

### 3.5 `sourcemap` — source map generation

```
?sourcemap              → true (linked/inline depending on response mode)
?sourcemap=inline       → inline base64 source map
?sourcemap=external     → separate .map (only meaningful with ?file)
?sourcemap=false        → no source map
```

Maps to esbuild's [`--sourcemap`](https://esbuild.github.io/api/#sourcemap).
Valid values: `true`, `false`, `linked`, `external`, `inline`, `both`.

### 3.6 `tree-shaking` — dead code elimination

```
?tree-shaking=true      (default when bundling)
?tree-shaking=false
```

Maps to esbuild's [`--tree-shaking`](https://esbuild.github.io/api/#tree-shaking).
BundleJS always bundles, so tree shaking is on by default.

### 3.7 `splitting` — code splitting

```
?splitting=true
?splitting=false    (default)
```

Maps to esbuild's [`--splitting`](https://esbuild.github.io/api/#splitting).
Only works with `format=esm`. Enables shared chunks between entry points.

### 3.8 `global-name` — global variable name

```
?global-name=MyLib
?global-name=MyApp.utils
```

Maps to esbuild's [`--global-name`](https://esbuild.github.io/api/#global-name).
Only applies when `format=iife`. Controls the global variable that receives
the bundle's exports.

**Default:** `BundledCode`.

### 3.9 `charset` — output character set

```
?charset=utf8
```

Maps to esbuild's [`--charset`](https://esbuild.github.io/api/#charset).
When set to `utf8`, non-ASCII characters are preserved instead of escaped.

### 3.10 `legal-comments` — legal comment handling

```
?legal-comments=none
?legal-comments=inline
?legal-comments=eof
?legal-comments=external
```

Maps to esbuild's [`--legal-comments`](https://esbuild.github.io/api/#legal-comments).
Controls how `@license` and `@preserve` comments are treated.

### 3.11 `line-limit` — maximum line length

```
?line-limit=80
?line-limit=120
```

Maps to esbuild's [`--line-limit`](https://esbuild.github.io/api/#line-limit).
Positive integer. Inserts newlines to keep lines approximately within this
character limit.

---

## 4) JSX configuration

### 4.1 `jsx` — JSX transform mode

```
?jsx=transform      (default)
?jsx=preserve
?jsx=automatic
```

Maps to esbuild's [`--jsx`](https://esbuild.github.io/api/#jsx).

| Value | Behavior |
|---|---|
| `transform` | Convert JSX to `React.createElement` calls (general-purpose). |
| `preserve` | Keep JSX syntax in output (for downstream tools). |
| `automatic` | React 17+ automatic runtime. Auto-imports from `jsxImportSource`. |

### 4.2 `jsx-factory` — JSX factory function

```
?jsx-factory=h
?jsx-factory=React.createElement
```

Maps to esbuild's [`--jsx-factory`](https://esbuild.github.io/api/#jsx-factory).
Only applies when `jsx=transform`.

### 4.3 `jsx-fragment` — JSX fragment component

```
?jsx-fragment=Fragment
?jsx-fragment=React.Fragment
```

Maps to esbuild's [`--jsx-fragment`](https://esbuild.github.io/api/#jsx-fragment).
Only applies when `jsx=transform`.

### 4.4 `jsx-import-source` — JSX auto-import package

```
?jsx-import-source=preact
?jsx-import-source=react
```

Maps to esbuild's [`--jsx-import-source`](https://esbuild.github.io/api/#jsx-import-source).
Only applies when `jsx=automatic`. The package MUST expose `/jsx-runtime` and
`/jsx-dev-runtime` subpaths.

### 4.5 `jsx-dev` — JSX development mode

```
?jsx-dev
?jsx-dev=true
```

Maps to esbuild's [`--jsx-dev`](https://esbuild.github.io/api/#jsx-dev).
Only applies when `jsx=automatic`. Injects file name and source location into
each JSX element for debugging.

### 4.6 `jsx-side-effects` — JSX side effects

```
?jsx-side-effects
?jsx-side-effects=true
```

Maps to esbuild's [`--jsx-side-effects`](https://esbuild.github.io/api/#jsx-side-effects).
When set, JSX expressions are NOT annotated with `/* @__PURE__ */`, meaning
they won't be tree-shaken when unused. Required for JSX libraries where
expressions have side effects.

### 4.7 `tsx` / `jsx` (flag) — enable JSX/TSX file mode

```
?tsx
?jsx
```

**BundleJS-specific.** These boolean flags change the entry point extension
from `.ts` to `.tsx`, enabling JSX syntax in the input code. Both `?tsx` and
`?jsx` are aliases for the same behavior.

This is separate from the `jsx` *transform mode* param (§4.1). The transform
mode controls *how* JSX is compiled; this flag controls *whether* JSX syntax
is accepted.

---

## 5) Transformation

### 5.1 `target` — language target

See §3.3.

### 5.2 `supported` — per-feature syntax support

```
?supported=bigint:false,top-level-await:false
?supported=decorators:true
```

Maps to esbuild's [`--supported`](https://esbuild.github.io/api/#supported).
Comma-separated `feature:bool` pairs that override the `target` setting at the
individual syntax feature level.

Feature names use esbuild's naming convention (kebab-case). Notable features:

| Feature | Description |
|---|---|
| `arrow` | Arrow functions |
| `async-await` | Async/await |
| `bigint` | BigInt literals |
| `class` | ES6 classes |
| `class-field` | Public class fields |
| `class-static-field` | Static class fields |
| `decorators` | TC39 decorators |
| `dynamic-import` | `import()` expressions |
| `import-attributes` | `import ... with { }` |
| `optional-chain` | `?.` operator |
| `top-level-await` | TLA in modules |
| `using` | Explicit resource management |

See [esbuild docs](https://esbuild.github.io/api/#supported) for the complete
list.

---

## 6) Optimization

### 6.1 `define` — compile-time constants

```
?define=process.env.NODE_ENV:"production"
?define=DEBUG:false,VERSION:"1.0.0"
```

Maps to esbuild's [`--define`](https://esbuild.github.io/api/#define).
Comma-separated `identifier:expression` pairs. String values MUST be quoted
(including the surrounding quotes in the URL): `"production"` becomes
`%22production%22` when URL-encoded, or use JSON5 quoting.

### 6.2 `pure` — pure function annotations

```
?pure=console.log
?pure=console.log,console.warn
```

Maps to esbuild's [`--pure`](https://esbuild.github.io/api/#pure).
Comma-separated list of global function names. Calls to these functions are
annotated with `/* @__PURE__ */` and removed when unused + minification is
enabled.

### 6.3 `drop` — drop constructs

```
?drop=debugger
?drop=console
?drop=debugger,console
```

Maps to esbuild's [`--drop`](https://esbuild.github.io/api/#drop).
Comma-separated list. Valid values: `debugger`, `console`.

### 6.4 `drop-labels` — drop labeled statements

```
?drop-labels=DEV
?drop-labels=DEV,TEST
```

Maps to esbuild's [`--drop-labels`](https://esbuild.github.io/api/#drop-labels).
Comma-separated list of label names to remove.

### 6.5 `keep-names` — preserve `.name` property

```
?keep-names
?keep-names=true
```

Maps to esbuild's [`--keep-names`](https://esbuild.github.io/api/#keep-names).
Preserves the `.name` property on functions and classes even when minifying.
Useful for frameworks (e.g. React DevTools) that rely on component display
names.

### 6.6 `ignore-annotations` — ignore `@__PURE__` and `sideEffects`

```
?ignore-annotations
?ignore-annotations=true
```

Maps to esbuild's [`--ignore-annotations`](https://esbuild.github.io/api/#ignore-annotations).
Disables the `/* @__PURE__ */` and `sideEffects` optimizations. Use this if
third-party packages have incorrect annotations that cause missing code.

### 6.7 `inject` — auto-import shims

```
?inject=./shim.js
?inject=./process-shim.js,./buffer-shim.js
```

Maps to esbuild's [`--inject`](https://esbuild.github.io/api/#inject).
Comma-separated list of file paths. These files are automatically imported
before the entry point. Useful for polyfill injection.

Note: In the BundleJS context, injected files must be resolvable by the
virtual file system (e.g., provided via `text` or `share`, or resolvable from
CDN). This param has limited utility in the URL API but is included for
completeness.

### 6.8 `banner` — prepend code

```
?banner=//+built+with+bundlejs
```

Maps to esbuild's [`--banner:js`](https://esbuild.github.io/api/#banner).
String prepended to the beginning of generated JavaScript output. Spaces
encoded as `+` in the URL.

### 6.9 `footer` — append code

```
?footer=//+end+of+bundle
```

Maps to esbuild's [`--footer:js`](https://esbuild.github.io/api/#footer).
String appended to the end of generated JavaScript output.

---

## 7) Resolution and loading

### 7.1 `external` — exclude packages from bundle

```
?external=fs
?external=fs,path,crypto
?external=*.png
?external=@scope/pkg
```

Maps to esbuild's [`--external`](https://esbuild.github.io/api/#external).
Comma-separated list of package names or patterns. Matched imports are
preserved as-is in the output instead of being bundled.

Supports glob patterns: `?external=*.png,/images/*`.

### 7.2 `alias` — package substitution

```
?alias=fs:memfs
?alias=react:preact/compat,react-dom:preact/compat
```

Maps to esbuild's [`--alias`](https://esbuild.github.io/api/#alias).
Comma-separated `old:new` pairs. Substitutions happen before all other path
resolution.

Also available via `config.alias` for direct object syntax.

### 7.3 `conditions` — package.json export conditions

```
?conditions=development
?conditions=worker,development
```

Maps to esbuild's [`--conditions`](https://esbuild.github.io/api/#conditions).
Comma-separated list of custom conditions for `exports` field resolution.

Built-in conditions (`default`, `import`, `require`, `browser`, `node`) are
always active based on the platform and import context. Custom conditions add
to these.

### 7.4 `main-fields` — package.json main fields

```
?main-fields=module,main
?main-fields=browser,module,main
```

Maps to esbuild's [`--main-fields`](https://esbuild.github.io/api/#main-fields).
Comma-separated list of `package.json` fields to check when resolving a
package's entry point. Order matters.

### 7.5 `resolve-extensions` — implicit file extensions

```
?resolve-extensions=.tsx,.ts,.jsx,.js,.css,.json
?resolve-extensions=.mjs,.js
```

Maps to esbuild's [`--resolve-extensions`](https://esbuild.github.io/api/#resolve-extensions).
Comma-separated list of file extensions to try when an import path doesn't
include an extension.

**Default:** `.tsx,.ts,.jsx,.js,.css,.json`

### 7.6 `loader` — file type interpretation

```
?loader=.png:dataurl
?loader=.svg:text,.wasm:binary,.json:json
```

Maps to esbuild's [`--loader`](https://esbuild.github.io/api/#loader).
Comma-separated `.ext:loader` pairs.

Available loaders:

| Loader | Description |
|---|---|
| `js` | JavaScript |
| `ts` | TypeScript |
| `jsx` | JSX |
| `tsx` | TSX |
| `json` | JSON |
| `css` | CSS |
| `text` | Plain text (exported as string) |
| `binary` | Binary (exported as Uint8Array) |
| `base64` | Base64 encoded string |
| `dataurl` | Data URL string |
| `file` | External file (copies and returns path) |
| `copy` | Copy file to output |
| `empty` | Empty file (produces nothing) |
| `local-css` | CSS modules (locally-scoped names) |
| `global-css` | CSS modules (globally-scoped names) |

### 7.7 `tsconfig-raw` — inline tsconfig

```
?tsconfig-raw={"compilerOptions":{"useDefineForClassFields":false}}
```

Maps to esbuild's [`--tsconfig-raw`](https://esbuild.github.io/api/#tsconfig-raw).
JSON string with TypeScript configuration. Useful for controlling TypeScript
behavior without a `tsconfig.json` file.

### 7.8 `log-level` — esbuild log level

```
?log-level=error
?log-level=warning
?log-level=silent
```

Maps to esbuild's [`--log-level`](https://esbuild.github.io/api/#log-level).

| Value | Shows |
|---|---|
| `silent` | Nothing |
| `error` | Errors only |
| `warning` | Errors + warnings |
| `info` | Errors + warnings + summary (default) |
| `debug` | Verbose debug info |

---

## 8) BundleJS-specific parameters

These parameters are unique to BundleJS and do not map to esbuild flags.

### 8.1 `cdn` — package CDN source

```
?cdn=esm.sh              (default)
?cdn=unpkg
?cdn=jsdelivr
?cdn=skypack
?cdn=esm.run
```

Controls which CDN is used to fetch npm packages. Accepted values:

| Shorthand | Full URL |
|---|---|
| `esm.sh` / `esm` | `https://esm.sh` |
| `unpkg` | `https://unpkg.com` |
| `esm.run` | `https://esm.run` |
| `skypack` | `https://cdn.skypack.dev` |
| `jsdelivr` | `https://cdn.jsdelivr.net/npm` |
| `jsdelivr.gh` | `https://cdn.jsdelivr.net/gh` |
| `deno` | `https://deno.land/x` |
| `github` | `https://raw.githubusercontent.com` |
| `npm` / `npm.registry` | `https://registry.npmjs.org` |
| `jsr` / `jsr.registry` | `https://esm.sh/jsr` |

A full URL can also be provided: `?cdn=https://my-registry.example.com`.

### 8.2 `compression` — compression algorithm

```
?compression=gzip         (default)
?compression=brotli
?compression=zstd
?compression=lz4
```

Controls the compression algorithm used to calculate the compressed bundle
size. This affects the `size.compressedSize` field in the response.

### 8.3 `compression-quality` — compression level

```
?compression-quality=6
?compression-quality=11
```

Integer from 1–11. Only applies to `brotli` and `zstd` compression. Has no
effect with `gzip` or `lz4`.

### 8.4 `polyfill` — Node.js built-in polyfills

```
?polyfill
?polyfill=true
```

Boolean. When enabled, Node.js built-in modules (`fs`, `path`, `crypto`,
etc.) are replaced with browser-compatible polyfill packages instead of being
left unresolved or marked external.

### 8.5 `registry` — custom npm registry

```
?registry=https://npm.jsr.io
?registry=@jsr:registry=https://npm.jsr.io
```

String value. Can be:
- A registry URL: `?registry=https://npm.jsr.io`
- Raw `.npmrc` content: `?registry=@jsr:registry=https://npm.jsr.io`

For structured registry config with scoped registries, use the `config` blob
instead:

```
?config={"registry":{"registry":"https://registry.npmjs.org","scopedRegistries":{"@jsr":"https://npm.jsr.io"}}}
```

---

## 9) Response mode parameters

These parameters control *what* BundleJS returns, not how the bundle is built.
They are mutually exclusive in most cases — the first matching mode wins.

### 9.1 `analysis` / `analyze` — bundle analysis

```
?analysis
?analyze
?analyze=verbose
```

Returns an HTML page with a visual analysis of the bundle contents using
esbuild's [`analyzeMetafile`](https://esbuild.github.io/api/#analyze). When
set to `verbose`, includes the full import chain for each file.

Also available as pathname: `/analysis`, `/analyze`.

### 9.2 `metafile` — esbuild metafile JSON

```
?metafile
```

Returns the raw esbuild
[metafile](https://esbuild.github.io/api/#metafile) as JSON. This can be
uploaded to
[esbuild's Bundle Size Analyzer](https://esbuild.github.io/analyze/) or
consumed by custom tooling.

Also available as pathname: `/metafile`.

### 9.3 `file` — bundled JavaScript output

```
?file
```

Returns the actual bundled JavaScript code as `text/javascript`. The response
can be imported directly into a browser:

```js
import { something } from "https://deno.bundlejs.com/?q=some-pkg&file";
```

Also available as pathname: `/file`.

### 9.4 `badge` — SVG size badge

```
?badge
?badge=detailed
?badge=minified
```

Returns an SVG badge (via shields.io) showing the bundle size.

| Value | Description |
|---|---|
| *(empty)* | Compressed size badge |
| `detailed` | Includes module names in the badge |
| `minified` | Shows minified (uncompressed) size instead |

Also available as pathname: `/badge`.

### 9.5 `badge-style` — badge visual style

```
?badge-style=flat
?badge-style=flat-square
?badge-style=for-the-badge
?badge-style=plastic
?badge-style=social
```

Controls the [shields.io style](https://shields.io/#styles) of the badge.
Only meaningful when `?badge` is also present.

### 9.6 `badge-raster` / `png` — raster badge

```
?badge-raster
?png
```

Returns the badge as a PNG image instead of SVG. Only meaningful when `?badge`
is also present.

Also available as pathname: `/badge/raster`, `/badge-raster`.

### 9.7 `warnings` — build warnings

```
?warnings
```

Returns an HTML page listing all build warnings for the bundle. Useful for
debugging resolution and compatibility issues.

Also available as pathname: `/warnings`.

### 9.8 `raw` — raw JSON result

```
?raw
```

Returns the complete build result as JSON, including all fields (metafile,
warnings, timing, config, etc.). Intended for debugging and integration.

Also available as pathname: `/raw`.

---

## 10) Parameter parsing rules

### 10.1 Boolean coercion

```
convertQueryValue(str):
  "false" → false
  "true"  → true
  ""      → true (param present with no value)
  null    → undefined (param absent)
  other   → string (passed through)
```

### 10.2 List parsing

Comma-separated values. Whitespace around items is trimmed.

```
?external=fs, path, crypto  →  ["fs", "path", "crypto"]
```

### 10.3 Map parsing

Comma-separated `key:value` pairs. The first `:` splits key from value.

```
?alias=react:preact/compat,react-dom:preact/compat
→ { "react": "preact/compat", "react-dom": "preact/compat" }
```

For `define`, the value is a JavaScript expression (may contain `:`):

```
?define=process.env.NODE_ENV:"production"
→ { "process.env.NODE_ENV": '"production"' }
```

### 10.4 Precedence

1. Standalone URL param (highest priority)
2. `config` JSON blob
3. Server defaults (lowest priority)

Within the `config` blob, `esbuild` sub-object values are deep-merged with
defaults.

---

## 11) Esbuild flags NOT exposed as URL params

The following esbuild options are intentionally omitted because they are either
controlled by BundleJS internally, not meaningful in the URL-based API context,
or too dangerous for public URL use:

| Option | Reason |
|---|---|
| `bundle` | Always `true` — BundleJS always bundles. |
| `entryPoints` | Controlled by the module DSL (`q`, `base`, `treeshake`). |
| `stdin` | Controlled by `text` and `share` params. |
| `outdir` / `outfile` / `outbase` | Server controls output location. |
| `write` | Always `false` — output is in-memory. |
| `allowOverwrite` | Not applicable (no disk output). |
| `assetNames` / `chunkNames` / `entryNames` | Not applicable (single output). |
| `publicPath` | Not applicable. |
| `outExtension` | Not applicable. |
| `watch` / `serve` / `rebuild` / `cancel` | Server lifecycle, not per-request. |
| `tsconfig` | No filesystem access. Use `tsconfig-raw` instead. |
| `nodePaths` | No filesystem access. |
| `preserveSymlinks` | No filesystem access. |
| `workingDirectory` | No filesystem access. |
| `sourcefile` | Controlled internally by entry point hashing. |
| `sourceRoot` | Not applicable (no filesystem source lookup). |
| `sourcesContent` | Not applicable. |
| `mangleProps` / `reserveProps` / `mangleCache` / `mangleQuoted` | Too dangerous — can silently break code with no way to debug via URL. |
| `packages` | BundleJS controls external resolution through its plugin pipeline. |
| `color` | Server-side only. |
| `formatMessages` | API-only (programmatic use). |
| `logLimit` | Not meaningful for single-shot URL builds. |
| `logOverride` | Complex map — use `config` blob if needed. |
| `absPath` | Not applicable. |

For any omitted option, users can still set it via the `config` blob:

```
?config={"esbuild":{"mangleProps":"_$","logOverride":{"css-syntax-error":"silent"}}}
```

---

## 12) Worked examples

### E01 — Minimal: just minified size of react

```
?q=react
```

Uses all defaults: `format=esm`, `minify=true`, `compression=gzip`,
`base=auto|default`.

### E02 — CJS format, no minification

```
?q=lodash&format=cjs&minify=false
```

### E03 — Multiple targets, source maps

```
?q=react,react-dom/client&target=es2020,chrome80&sourcemap=inline
```

### E04 — JSX with Preact

```
?q=preact&tsx&jsx=automatic&jsx-import-source=preact
```

### E05 — Define build-time constants

```
?q=my-lib&define=process.env.NODE_ENV:"production",__DEV__:false
```

### E06 — External packages with polyfills

```
?q=my-lib&external=fs,path&polyfill
```

### E07 — Brotli compression with max quality

```
?q=react&compression=brotli&compression-quality=11
```

### E08 — Custom CDN and registry

```
?q=@jsr/std-path&cdn=jsr&registry=https://npm.jsr.io
```

### E09 — Get raw metafile for analysis

```
?q=react,react-dom&metafile
```

### E10 — SVG badge for README

```
?q=react&badge=detailed&badge-style=flat-square
```

### E11 — Full config blob fallback

```
?q=my-pkg&config={"esbuild":{"mangleProps":"_$","logOverride":{"css-syntax-error":"silent"}},"alias":{"fs":"memfs"}}
```

### E12 — Combining standalone params with config

```
?q=my-pkg&minify=false&format=cjs&config={"esbuild":{"keepNames":true},"cdn":"unpkg"}
```

Here `minify=false` and `format=cjs` override anything in the config blob's
`esbuild` section, but `keepNames` and `cdn` from the blob still apply.

### E13 — Strip console and debugger

```
?q=my-lib&drop=console,debugger
```

### E14 — Per-feature syntax support

```
?q=my-lib&target=es2020&supported=decorators:true,using:false
```

### E15 — Custom loader for file types

```
?q=my-lib&loader=.svg:text,.png:dataurl,.wasm:binary
```

---

## 13) Canonical URL parameter order

When generating share links, emit parameters in this order for consistency:

1. `v=1`
2. `q=...`
3. `base=...`
4. `treeshake=...`
5. Build params (alphabetically): `banner`, `charset`, `compression`,
   `compression-quality`, `conditions`, `cdn`, `define`, `drop`,
   `drop-labels`, `external`, `footer`, `format`, `global-name`,
   `ignore-annotations`, `inject`, `jsx`, `jsx-dev`, `jsx-factory`,
   `jsx-fragment`, `jsx-import-source`, `jsx-side-effects`, `keep-names`,
   `legal-comments`, `line-limit`, `loader`, `log-level`, `main-fields`,
   `minify`, `minify-identifiers`, `minify-syntax`, `minify-whitespace`,
   `platform`, `polyfill`, `pure`, `registry`, `resolve-extensions`,
   `sourcemap`, `splitting`, `supported`, `target`, `tree-shaking`,
   `tsconfig-raw`
6. Input params: `share`, `text`
7. `config=...` (only if needed for options without standalone params)
8. Response mode params: `analysis`, `badge`, `badge-raster`, `badge-style`,
   `file`, `metafile`, `raw`, `warnings`

Omit params that match the server default to keep URLs short.

---

## 14) Implementation notes

### 14.1 Param-to-esbuild mapping function

The implementation should have a single function that reads all standalone
params from the URL and produces a partial `BuildOptions` object, which is
then deep-merged with the `config` blob and the server defaults:

```ts
function parseStandaloneParams(url: URL): Partial<BuildConfig> {
  const params = url.searchParams;
  const esbuild: Partial<ESBUILD.BuildOptions> = {};
  const config: Partial<BuildConfig> = { esbuild };

  // Format
  if (params.has("format")) esbuild.format = params.get("format");

  // Platform
  if (params.has("platform")) esbuild.platform = params.get("platform");

  // Target
  if (params.has("target")) esbuild.target = params.get("target")!.split(",");

  // Minify
  if (params.has("minify")) esbuild.minify = coerceBool(params.get("minify"));
  if (params.has("pretty")) esbuild.minify = !coerceBool(params.get("pretty"));
  if (params.has("minify-syntax")) esbuild.minifySyntax = coerceBool(params.get("minify-syntax"));
  if (params.has("minify-whitespace")) esbuild.minifyWhitespace = coerceBool(params.get("minify-whitespace"));
  if (params.has("minify-identifiers")) esbuild.minifyIdentifiers = coerceBool(params.get("minify-identifiers"));

  // ... etc for all params

  return config;
}
```

### 14.2 Merge order

```ts
const finalConfig = deepMerge(
  deepMerge(SERVER_DEFAULTS, configBlob),
  parseStandaloneParams(url)
);
```

### 14.3 Validation

Invalid enum values should fall back to defaults with a warning. Invalid
numbers should be ignored. Unknown params should be ignored (forward
compatibility).
