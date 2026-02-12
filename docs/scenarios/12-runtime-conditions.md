# Scenario 12 — Runtime-Specific Condition Sets

> Tests that each supported runtime profile produces the correct condition set, and that conditions flow correctly through the entire resolution pipeline.

bundlejs supports 10+ runtime profiles via `getResolverConditions()` and `getRuntimeDefaults()`. Each profile adds runtime-specific conditions and controls whether the legacy `browserField` is active.

```
  ┌─────────────────────┐
  │  getResolverConditions()  │
  │                     │
  │  1. import/require  │ ← from format + import kind
  │  2. platform        │ ← browser/node/neutral
  │  3. module          │ ← esbuild convention (auto)
  │  4. runtime overlay │ ← deno/bun/workerd/etc.
  │  5. user conditions │ ← explicit config
  │  6. default         │ ← always last
  └─────────────────────┘
```


## 12.1 — Default browser conditions

**What it tests:** The default condition set when no runtime is specified.

```
/?q=solid-js@1.9.4
```

Expected conditions: `["import", "browser", "module", "default"]`, `browserField: true`.

**Regression signal:** If `"browser"` is missing from conditions, platform detection is broken.


## 12.2 — Deno runtime

**What it tests:** Deno adds `["deno", "node"]` conditions, disables `browserField`.

```
/?q=solid-js@1.9.4&config={"resolve":{"runtime":"deno"}}
```

Expected conditions: `["import", "browser" or "node" based on platform, "module", "deno", "node", "default"]`.
`browserField: false`.

With `platform: "neutral"`:

```
/?q=solid-js@1.9.4&config={"resolve":{"runtime":"deno"},"esbuild":{"platform":"neutral"}}
```

Expected: no platform-specific condition added from platform (neutral adds neither `browser` nor `node`), but `deno` runtime adds `["deno", "node"]` → conditions include `"deno"` and `"node"`.

**Regression signal:** If the `"deno"` condition is absent, runtime overlay is not being applied.


## 12.3 — Bun runtime

**What it tests:** Bun adds `["bun", "node"]` conditions.

```
/?q=solid-js@1.9.4&config={"resolve":{"runtime":"bun"}}
```

Expected: conditions include `"bun"` and `"node"`. `browserField: false`.

Packages that declare `"bun"` in their exports (like some Bun-optimized FFI packages) should resolve to the Bun-specific path.

**Regression signal:** If `"bun"` is missing from conditions, the runtime overlay for Bun is broken.


## 12.4 — Cloudflare Workers (workerd)

**What it tests:** Workers adds `["workerd", "worker", "browser"]` but sets `browserField: false`.

```
/?q=solid-js@1.9.4&config={"resolve":{"runtime":"workerd"}}
```

Expected: conditions include `"workerd"`, `"worker"`, `"browser"`. `browserField: false`.

This means:
- `"browser"` condition matches in `exports` (Workers want browser-optimized code paths)
- But the legacy `browser` field remappings are NOT applied (Workers are server-like)

**Regression signal:** If `browserField` is `true` for workerd, workers get unwanted browser polyfill swaps from the legacy browser field.


## 12.5 — Vercel Edge (edge-light)

**What it tests:** Edge Light adds `["edge-light", "worker", "browser"]` with `browserField: true`.

```
/?q=solid-js@1.9.4&config={"resolve":{"runtime":"edge-light"}}
```

Expected: conditions include `"edge-light"`, `"worker"`, `"browser"`. `browserField: true`.

This is different from Workers — Edge Light DOES apply legacy browser field remappings.

**Regression signal:** If `browserField` is `false` for edge-light, Vercel Edge builds miss browser field remappings that they should apply.


## 12.6 — React Native runtime

**What it tests:** React Native adds `["react-native"]` with `browserField: false`.

```
/?q=solid-js@1.9.4&config={"resolve":{"runtime":"react-native"}}
```

Expected: conditions include `"react-native"`. `browserField: false`.

For packages like `@exodus/bytes` with a top-level `"react-native"` remapping field, the generalized `applyManifestRemappings()` checks this condition and applies remappings.

**Regression signal:** If `"react-native"` is missing from conditions, React Native-specific code paths in packages are never activated.


## 12.7 — Electron main process

**What it tests:** Electron main adds `["electron", "node"]` with `browserField: false`.

```
/?q=uuid@11.0.5&config={"resolve":{"runtime":"electron-main"}}
```

Expected: conditions `["import", "node", "module", "electron", "node", "default"]` (deduplicated: `"node"` appears once). `browserField: false`.

Resolution for uuid: `"node"` condition matches → node path.

**Regression signal:** If the electron main process gets browser paths, the `"electron"` condition is not being applied or `platform` is being overridden.


## 12.8 — Electron renderer

**What it tests:** Electron renderer adds `["electron", "browser"]` with `browserField: true`.

```
/?q=uuid@11.0.5&config={"resolve":{"runtime":"electron-renderer"}}
```

Expected: conditions include `"electron"` and `"browser"`. `browserField: true`.

Resolution for uuid: `"browser"` condition matches → browser path. Plus `"electron"` condition activates the `"electron"` remapping field for relative imports.

**Regression signal:** If the renderer gets Node paths, the `"browser"` condition from the electron-renderer overlay is missing.


## 12.9 — Custom conditions (user-provided)

**What it tests:** The user can add custom conditions that are not built-in.

```
/?q=solid-js@1.9.4&config={"esbuild":{"conditions":["development"]}}
```

Expected: `"development"` is added to the condition list. For solid-js, this activates the `browser.development.import` path → `./dist/dev.js`.

```
/?q=solid-js@1.9.4&config={"esbuild":{"conditions":["development","react-server"]}}
```

Expected: both `"development"` and `"react-server"` are in conditions. If the package has `"react-server"` exports (like React does), those paths are activated.

**Regression signal:** If custom conditions have no effect on resolution, the user-condition injection in `getResolverConditions()` is broken.


## 12.10 — Condition deduplication

**What it tests:** When runtime overlay and platform both contribute the same condition, it appears only once.

```
/?q=uuid@11.0.5&config={"resolve":{"runtime":"electron-renderer"},"esbuild":{"platform":"browser"}}
```

Expected: both `platform: "browser"` and `electron-renderer` overlay contribute `"browser"`. The final conditions list should contain `"browser"` exactly once.

**Regression signal:** If `"browser"` appears twice, some resolvers might behave unexpectedly (though the `resolve.exports` library handles this gracefully).


## 12.11 — `require` context from CJS format

**What it tests:** Setting `format: "cjs"` switches the import/require dimension.

```
/?q=uuid@11.0.5&config={"esbuild":{"format":"cjs"}}
```

Expected: `isRequireContext()` returns `true` (entry-point with CJS format) → `"require"` is the first condition instead of `"import"` → `"require"` condition in exports matches.

**Regression signal:** If the CJS build gets the ESM entry, the import/require dimension is not being derived from format.


## 12.12 — Conditions flow through to HttpPlugin remapping

**What it tests:** The conditions computed for CdnPlugin resolution are also available to the HttpPlugin for manifest field remapping.

This is the end-to-end test: conditions are computed in CdnPlugin, stored implicitly via the `effectiveResolveOpts`, and recomputed in HttpPlugin's `HttpResolution` for the `applyManifestRemappings()` call.

**Package:** `@exodus/bytes@1.13.0` with React Native runtime:

```
/?q=@exodus/bytes@1.13.0&config={"resolve":{"runtime":"react-native"}}
```

Expected: CdnPlugin resolves the entry point. HttpPlugin resolves relative imports. The HttpPlugin recomputes conditions via `getResolverConditions(args, effectiveResolveOpts)` → includes `"react-native"` → `applyManifestRemappings()` uses the `"react-native"` field.

**Regression signal:** If HttpPlugin produces different conditions than CdnPlugin (e.g., missing the runtime overlay), the `effectiveResolveOpts` propagation is broken. This would manifest as entry-point resolution using React Native paths but internal imports using browser paths.
