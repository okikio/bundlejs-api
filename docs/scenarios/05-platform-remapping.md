# Scenario 05 — Platform-Specific Remapping (react-native, electron)

> Tests manifest field remappings beyond the `browser` field — specifically `"react-native"` and `"electron"` top-level fields that follow the same object-remapping pattern.

These fields are community conventions adopted by their respective ecosystems:

| Field | Convention | Ecosystem |
|:------|:-----------|:----------|
| `"browser"` | Browserify / webpack / esbuild | Web browsers |
| `"react-native"` | Metro bundler | React Native apps |
| `"electron"` | Electron | Desktop apps (Chromium + Node) |

bundlejs implements generalized support via `REMAPPING_FIELDS` in `cdn-resolution.ts`, ordered most-specific to least-specific: `react-native` → `electron` → `browser`. The first matching field wins.


## 5.1 — React Native string-form entry point

**What it tests:** The `react-native` field as a string replaces the entry point when the `react-native` condition is active.

**Package:** `react-native-safe-area-context@5.1.0`

```json
{
  "main": "lib/commonjs/index.js",
  "module": "lib/module/index.js",
  "react-native": "src/index.tsx"
}
```

**React Native build:**

```
/?q=react-native-safe-area-context@5.1.0&config={"resolve":{"runtime":"react-native"}}
```

Expected: `getRuntimeDefaults("react-native")` → `{ conditions: ["react-native"], browserField: false }`. Legacy resolution with `react-native` as the platform should pick `src/index.tsx`.

> **Note:** The string-form `react-native` field is handled at the legacy resolution level (similar to string-form `browser`). This test verifies that the resolver recognizes the field and gives it appropriate priority.

**Browser build:**

```
/?q=react-native-safe-area-context@5.1.0
```

Expected: `react-native` field ignored → `module` → `lib/module/index.js`.

**Regression signal:** If the React Native build loads `lib/commonjs/index.js` (CJS) or `lib/module/index.js` (ESM), the `react-native` field is being ignored.


## 5.2 — React Native object-form path remapping

**What it tests:** The `react-native` top-level field as an object (just like browser field object form). PackagePlugin applies remappings for relative imports when the `react-native` condition is active.

**Package:** `@exodus/bytes@1.13.0`

```json
{
  "browser": {
    "./fallback/platform.js": "./fallback/platform.browser.js",
    "./fallback/utf8.auto.js": "./fallback/utf8.auto.browser.js"
  },
  "react-native": {
    "./fallback/platform.js": "./fallback/platform.native.js",
    "./fallback/utf8.auto.js": "./fallback/utf8.auto.native.js"
  }
}
```

**React Native build:**

```
/?q=@exodus/bytes@1.13.0&config={"resolve":{"runtime":"react-native"}}
```

When internal code imports `"./fallback/platform.js"`:

Expected: `react-native` condition is active → `REMAPPING_FIELDS` priority: `react-native` comes before `browser` → `"react-native"` field matches → remaps to `"./fallback/platform.native.js"`.

**Browser build:**

```
/?q=@exodus/bytes@1.13.0
```

Expected: `browser` condition is active (not `react-native`) → `"browser"` field matches → remaps to `"./fallback/platform.browser.js"`.

**Regression signal:**
- If the React Native build gets `platform.browser.js` instead of `platform.native.js`, the priority order is wrong (browser is being checked before react-native).
- If the React Native build gets `platform.js` (original, unremapped), remapping is not being applied for the `react-native` field at all.


## 5.3 — Priority when multiple remapping fields match

**What it tests:** When both `react-native` and `browser` conditions are active simultaneously, the more-specific field (`react-native`) wins.

Construct a scenario where both conditions are present:

```
/?q=@exodus/bytes@1.13.0&config={"esbuild":{"conditions":["react-native","browser"],"platform":"browser"}}
```

Expected: both `react-native` and `browser` are in the active conditions set → `REMAPPING_FIELDS` iterates in order → `react-native` comes first → remaps to `platform.native.js`.

**Regression signal:** If `platform.browser.js` is chosen, the priority ordering in `REMAPPING_FIELDS` is not being respected.


## 5.4 — Electron renderer remapping

**What it tests:** The `electron` condition activates the `"electron"` remapping field for Electron renderer builds.

**Synthetic test:**

```json
{
  "name": "test-electron-remap",
  "version": "1.0.0",
  "main": "./lib/index.js",
  "browser": {
    "./lib/crypto.js": "./lib/crypto.browser.js"
  },
  "electron": {
    "./lib/crypto.js": "./lib/crypto.electron.js"
  }
}
```

**Electron renderer build:**

```
/?q=test-electron-remap&config={"resolve":{"runtime":"electron-renderer"}}
```

Expected: `getRuntimeDefaults("electron-renderer")` → `{ conditions: ["electron", "browser"], browserField: true }`. When internal code imports `"./lib/crypto.js"`:
- Both `electron` and `browser` conditions are active
- `REMAPPING_FIELDS` priority: `react-native` (not active) → `electron` (active!) → first match wins
- Remaps to `./lib/crypto.electron.js`

**Electron main process build:**

```
/?q=test-electron-remap&config={"resolve":{"runtime":"electron-main"}}
```

Expected: `getRuntimeDefaults("electron-main")` → `{ conditions: ["electron", "node"], browserField: false }`. Electron condition active, browser not active → `electron` remapping still applies → `./lib/crypto.electron.js`.

**Browser build:**

```
/?q=test-electron-remap
```

Expected: only `browser` condition active → `electron` remapping field skipped → `browser` remapping applies → `./lib/crypto.browser.js`.

**Regression signal:** If the electron renderer build gets `crypto.browser.js`, the `electron` field is not being checked before `browser`.


## 5.5 — No remapping field matches (pass-through)

**What it tests:** When the active conditions do not match any remapping field, the path passes through unchanged.

**Package:** `@exodus/bytes@1.13.0` with Deno runtime:

```
/?q=@exodus/bytes@1.13.0&config={"resolve":{"runtime":"deno"}}
```

Expected: `getRuntimeDefaults("deno")` → `{ conditions: ["deno", "node"], browserField: false }`. None of `react-native`, `electron`, or `browser` conditions are active → `applyManifestRemappings()` returns `{ matchedField: null }` → path is not remapped.

Internal imports like `"./fallback/platform.js"` resolve to the original path (the Node.js implementation).

**Regression signal:** If Deno builds get browser-remapped paths, a condition is leaking into the active set when it should not be.


## 5.6 — Remapping field with `false` exclusion (non-browser)

**What it tests:** The `false` exclusion pattern works for non-browser remapping fields too.

**Synthetic test:**

```json
{
  "react-native": {
    "./lib/dom-impl.js": false,
    "./lib/platform.js": "./lib/platform.native.js"
  }
}
```

**React Native build:**

When internal code imports `"./lib/dom-impl.js"`:

Expected: `react-native` field matches → value is `false` → `applyManifestRemappings()` returns `{ excluded: true, matchedField: "react-native" }` → PackagePlugin calls `buildExclusionResult()`, which checks `remapFalse.importRemapFalse` policy. With the default `"stub"` policy, returns the import in the `EXCLUDED_MODULE_NAMESPACE` (empty export stub). With `"error"`, produces a build error mentioning the `react-native` field.

**Regression signal:** If the error message says `"excluded by "browser" field"` when the match came from `react-native`, the `matchedField` is not being propagated correctly.


## 5.7 — Remapping only applies to relative imports, not entry points

**What it tests:** The generalized `applyManifestRemappings()` is only called by PackagePlugin for relative imports within a package. Entry point resolution follows its own path through `resolveLegacy()`.

**Package:** `@exodus/bytes@1.13.0`

```
/?q=@exodus/bytes@1.13.0
```

The *entry point* resolution goes through `resolveLegacy()`, which handles `browser` string/object field for the entry point. The *internal relative imports* go through `applyManifestRemappings()` in PackagePlugin's onResolve handlers.

These are two separate code paths:
1. `CdnPlugin → resolvePackageEntry() → resolveLegacy()` — entry point
2. `PackagePlugin → onResolve → applyManifestRemappings()` — relative imports

Both must apply remappings, but through different mechanisms.

**Regression signal:** If entry point remapping works but internal path remapping does not (or vice versa), one of the two code paths is broken. The original browser remapping bug was exactly this — entry point resolution worked, but relative import remapping was missing entirely.
