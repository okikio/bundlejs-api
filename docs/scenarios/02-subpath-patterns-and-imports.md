# Scenario 02 — Subpath Patterns and Subpath Imports

> Tests wildcard patterns in `exports`, deep subpath resolution, and the private `#` imports mechanism.


## Subpath Exports (Wildcard Patterns)

> **Spec background:** [Subpath patterns](https://nodejs.org/api/packages.html#subpath-patterns) use a single `*` wildcard in both key and value. The `*` in the key captures a segment, and the `*` in the value substitutes it. Only **one** `*` is allowed per key/value pair. Explicit subpath keys always take priority over wildcard patterns.


### 2.1 — Basic wildcard pattern

**What it tests:** The `*` in `"./*"` captures a segment and substitutes into the value.

**Package:** `solid-js@1.9.4`

```json
{
  "exports": {
    ".": { /* root entry */ },
    "./web": { /* explicit subpath */ },
    "./dist/*": "./dist/*",
    "./web/dist/*": "./web/dist/*"
  }
}
```

```
/?q=solid-js@1.9.4/dist/solid.js
```

Expected: subpath `"./dist/solid.js"` → matches `"./dist/*"` → captures `"solid.js"` → substitutes into `"./dist/*"` → `./dist/solid.js`.

**Regression signal:** If the resolver returns a resolution error, it cannot match wildcard patterns.


### 2.2 — Explicit key takes priority over wildcard

**What it tests:** When both an explicit subpath and a wildcard could match, the explicit key wins.

**Package:** `solid-js@1.9.4`

```
/?q=solid-js@1.9.4/web
```

Expected: `"./web"` matches the explicit key (with its conditional exports), **not** `"./web/dist/*"`. The explicit key produces a different file than what the wildcard would produce.

**Regression signal:** If the resolver picks the wildcard pattern instead of the explicit key, subpath priority is broken.


### 2.3 — Wildcard with conditional exports

**What it tests:** A wildcard pattern whose value is a conditional map (conditions applied *after* pattern matching).

**Package:** `rxjs@7.8.1`

```json
{
  "exports": {
    ".": { /* root */ },
    "./operators": { /* explicit */ },
    "./internal/*": {
      "node": "./dist/cjs/internal/*.js",
      "types": "./dist/types/internal/*.d.ts",
      "es2015": "./dist/esm/internal/*.js",
      "default": "./dist/esm5/internal/*.js",
      "require": "./dist/cjs/internal/*.js"
    }
  }
}
```

**Browser build:**

```
/?q=rxjs@7.8.1/internal/operators/map
```

Expected: `"./internal/*"` matches → captures `"operators/map"` → `"default"` condition → `./dist/esm5/internal/operators/map.js`.

**Node build:**

```
/?q=rxjs@7.8.1/internal/operators/map&config={"esbuild":{"platform":"node"}}
```

Expected: `"node"` condition → `./dist/cjs/internal/operators/map.js`.

**Regression signal:** If the file path does not substitute the captured segment into both the pattern and the condition value, the resolved URL contains a literal `*`.


### 2.4 — Overlapping: explicit subpath vs wildcard

**What it tests:** `rxjs/operators` has an explicit entry, while `rxjs/internal/*` is a wildcard. An import of `rxjs/operators` must hit the explicit key.

```
/?q=rxjs@7.8.1/operators
```

Expected: matches `"./operators"` (explicit) → not the `"./internal/*"` wildcard. The explicit key resolves through its own condition map.

```
/?q=rxjs@7.8.1/internal/operators/map
```

Expected: matches `"./internal/*"` (wildcard) — the explicit `"./operators"` key does not apply here.

**Regression signal:** If `rxjs/operators` falls through to the wildcard or vice versa, the priority algorithm (explicit > pattern) is broken.


---

## Subpath Imports (`#` Prefix)

> **Spec background:** [Subpath imports](https://nodejs.org/api/packages.html#subpath-imports) use the `"imports"` field in `package.json`. Keys start with `#` and are **private to the package** — only code *within* the package can use them. They serve as internal aliases that can vary by condition (e.g., different implementations for Node vs browser).
>
> Critical behavior: if a `#`-prefixed import fails resolution, it is a **hard error** — the resolver must never fall through and treat it as a bare npm package name.


### 2.5 — Conditional `#` import (node vs browser)

**What it tests:** A `#`-prefixed import resolves through the `imports` field with condition branching.

**Package:** `chalk@5.4.1`

```json
{
  "imports": {
    "#ansi-styles": "./source/vendor/ansi-styles/index.js",
    "#supports-color": {
      "node": "./source/vendor/supports-color/index.js",
      "default": "./source/vendor/supports-color/browser.js"
    }
  }
}
```

When chalk's source does `import color from "#supports-color"`:

**Browser build:**

Expected: `"default"` condition → `./source/vendor/supports-color/browser.js`.

**Node build:**

Expected: `"node"` condition → `./source/vendor/supports-color/index.js`.

```
/?q=chalk@5.4.1
```

Expected for default browser build: the final bundle includes the browser version of `supports-color`, not the Node version. Verify by checking the bundle output for browser-specific color detection (checks `navigator`) vs Node-specific detection (checks `process.env`).

**Regression signal:** If the bundle includes Node.js `process.env.FORCE_COLOR` checks in a browser build, the `#supports-color` import resolved to the wrong condition branch.


### 2.6 — Unconditional `#` import

**What it tests:** A `#` import that maps to a single path (no conditions).

**Package:** `chalk@5.4.1`

```json
{
  "imports": {
    "#ansi-styles": "./source/vendor/ansi-styles/index.js"
  }
}
```

When chalk's source does `import styles from "#ansi-styles"`:

Expected: resolves directly to `./source/vendor/ansi-styles/index.js` regardless of platform or conditions.

**Regression signal:** If `#ansi-styles` produces a resolution error, the resolver cannot handle non-conditional `#` imports.


### 2.7 — Failed `#` import does not fall through

**What it tests:** A malformed `#` import produces an error instead of being treated as a bare package name.

Construct a synthetic scenario:

```
/?q=chalk@5.4.1
```

If chalk's source hypothetically imported `#nonexistent`, the resolver must produce an error — not try to fetch `#nonexistent` from npm.

**Regression signal:** If the resolver silently falls through to treat `#foo` as a bare import, it breaks the spec's guarantee that `#`-prefixed imports are package-private.


### 2.8 — Self-referencing through exports

**What it tests:** A package that imports itself by name, resolving through its own `exports` field.

> **Spec background:** Node.js supports [self-referencing](https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name) — a package can `import "itself/subpath"` and the resolver looks up the `exports` field of the package's own `package.json`.

**Package:** `yargs@17.7.2`

```json
{
  "name": "yargs",
  "exports": {
    ".": [{ "import": "./index.mjs", "require": "./index.cjs" }, "./index.cjs"],
    "./helpers": { "import": "./helpers/helpers.mjs", "require": "./helpers/index.js" }
  }
}
```

If yargs source internally does `import { Parser } from "yargs/helpers"`:

Expected: resolves through the package's own `exports["./helpers"]` → `./helpers/helpers.mjs` (ESM context).

**Regression signal:** If the self-reference triggers a CDN fetch for a *separate* `yargs` package instead of resolving against the in-flight package's manifest, you get duplicate code or version mismatches.
