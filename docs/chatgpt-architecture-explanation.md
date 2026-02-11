# BundleJS: a usage-first architecture tour (beginning → end)

This is a “guided tour” of BundleJS as a utility: how you run it, what it can do, and how the internals are shaped to make correct usage easy.

---

## 1. What this tool is (and why you’d use it)

BundleJS is a **Deno workspace** made of four main modules: **`core`**, **`edge`**, **`utils`**, and **`compress`**. 

* **`@bundle/edge`**: an HTTP service (Deno Deploy–style) that receives a request, parses query/config, bundles/transforms, then responds (often with caching). The server uses `Deno.serve(...)` as its runtime entry. 
* **`@bundle/core`**: the bundling engine built on **esbuild** (WASM-backed in this repo), plus a pipeline of plugins that make remote/module resolution work across environments. `core/mod.ts` re-exports the engine surface (`build`, `transform`, `context`, `init`, etc.). 
* **`@bundle/utils`**: the shared “standards-first” toolbox: npm/jsr spec parsing, import-map resolution, conditional exports resolution, archive detection, cache utilities, etc. (You can see the set of utilities in the tree.) 
* **`@bundle/compress`**: compression primitives (gzip/brotli/zstd/lz4) exposed as library APIs, used to measure/produce compressed outputs. 

Why you’d use it (the practical value): **it’s designed to bundle “anywhere”** (edge/server/browser-ish contexts) by leaning on **web standards (fetch/streams/URLs)** + **esbuild’s plugin hooks**, rather than assuming Node-only filesystem access. That design shows up directly in the way `edge` invokes `core`, and in how `core` implements “fetch + resolve + cache + bundle” as a plugin pipeline. 

You described the end goal as: **“bundle everywhere and anywhere… emulating runtimes across various JS runtimes (Node in browser, API bundling, plain browser bundling).”** I’ll treat that as the guiding product intent for the architecture you’re seeing.

---

## 2. The mental model: how to think about BundleJS

Think of BundleJS as two layers:

1. **A “bundling service” interface** (HTTP, share URLs, analysis views, caching)
2. **A “bundling engine”** (esbuild + resolution plugins + filesystem abstraction)

Here’s the end-to-end flow:

```
[ Client (browser / curl / another service) ]
                  |
                  v
        [ @bundle/edge: Deno.serve ]
                  |
        parse query + config + mode
                  |
                  v
          [ @bundle/core: build/transform ]
                  |
     esbuild + plugin pipeline resolves/loads
                  |
                  v
     [ outputs: JS/CSS + metafile + notices ]
                  |
                  v
     [ @bundle/edge: format + cache + respond ]
```

This shape is visible in `edge/mod.ts` (HTTP entry), which pulls in `bundle(...)` and other helpers, and in `core/build.ts` (the esbuild call with plugins). 

---

## 3. Getting value quickly (first 30–60 minutes)

### Run the edge service locally

The `edge/README.md` shows the “fast path” to run locally:

```bash
deno serve -A --env-file=.env --watch mod.ts
```



### Configure the minimum env vars (only if you want caching / GitHub integration)

`edge/mod.ts` constructs an Upstash Redis client using:

* `UPSTASH_URL`
* `UPSTASH_TOKEN`



It also initializes an Octokit client from:

* `GITHUB_AUTH_TOKEN`



If those aren’t present, behavior is **partly resilient**: cache init is wrapped so Redis can fail without taking the whole server down. 

### What a successful “first run” looks like

* The server starts (Deno.serve). 
* Requests can ask for different response “modes” (bundle output, analysis, badge, etc.), described in the OpenAPI spec under `edge/.well-known/openapi.yaml`. 

If you want a single thing to try first: hit the root service with a “bundle this” query using the OpenAPI-described query parameters (details below). 

---

## 4. Primary usage patterns

### Pattern A: “Bundle as a service” (HTTP)

The OpenAPI definition is the most reliable contract for what the service accepts/returns. 
This is the pattern you use when you want **URL-driven bundling** (shareable links, quick experiments, embedding into docs/tools).

### Pattern B: “Bundle as a library” (import `@bundle/core`)

`core/mod.ts` exports the engine surface: `build`, `transform`, `context`, `init`, plus configs and types. 
This is the pattern you use when you want **embedding** (your own API, your own UI, your own pipeline), but you still want the exact same resolution behavior BundleJS uses.

### Pattern C: “Compression as a utility”

`compress/mod.ts` exports `compress(...)` and `decompress(...)`, plus config/types for choosing algorithm + quality. 
This is useful both for **serving smaller outputs** and for **reporting bundle sizes**.

---

## 5. Commands, options, and nuanced features (what actually matters)

### The `core` config surface (what you can control)

At the engine level, `BuildConfig` tells you what BundleJS considers configurable: `entryPoints`, `resolve`, `esbuild` options, `packageJson`, `alias`, `cdn`, `polyfill`, `init`, and output-related toggles like ANSI/log formatting. 

At the service level, `edge/parse-query.ts` is where URL parameters are converted into that config shape (including special parsing like “share URL query → entry source”). 

### Compression knobs

`@bundle/compress` exposes:

* algorithms: `"gzip" | "brotli" | "zstd" | "lz4"` 
* quality (only for brotli/zstd) 
* defaults via `COMPRESS_CONFIG` and `createCompressConfig(...)` 

And its implementation intentionally prefers **Web Compression Streams when available**, falling back when they aren’t present. (Example: gzip path checks `CompressionStream` existence.) 

---

## 6. How it works (only what helps correct usage)

### 6.1 esbuild as the base (what you’re building on)

esbuild is a fast bundler/minifier with:

* a **build API** (bundle, minify, output files, metafile, etc.) ([esbuild.github.io][1])
* a **plugin API** built around `onResolve` and `onLoad`, where you can intercept module resolution/loading ([esbuild.github.io][2])
* a **WASM build** (`esbuild-wasm`) for environments where native binaries aren’t available ([npmjs.com][3])

BundleJS uses that “plugin interception” model as its core trick: **make module resolution and fetching work in non-Node environments by implementing resolution/load in plugins**, then let esbuild do what it’s great at: parsing, bundling, tree-shaking, codegen.  ([esbuild.github.io][2])

### 6.2 How BundleJS initializes esbuild (WASM path)

`cor:contentReference[oaicite:30]{index=30}that the engine is selecting the **WASM-backed** esbuild module (currently returning `ESBUILD_DENO_WASM`) and managing versioning (`defaultVersion = "0.27.2"`in this snapshot). :contentReference[oaicite:31]{index=31}  `core/init.ts`then wires that into an initialization flow (using the chosen esbuild entry + wasm source). :contentReference[oaicite:32]{index=32}:contentReference[oaicite:33]{index=33}ou care as a user:** if you embed`@bundle/core`, you should call `init(...)` once per runtime boot (or rely othe WASM loader path is part of correctness/perf. 

### 6.3 The build pipeline (what happens when you “bundle”)

In `core/build.ts`, BundleJS constructs a plugin list and true`, `write: false`, and a set of defaults tuned for the “browser-like” target (e.g. `platform: "browser"`). 

The **observed plugin order in the build** is:

```
AliasPlugin
ExternalPlugin
VirtualFileSystemPlugin
TarballPlugi:contentReference[oaicite:38]{index=38}:contentReference[oaicite:39]{index=39}

> Important gotcha: `core/plugins/tar.ts` documents that it “must be placed before `HttpPlugin` and `VirtualFileSys:contentReference[oaicite:40]{index=40}ple order with Tarball before VFS. :contentReference[oaicite:41]{index=41}  
> That’s a real mismatch between *documented* and *observed* ordering. You shouldn’t assume which is “right” witho:contentReference[oaicite:42]{index=42}e “Gotchas” later).

After the build, `core/build.ts` formats errors/warnings into “notice” objects and computes per-package size totals. :contentReference[oaicite:43]{index=43}

### 6.4 Incremental builds (when you don’t want a cold start every time)
`core/context.ts` provides a wrapper over e:contentReference[oaicite:44]{index=44}ng an object that supports `rebuild()`, `cancel()`, and `dispose()`.   
This is how you’d build “interactive bundling” (e.g., editor/REPL, repeated builds in one session) without paying request.

### 6.5 What BundleJS adds on top of esbuild (the “why it exists” part)
This is the main value: **esbuild doesn’t fetch npm packages, doesn’t understand import maps by itself, and doesn’t know your CDN conventions**. BundleJS adds those via plugins and shared resolution utilities.

You can see the “standards-first” approach in the implementation choices:

- **Web `fetch()` is the transport** (HTTP plugin and CDN resolver use fetchable URLs rather than Node fs assumptions). :contentReference[oaicite:47]{index=47}  
- **Web `URL` is the specifier substrate** (e.g., share URL parsing and import-map behavior are URL-native). :contentReference[oaicite:48]{index=48}:contentReference[oaicite:49]{index=49}  
- **Web Streams** show up explicitly in compression fallbacks and stream-based utili:contentReference[oaicite:51]{index=51}r:contentReference[oaicite:54]{index=54}  
- **`structuredClone`** is used for config cloning/merging (a “web standard” convenience). :contentReference[oaicite:55]{index=55}:contentReference[oaicite:56]{index=56} algorithms (with 5+ real scenarios)

BundleJS’s “resolution algorithm” is not one function; i:contentReference[oaicite:57]{index=57}specifier intent (npm/jsr/url/import-map)  
2) normalize to a fetchable URL or VFS key  
3) apply exports/imports/conditions semantics  
4) mark externals / polyfills where needed  
5) cache in VFS / filesystem abstraction  
6) hand resolved paths back to esbuild

You can see the distinct parts in `@bundle/utils`:
- `npm-spec.ts`, `jsr-spec.ts`, `parse-package-name.ts` for spec parsing :contentReference[oaicite:58]{index=58}  
- `resolve-import-map.ts` for import-map rules   
- `resolve-exports-imports.ts` + `r:contentReference[oaicite:60]{index=60}age.json exports/conditions semantics :contentReference[oaicite:63]{index=63}  
And in `core/utils/cdn-resolution.ts` for the “CDN-facing” package resolution layer (entry selection, peer deps, si:contentReference[oaicite:64]{index=64}

### Scenario 1: Bare package import (`react`)
**Observed behavior:** the CDN plugin exists explicitly to resolve “bam to a CDN URL and resolving package entrypoints. The plugin docs describe resolving “npm and jsr packages.” :contentReference[oaicite:67]{index=67}  
The CDN resolution layer exposes `resolveModern(...)` (a resolver that returns a resolved URL/path suitable for bro:contentReference[oaicite:68]{index=68}  

**What you do as a user:** use the service/library with a bare import, and ensure CDN config is set (host/origin rls/cdn-format.ts`). :contentReference[oaicite:71]{index=71}

### Scenario 2: Version-pinned npm spec (`react@18.2.0`)
`@bundle/utils/npm-spec.ts` exists specifically to parse np:contentReference[oaicite:72]{index=72}/range) rather than forcing URL imports everywhere. :contentReference[oaicite:73]{index=73}  
The CDN plugin’s goal is to take that parsed spec and produce a deterministic CDN URL (via the cdn-format layer). :contentReference[oaicite:74]{index=74}:contentReference[oaicite:75]{index=75}:contentReference[oaicite:76]{index=76}  

**Why this matters:** pinning versions is how you make “bundle as a service” reprodu:contentReference[oaicite:77]{index=77}g:contentReference[oaicite:78]{index=78}runtime`)
This is where **exports/imports and conditions** matter. BundleJS carries explicit utilities for:
- resolving `exports` / `imports` maps :contentReference[oaicite:79]{index=79}  
- selecting entries based on conditions like `browser`, `import`, etc. :contentReference[oaicite:80]{index=80}  
and the CDN :contentReference[oaicite:81]{index=81}plies those semantics while producing a concrete URL. :contentReference[oaicite:83]{index=83}port maps (aliasing `react` → some URL)
`resolve-import-map.ts` implements the import-map resoluti + specifier and producing the mapped target according to the import-map rules.   

**User-facing implication:** import maps are the cleanest way to do “project-level overrides” without embedding lo## Scenario 5: Remote URL import (`https://…/mod.ts`)
The HTTP plugin exists to resolve and load HTTP(S) modules. The file is explicitly named for that (`core/plugins/http.ts`), and it wires `setup(build)` hooks (esbuild plugin shape) plus resolution logic. :contentReference[oaicite:87]{index=87} :contentReference[oaicite:88]{index=88}  

**User-facing implication:** you can use URL imports naturally, and BundleJS will fetch them a:contentReference[oaicite:89]{index=89}ld’s bundler.

### Scenario 6 (bonus): Tarball imports (GitHub tarballs / pkg.pr.new)
The tarball plugin exists specifically to support archive-based dependency sources, and it documents the requirement to run before certain other plugins. :contentReference[oaicite:90]{index=90}  

**User-facing implication:** you can bundle from tarball sources (useful for PR previews / ephemeral builds) without pre-downloading dependencies.

---:contentReference[oaicite:91]{index=91}ct (and why the plugin order exists)

### `edge` → `core`
`edge/mod.ts` is the HTTP entrypoint; it imports `bundle(...)` and uses it to produce outputs for requests. :contentReference[oaicite:92]{index=92}  
That `bundle(...)` function (in `edge/bundle.ts`) is where the service turns parsed config/query into calls into `@bundle/core` (build/transform/etc.). :contentReference[oaicite:93]{index=93}:contentReference[oaicite:94]{index=94}
### `core` → esbuild + plugins
`core/build.ts` is the main orchestration point:
- build config + defaults :contentReference[oaicite:95]{index=95}  
- plugin pipeli:contentReference[oaicite:96]{index=96}:contentReference[oaicite:97]{index=97}  
- formatting build results + notices :contentReference[oaicite:98]{index=98}  

### `core` → `utils`
W:contentReference[oaicite:99]{index=99}odule semantics,” it reaches f:contentReference[oaicite:100]{index=100} parsing, import maps, conditional expor:contentReference[oaicite:101]{index=101}:contentReference[oaicite:102]{index=102}  
These utilities are what make resolution deterministic and portable across runtimes.

### `edge/core` → `compress`
Compression is a separate concern wit:contentReference[oaicite:103]{index=103})` / `decompress(...)` exported from `compress/mod.ts` :contentReference[oaicite:104]{index=104}  
- config creation `createCompressConfig(...)` uses deep merge + `structuredClone` to produce final settings :contentReference[oaicite:105]{index=105}  

---

## 9. :contentReference[oaicite:106]{index=106}roach (what the code is “optimizing for”)

These principles aren’t slogans in a README (at least not in the exc:contentReference[oaicite:107]{index=107} implied by consistent design choices** across modules:

1) **Standards-first runtime compatibility**  
   Web APIs like `fetch`, `URL`, Streams, and `structuredClone` are used as foundational building blocks. :contentReference[oaicite:109]{index=109}  

2) **Treeshakeability as a default expectation**  
   The resolver layer explicitly includes side-effects/entry selection logic (`resolveModern` mentio:contentReference[oaicite:110]{index=110} and `computeEsbuildSideEffects` exists in the CDN resolver surface).   
   And esbuild itself is built around tree-shaking as a core feature. :contentReference[oaicite:112]{index=112}  

3) **Composable pipeline via esbuild plugins**  
   The engi responsible for one class of specifiers (aliases, externals/polyfills, VFS caching, tarballs, HTTP, CDN). :contentReference[oaicite:114]{index=114}  

4) **Reproducibility via explicit parsing + config creation**  
   Config objects are produced via “create config” helpers (deep-merge + clone patterns) rather than ad-hoc mutation. :contentReference[oaicite:116]{index=116}:contentReference[oaicite:117]{index=117}  

---

## 10. What BundleJS *removes* support for vs *adds* on top of esbuild

### Added (evidence-backed)
- **CDN-aware npm/jsr resolution** (plugin docs + resolver surface). :contentReference[oaicite:119]{index=119}  
- **Import-map aware resolution** (`resolve-import-map.ts`).   
- **Tarball dependency sources** (tarball plugin). :contentReference[oaicite:122]{index=122}  
- **VFS/fiexists and is part of the build pipeline). :contentReference[oaicite:126]{index=126}  
- **Compression utilities with algorithm:contentReference[oaicite:127]{index=127}y**. :contentReference[oaicite:129]{index=129}  

### Removed / intentionally not relied on (inf:contentReference[oaicite:130]{index=130}rd dependency on Node’s filesystem/module loader**: the presence of a VFS layer and HTTP/CDN plugins strong:contentReference[oaicite:131]{index=131}“don’t assume local disk + Node resolution.” This is an inference based on the pipeline composition and the web-standard APIs used. :contentReference[oaicite:133]{index=133}  

If you want this section to be 100% observed-only, the next thing to inspect is `core/plugins/vfs.ts` and any filesystem backends referenced there (to see exactly what is “supported vs n:contentReference[oaicite:134]{index=134}:contentReference[oaicite:135]{index=135}

---

## 11. Why add extra functionality on top of esbuild?

Because esbuild is deliberately scoped:
- It bundles fast.
- It gives you hooks (`onResolve`, `onLoad`) to implement your own:contentReference[oaicite:136]{index=136}* ship a universal “fetch npm packages from CDNs, apply import maps, interpret exports conditions, cache into a portable VFS” solution out of the box. :contentReference[oaicite:137]{index=137}  

BundleJS is essentially: **“esbuild, plus a portable module system implemented as plugins and shared resolvers.”** The code makes that explicit by:
- treating resolution as plugins, not as ad-hoc pre-processing :contentReference[oaicite:138]{index=138}  
- pushing “package semantics” into reusable utilities (`resolve-exports-imports`, `resolve-conditions`, `resolve-import-map`) :contentReference[oaicite:139]{index=139}  

---

## 12. Limitations, trade-offs, and gotcha:contentReference[oaicite:140]{index=140}gin order mismatch (tarball docs vs actual build order)**  
   - Docs say Tarball must be before Http + VFS. :contentReference[oaicite:141]{index=141}:contentReference[oaicite:142]{index=142}ts` runs VFS before Tarball in the observed list. :contentReference[oaicite:143]{index=143}  
   This can cause “it works for some sources but not others” issues. The fastest disambiguation: add a test:contentReference[oaicite:144]{index=144}all URL and confirm it resolves in both orders.

2) **Service integrat:contentReference[oaicite:145]{index=145}edis and GitHub integrations rely on `UPSTASH_*` and `GITHUB_AUTH_TOKEN`. :contentReference[oaicite:147]{index=147}  

3) **Unknown from provided context**  
   - Exact response modes and payload shapes are best verified directly from the OpenAPI file (we saw it exists; read the `paths:` section fully). :contentReference[oaicite:148]{index=148}:contentReference[oaicite:149]{index=149}ing, caching TTL policy, or security constraints beyond what’s in `edge/mod.ts` are **unknown from provided context**.

---

## 13. What to do next (a concrete, ordered plan)

1) Run `@bundl:contentReference[oaicite:150]{index=150}DME command. :contentReference[oaicite:151]{index=151}  
2) Open `edge/.well-known/openapi.yaml` and pick one endpoint + one query parameter set to exercise first. :contentReference[oaicite:152]{index=152}  
3) Trace that request path in `edge/mod.ts` → `edge/bundle.ts` → `core/:contentReference[oaicite:153]{index=153}fileciteturn59file3L1-L11:contentReference[oaicite:156]{index=156}  
4) Read `core/build.ts` once just for: :contentReference[oaicite:157]{index=157}**, **result formatting**. :contentReference[oaicite:159]{index=159}  
5) Read `core/plugins/cdn.ts` + `core/utils/cdn-reso:contentReference[oaicite:160]{index=160}“bare specifier → CDN URL” path.   
6) Read `utils/resolve-import-map:contentReference[oaicite:163]{index=163}ns.ts`, `utils/resolve-exports-imports.ts` and map them to Scenario 1–5 above. L1-L20:contentReference[oaicite:166]{index=166}u want “editor mode” or repeated builds, switch to `core/context.ts` and use `rebuild()`/`dispose()` appropriately.   
8) Decide whether you need tarball support early; i:contentReference[oaicite:169]{index=169}ering mismatch with a regression test. :contentReference[oaicite:171]{index=171}  
9) Only then: tune comprescaching (Redis/GitHub) to match your deployment needs. :contentReference[oaicite:174]{index=174}  

---

If you want, I can generate :contentReference[oaicite:175]{index=175}on → plugin → fetch → vfs → esbuild → response” trace** for one concrete OpenAPI endpoint (purely from the YAML + code) so a new teammate can d:contentReference[oaicite:176]{index=176}utes—without needing to learn the whole repo first.
::contentReference[oaicite:177]{index=177}
```

[1]: https://esbuild.github.io/api/ "https://esbuild.github.io/api/"
[2]: https://esbuild.github.io/plugins/ "https://esbuild.github.io/plugins/"
[3]: https://www.npmjs.com/package/esbuild-wasm "https://www.npmjs.com/package/esbuild-wasm"
