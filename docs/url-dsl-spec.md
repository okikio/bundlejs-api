# BundleJS URL DSL Spec (v1)

A URL-based module recipe language for encoding JavaScript/TypeScript import and
export statements. The contents of each `[...]` bracket read like the clause
you would write in real JS/TS, so a link teaches its own meaning at a glance.

This spec defines how a BundleJS share URL maps to generated module statements:
parse the URL, build a normalized AST, validate modifiers, then emit code. A
correct implementation of this document can reproduce the same statements from
the same URL, regardless of which tool does the parsing.

```
URL query parameters
        │
        ▼
┌───────────────┐
│  Parse URL    │  extract q, base, treeshake, v
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Normalize    │  resolve slots, parse brackets, normalize separators
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Validate     │  degrade invalid modifiers, record warnings
└───────┬───────┘
        │
        ▼
┌───────────────┐
│  Emit code    │  pure function: AST → module statements
└───────┬───────┘
        │
        ▼
   Generated code
```

---

## 1) URL parameters

### 1.1 `v` — spec version

Canonical links MUST include `v=1`. This freezes the link's meaning so future
spec versions never silently reinterpret old URLs.

### 1.2 `q` — module list (required)

A comma-separated list of module entries. Each entry describes one module
specifier and its mode (import or export). Aliases: `q` (canonical), `query`
(accepted).

```
q=react,react-dom/client,(import)lodash
```

### 1.3 `base` — default bracket payload

The bracket payload applied to any module that does not have an explicit
`treeshake` override.

- If `base` is absent, treat it as `auto|default`.
- Canonical links MUST include `base=...` so the link's intent never depends on
  the application's current defaults.

Common values:

| Value            | Surface emitted per module               |
| ---------------- | ---------------------------------------- |
| `auto`           | One namespace statement (safe, minimal)  |
| `auto\|default`  | Namespace + default (ergonomic, default)  |
| `*`              | Bare re-export all (export mode)         |
| `*\|{default}`   | Re-export all + default (legacy style)   |

### 1.4 `treeshake` — per-module overrides (optional)

Overrides the `base` payload for individual modules, either positionally or
with sparse index notation. Details in §4.

### 1.5 Other parameters

`share` (LZ-compressed code), `text` (raw code), and `config` (JSON5 build
options) may appear in BundleJS URLs. They are out of scope for this spec, which
focuses on module statement modeling.

---

## 2) Module entries (`q` format)

Each `q[i]` entry has a **mode** and a **specifier**.

### 2.1 Mode prefix

```
(<mode>)<specifier>
```

Where `<mode>` is `import` or `export`. Only the parenthesized form is
accepted:

- `(import)react` — import mode
- `(export)react` — export mode (explicit)

If no prefix is present, the mode defaults to **export**.

### 2.2 Specifier

The specifier is any string you would put inside quotes in a JS module
statement:

| Kind              | Examples                                      |
| ----------------- | --------------------------------------------- |
| Bare package      | `react`, `@scope/pkg`                         |
| Subpath           | `react-dom/client`, `@scope/pkg/sub`          |
| Node built-in     | `node:fs`, `node:fs/promises`                 |
| Relative path     | `./local/mod.ts`, `../utils.js`               |
| URL               | `https://esm.sh/lodash@4.17.21`               |

`node:` is the canonical scheme for Node built-in modules in ESM
([Node docs](https://nodejs.org/api/esm.html#node-imports)). Subpaths may fail
if a package's `exports` field does not expose them
([ERR_PACKAGE_PATH_NOT_EXPORTED](https://nodejs.org/api/errors.html#err_package_path_not_exported)).

---

## 3) Slot resolution (base + overrides)

For each module `q[i]`, determine the bracket payload `B[i]`:

1. If `treeshake` provides an override at index `i`, use that bracket group.
2. Otherwise, use `base`.
3. If `base` is absent, use `auto|default`.

"Empty" overrides (an empty string from `,,` or `[]`) are treated as "no
override" and fall through to `base`.

---

## 4) `treeshake` encoding

### 4.1 Positional (comma-aligned with `q`)

A comma-separated list of bracket groups. Empty slots use `,,` (preferred) or
`[]` (accepted).

```
q=a,b,c
treeshake=[auto],,[{x}]
```

Module `a` gets `[auto]`, module `b` gets `base`, module `c` gets `[{x}]`.

### 4.2 Sparse (recommended for short links)

A semicolon-separated list of `<index>:[...]` pairs. Indices are **0-based
only**.

```
q=a,b,c
treeshake=2:[{x}]
```

Only module `c` (index 2) is overridden; the rest use `base`.

### 4.3 Format detection

If the treeshake string matches the pattern `^\d+\s*:\s*\[`, parse as sparse.
Otherwise, parse as positional.

---

## 5) Bracket groups

A bracket group contains one or more **emit-items** separated by `|`:

```
[item|item|item]
```

Each emit-item produces exactly **one** statement. So `[auto|default]` emits two
statements: one namespace, one default.

An empty or missing bracket resolves to `[auto]`.

---

## 6) Emit-item grammar

Each item inside a bracket follows this structure:

```
<modifiers*> <clause> <attributes?>
```

- `<modifiers*>` — zero or more modifiers (§7)
- `<clause>` — required, describes the import/export shape (§8)
- `<attributes?>` — optional import attributes (§9)

---

## 7) Modifiers

Modifiers occupy two independent axes: **phase** and **type-only**. Both can
appear on the same emit-item.

### 7.1 Phase modifiers: `defer`, `source`

Phase modifiers encode TC39 module phase proposals. They are meaningful only in
**import** mode. In export mode, phase modifiers are silently dropped.

**`defer`** — deferred module evaluation
([TC39 Stage 3](https://github.com/tc39/proposal-defer-import-eval)).

- Valid only with **namespace-shaped** clauses: `auto`, `*`, `* as X`.
- Emits: `import defer * as X from "spec";`
- If the clause is not namespace-shaped, the phase is silently dropped.

**`source`** — source phase import
([TC39 proposal](https://github.com/tc39/proposal-source-phase-imports)).

- Valid only with **identifier** clauses: `X`, `id:X`.
- Emits: `import source X from "spec";`
- If the clause is not an identifier, the phase is silently dropped.

### 7.2 Type-only modifier: `type`

The `type` modifier aligns with TypeScript's type-only import and export syntax.

**Import mode:**

- Valid with all clauses **except** `bare`.
- Prefixes the statement: `import type ...`.
- `type bare` → `type` is silently dropped; emits `import "spec";`.

**Export mode:**

TypeScript 3.8 introduced `export type { ... } from "..."`, and TypeScript 5.0
extended support to `export type * from "..."` and `export type * as ns from
"..."`
([TS 5.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-0.html#support-for-export-type-)).

- `type {a, b}` → `export type { a, b } from "spec";`
- `type *` → `export type * from "spec";`
- `type * as X` / `type auto` → `export type * as X from "spec";`
- `type default` → `export type { default as XDefault } from "spec";`
- `type X` / `type id:X` → `export type { default as X } from "spec";`
- `type bare` → `bare` is dropped in export mode (§8), so this item is removed
  entirely.

### 7.3 Phase + type combinations

Both a phase modifier and the `type` modifier can appear on the same item:

```
[defer type auto]     → import defer type * as AutoName from "spec";
[source type id:Wasm] → import source type Wasm from "spec";
```

Whether the runtime or toolchain accepts these combinations depends on the
implementation. The DSL encodes them for forward compatibility.

### 7.4 Unknown modifiers

Unknown modifiers MUST be silently ignored (forward-compatible parsing).

### 7.5 Canonical modifier order

When canonicalizing, emit modifiers in this order:

1. Phase (`defer` / `source`)
2. `type`
3. Clause
4. Attributes

Parsing accepts any order: `[type defer auto]` and `[defer type auto]` produce
the same AST.

---

## 8) Clauses

Each emit-item requires exactly one clause. The clause describes the shape of
the import or export binding.

### 8.1 `auto`

Auto-named namespace surface. Uses `AutoName(spec)` (§12) as the binding name.

| Mode   | Emits                                    |
| ------ | ---------------------------------------- |
| import | `import * as AutoName from "spec";`      |
| export | `export * as AutoName from "spec";`      |

### 8.2 `default`

Default surface. Uses `DefaultName(spec)` as the binding name (§12.2).
Supports an optional explicit name: `default as React`.

| Mode   | Emits                                              |
| ------ | -------------------------------------------------- |
| import | `import DefaultName from "spec";`                  |
| export | `export { default as DefaultName } from "spec";`   |

With `default as React`:

| Mode   | Emits                                        |
| ------ | -------------------------------------------- |
| import | `import React from "spec";`                  |
| export | `export { default as React } from "spec";`   |

### 8.3 `bare`

Explicit side-effect import. This is the only way to emit `import "spec";`.

| Mode   | Behavior                                           |
| ------ | -------------------------------------------------- |
| import | `import "spec";`                                   |
| export | **Drop this item.** No `export "spec";` equivalent exists. If all items in the group are dropped, fall back to `base`. |

### 8.4 `*`

Star surface. Behavior differs by mode:

| Mode   | Emits                                    |
| ------ | ---------------------------------------- |
| import | `import * as AutoName from "spec";`      |
| export | `export * from "spec";`                  |

In import mode, `*` behaves like `auto` (namespace with auto-name). It does
**not** mean bare import.

### 8.5 `* as X` (also `*asX`)

Explicit namespace binding:

| Mode   | Emits                              |
| ------ | ---------------------------------- |
| import | `import * as X from "spec";`       |
| export | `export * as X from "spec";`       |

### 8.6 `{ ... }` — named specifiers

A JS/TS-style named specifier list. Supports `as` aliases and `type` specifiers
inside the braces:

```
{ useState, useEffect }
{ animate as a }
{ type Foo, Bar }
{ type Foo, Bar as Baz }
```

| Mode   | Emits                                 |
| ------ | ------------------------------------- |
| import | `import { ... } from "spec";`         |
| export | `export { ... } from "spec";`         |

### 8.7 `X` — identifier

A bare identifier clause. Serves as the default binding in import mode and a
default alias in export mode:

| Mode   | Emits                                       |
| ------ | ------------------------------------------- |
| import | `import X from "spec";`                     |
| export | `export { default as X } from "spec";`      |

### 8.8 `id:X` — keyword-safe identifier

Same semantics as `X`, but explicitly marked as an identifier even when `X`
matches a DSL keyword (`bare`, `auto`, `default`, `defer`, `source`, `type`).

```
[id:defer]   → treated as identifier "defer", not the phase keyword
[id:bare]    → treated as identifier "bare", not the bare clause
[id:type]    → treated as identifier "type", not the type modifier
```

---

## 9) Import attributes (`with{...}`)

Import attributes follow the TC39 Import Attributes proposal
([spec](https://tc39.es/proposal-import-attributes/)). They attach to exactly
one emit-item.

### 9.1 Syntax

```
with{key:value,key2:value2}
```

Accepted input variants:

- `with{type:json}` — compact (canonical)
- `with { type: json }` — spaced
- `with { type: "json" }` — quoted values

Values may be quoted or unquoted in the URL. The emitter MUST quote values in
generated code: `with { type: "json" }`.

### 9.2 Key normalization

- Duplicate keys are **deduped** (keep last occurrence). Duplicate `with` keys
  produce a syntax error in JS, so the DSL normalizes them.
- Keys are sorted **lexicographically** in canonical output, matching the spec's
  "order does not matter" semantics.

### 9.3 Binding scope

Attributes apply to the emit-item they appear on, not to the whole bracket
group:

```
[auto with{type:css}|default]
```

Only the `auto` item gets the `with { type: "css" }` clause. The `default` item
has no attributes.

### 9.4 Bare imports with attributes

The Import Attributes proposal supports `import "spec" with { ... };`, so
`[bare with{type:css}]` is valid:

```js
import "./styles.css" with { type: "css" };
```

### 9.5 Export-from with attributes

The proposal also supports `export ... from "spec" with { ... };`:

```js
export { parse } from "./data.json" with { type: "json" };
```

---

## 10) Separator rules inside brackets

Inside bracket payloads only, the parser treats these as equivalent token
separators:

- Whitespace (spaces, tabs, newlines)
- `+` (decoded as space in query strings)
- `%20` (decoded as space)
- `_` (DSL readability separator, **only during bracket tokenization**)

All of these parse identically:

```
[* as X]
[*+as+X]
[*_as_X]
[*%20as%20X]
```

Outside brackets, `_` remains a literal underscore (part of identifiers,
specifiers, etc.).

---

## 11) Emission semantics

Let:

- `mode` = import or export from `q[i]`
- `spec` = specifier string from `q[i]`
- `A` = `AutoName(spec)` (§12)
- `AD` = `DefaultName(spec)` = `A + "Default"` (§12.2)

Each emit-item produces exactly **one** statement.

### 11.1 Clause matrix (no modifiers)

| Clause       | Import mode                        | Export mode                                    |
| ------------ | ---------------------------------- | ---------------------------------------------- |
| `auto`       | `import * as A from "spec";`       | `export * as A from "spec";`                   |
| `default`    | `import AD from "spec";`           | `export { default as AD } from "spec";`        |
| `bare`       | `import "spec";`                   | *(drop item)*                                  |
| `*`          | `import * as A from "spec";`       | `export * from "spec";`                        |
| `* as X`     | `import * as X from "spec";`       | `export * as X from "spec";`                   |
| `{a, b}`     | `import { a, b } from "spec";`     | `export { a, b } from "spec";`                 |
| `X` / `id:X` | `import X from "spec";`            | `export { default as X } from "spec";`         |

### 11.2 `type` modifier

**Import mode** — prefix with `import type`:

| Clause       | Emits                                         |
| ------------ | --------------------------------------------- |
| `type auto`  | `import type * as A from "spec";`             |
| `type default` | `import type AD from "spec";`               |
| `type *`     | `import type * as A from "spec";`             |
| `type * as X`| `import type * as X from "spec";`             |
| `type {a}`   | `import type { a } from "spec";`              |
| `type X`     | `import type X from "spec";`                  |
| `type bare`  | drop `type` → `import "spec";`                |

**Export mode** — prefix with `export type`:

| Clause        | Emits                                           |
| ------------- | ----------------------------------------------- |
| `type auto`   | `export type * as A from "spec";`               |
| `type default`| `export type { default as AD } from "spec";`    |
| `type *`      | `export type * from "spec";`                    |
| `type * as X` | `export type * as X from "spec";`               |
| `type {a}`    | `export type { a } from "spec";`                |
| `type X`      | `export type { default as X } from "spec";`     |
| `type bare`   | *(drop item — bare has no export equivalent)*   |

### 11.3 Phase modifiers (import mode only)

| Phase + clause   | Emits                                       |
| ---------------- | ------------------------------------------- |
| `defer auto`     | `import defer * as A from "spec";`          |
| `defer *`        | `import defer * as A from "spec";`          |
| `defer * as X`   | `import defer * as X from "spec";`          |
| `source X`       | `import source X from "spec";`              |
| `source id:X`    | `import source X from "spec";`              |

Phase mismatches (e.g. `defer {a}`, `source * as X`, `source auto`) silently
drop the phase and emit the clause normally.

### 11.4 Phase + type combinations (import mode only)

| Modifiers + clause       | Emits                                         |
| ------------------------ | --------------------------------------------- |
| `defer type auto`        | `import defer type * as A from "spec";`       |
| `defer type * as X`      | `import defer type * as X from "spec";`       |
| `source type X`          | `import source type X from "spec";`           |
| `source type id:X`       | `import source type X from "spec";`           |

Phase validation runs first: if the phase is invalid for the clause, the phase
is dropped. The `type` modifier then applies to whatever remains.

### 11.5 Attributes

Append `with { ... }` to any statement:

```js
import { parse } from "./data.json" with { type: "json" };
export * as theme from "./styles.css" with { type: "css" };
import "./reset.css" with { type: "css" };
```

---

## 12) AutoName algorithm

AutoName converts a module specifier into a deterministic, collision-resistant
JavaScript identifier.

### 12.1 Base derivation

1. Strip surrounding whitespace.
2. If the specifier is a URL (`https://`), extract the hostname and pathname
   for naming (e.g. `https://esm.sh/lodash@4.17.21` → derive from hostname
   + path segments).
3. Otherwise, parse as a package name. Use the package name (without version)
   plus any subpath as the base.
4. Split the base on separators: `-`, `/`, `@`, `.`.
5. Drop empty segments.
6. For scoped packages (`@scope/pkg`), treat as segments `scope`, `pkg`.
7. CamelCase: first segment lowercased, subsequent segments capitalized.
8. Strip characters invalid in JS identifiers.
9. If the result starts with a digit, prefix with `_`.
10. If empty after sanitization, use `mod`.

Examples:

| Specifier               | AutoName              |
| ------------------------ | -------------------- |
| `react`                  | `react`              |
| `react-dom/client`       | `reactDomClient`     |
| `@scope/pkg`             | `scopePkg`           |
| `@scope/pkg/subpath`     | `scopePkgSubpath`    |
| `node:fs/promises`       | `nodeFsPromises`     |
| `./local/mod.ts`         | `mod`                |
| `3d-force-graph`         | `_3dForceGraph`      |

### 12.2 DefaultName

```
DefaultName(spec) = AutoName(spec) + "Default"
```

Examples: `reactDefault`, `reactDomClientDefault`.

### 12.3 Collision handling

Within a single URL, if two different specifiers produce the same AutoName base,
append `__2`, `__3`, etc. in first-seen order.

---

## 13) Degrade rules (summary)

All degrade behavior is **silent** (no errors, optionally record warnings):

| Situation                              | Behavior                          |
| -------------------------------------- | --------------------------------- |
| Phase modifier on export mode          | Drop phase                        |
| `defer` + non-namespace clause         | Drop phase                        |
| `source` + non-identifier clause       | Drop phase                        |
| `type` + `bare` (import mode)          | Drop `type`                       |
| `bare` in export mode                  | Drop the entire item              |
| Unknown modifier                       | Ignore it                         |
| All items dropped from a bracket group | Fall back to `base`               |

---

## 14) Canonicalization (how share links should be emitted)

Canonical URLs make links stable and comparable. Canonicalization is a pure
function from the normalized AST to a URL string.

### 14.1 Parameter presence and order

Canonical URLs MUST include, in this order:

1. `v=1`
2. `q=...`
3. `base=...`
4. `treeshake=...` (only if overrides exist)
5. App-specific params (`config`, `share`, `text`, ...)

### 14.2 Canonical `q`

- Preserve entry order.
- Only prefix `(import)` when the mode is import. Export mode uses no prefix.
- `(export)` prefix is stripped in canonical output.

### 14.3 Canonical `treeshake`

Always emit **sparse** form (0-based), even if the input was positional:

```
treeshake=1:[{parse}with{type:json}];3:[auto|default]
```

### 14.4 Canonical bracket formatting

- Keep spaces between keywords for readability: `defer type auto`, not
  `defertypeauto`.
- Compact namespace form: `* as X`, not `*  as  X`.
- Compact attributes: `with{type:json}`, not `with { type: json }`.
- Modifier order: phase → type → clause → attributes.
- Attribute keys sorted lexicographically.

### 14.5 Canonical attribute values

In the URL, values may be unquoted when they match `[A-Za-z0-9._/-]+`. In
emitted code, values MUST be quoted strings.

---

## 15) Reference AST shape

Implementations should build a normalized AST from the URL and emit code from
it. This prevents drift between parsing and generation.

```ts
interface UrlDslV1 {
  readonly version: 1;
  readonly base: BracketGroup;
  readonly modules: readonly ModuleEntry[];
  readonly overrides: ReadonlyMap<number, BracketGroup>;
  readonly warnings: readonly string[];
}

interface ModuleEntry {
  readonly mode: 'import' | 'export';
  readonly specifier: string;
}

interface BracketGroup {
  readonly items: readonly EmitItem[];
}

interface EmitItem {
  readonly modifiers: {
    readonly phase?: 'defer' | 'source';
    readonly typeOnly?: boolean;
  };
  readonly clause: Clause;
  readonly attributes?: ReadonlyMap<string, string>;
}

type Clause =
  | { kind: 'auto' }
  | { kind: 'default'; name?: string }
  | { kind: 'bare' }
  | { kind: 'star' }
  | { kind: 'namespace'; name: string }
  | { kind: 'named'; raw: string }
  | { kind: 'ident'; name: string };
```

---

## 16) Practical edge cases

### 16.1 Default export may not exist

`base=auto|default` emits a default surface for every module. If a module has
no default export, this can fail at link time. Use `base=auto` for safety and
opt into `|default` only on modules known to have a default export.

### 16.2 Package `exports` may block subpaths

If a package defines an `exports` field, importing subpaths not listed there
throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
([Node docs](https://nodejs.org/api/errors.html#err_package_path_not_exported)).

### 16.3 `node:` builtins

`node:` specifiers explicitly target Node built-in modules and avoid shadowing
by userland packages
([Node ESM docs](https://nodejs.org/api/esm.html#node-imports)).

### 16.4 Import assertions are not accepted

This DSL uses `with{...}` (import attributes) only. The deprecated
`assert{...}` form (import assertions) is **not** accepted. Import attributes
supersede import assertions in the TC39 spec
([proposal](https://github.com/tc39/proposal-import-attributes)).

---

## 17) Worked examples

### 17.1 Default multi-export surface

```
?v=1&q=react,react-dom/client&base=auto|default
```

```js
export * as react from "react";
export { default as reactDefault } from "react";
export * as reactDomClient from "react-dom/client";
export { default as reactDomClientDefault } from "react-dom/client";
```

### 17.2 Safe minimal surface

```
?v=1&q=react,react-dom/client&base=auto
```

```js
export * as react from "react";
export * as reactDomClient from "react-dom/client";
```

### 17.3 Sparse overrides with attributes and named exports

```
?v=1
&q=react,./data.json,./styles.css,react-dom/client
&base=auto|default
&treeshake=1:[{parse} with{type:json}];2:[bare with{type:css}];3:[{createRoot}]
```

```js
export * as react from "react";
export { default as reactDefault } from "react";

export { parse } from "./data.json" with { type: "json" };

import "./styles.css" with { type: "css" };

export { createRoot } from "react-dom/client";
```

Note: `./styles.css` uses `bare` in export mode. Since `bare` has no export
equivalent, but the entry has `(import)` detected from the `bare` clause
context, the emit logic recognizes this as a side-effect import. If the mode
were export and only `bare` were present, the item is dropped and `base`
applies instead.

### 17.4 Import mode with phases

```
?v=1
&q=(import)./lazy.js,(import)./mod.wasm,(import)react
&base=auto
&treeshake=0:[defer auto];1:[source id:Wasm];2:[type {FC, useState}]
```

```js
import defer * as lazy from "./lazy.js";
import source Wasm from "./mod.wasm";
import type { FC, useState } from "react";
```

### 17.5 Separator equivalence

All of these produce the same result:

```
treeshake=0:[* as X]
treeshake=0:[*+as+X]
treeshake=0:[*_as_X]
treeshake=0:[*%20as%20X]
```

### 17.6 Type-only exports

```
?v=1&q=@lib/types&base=type auto|type default
```

```ts
export type * as libTypes from "@lib/types";
export type { default as libTypesDefault } from "@lib/types";
```

### 17.7 Phase mismatch degrade

```
?v=1&q=(import)react&base=auto&treeshake=0:[defer {useState}]
```

`defer` requires a namespace clause but `{useState}` is named. Phase drops:

```js
import { useState } from "react";
```

### 17.8 Mixed import and export in one URL

```
?v=1
&q=(import)react,react-dom/client,./data.json
&base=auto|default
&treeshake=2:[{parse} with{type:json}]
```

```js
import * as react from "react";
import reactDefault from "react";
export * as reactDomClient from "react-dom/client";
export { default as reactDomClientDefault } from "react-dom/client";
export { parse } from "./data.json" with { type: "json" };
```

---

## 18) Golden test vectors

Each vector specifies Input URL → Canonical URL → AST → Emitted code.

### T01 — base defaults when `base` and `v` are omitted

**Input:** `?q=react`

**Canonical:** `?v=1&q=react&base=auto|default`

**AST:**

```json
{
  "version": 1,
  "base": { "items": [{ "clause": { "kind": "auto" } }, { "clause": { "kind": "default" } }] },
  "modules": [{ "mode": "export", "specifier": "react" }],
  "overrides": {},
  "warnings": []
}
```

**Emit:**

```js
export * as react from "react";
export { default as reactDefault } from "react";
```

---

### T02 — multi-module default surface

**Input:** `?v=1&q=react,react-dom/client&base=auto|default`

**Emit:**

```js
export * as react from "react";
export { default as reactDefault } from "react";
export * as reactDomClient from "react-dom/client";
export { default as reactDomClientDefault } from "react-dom/client";
```

---

### T03 — safe minimal base

**Input:** `?v=1&q=react,react-dom/client&base=auto`

**Emit:**

```js
export * as react from "react";
export * as reactDomClient from "react-dom/client";
```

---

### T04 — positional treeshake canonicalized to sparse

**Input:** `?v=1&q=a,b,c&base=auto&treeshake=,,[default]`

**Canonical:** `?v=1&q=a,b,c&base=auto&treeshake=2:[default]`

**Emit:**

```js
export * as a from "a";
export * as b from "b";
export { default as cDefault } from "c";
```

---

### T05 — named exports with attributes

**Input:** `?v=1&q=react,./data.json&base=auto|default&treeshake=1:[{parse} with{type:json}]`

**Canonical:** `?v=1&q=react,./data.json&base=auto|default&treeshake=1:[{parse} with{type:json}]`

**Emit:**

```js
export * as react from "react";
export { default as reactDefault } from "react";
export { parse } from "./data.json" with { type: "json" };
```

---

### T06 — attribute key sorting and dedup

**Input:** `?v=1&q=./data.json&base=auto&treeshake=0:[{parse} with{integrity:sha256-aaa,type:json,integrity:sha256-bbb}]`

**Canonical:** `?v=1&q=./data.json&base=auto&treeshake=0:[{parse} with{integrity:sha256-bbb,type:json}]`

**Emit:**

```js
export { parse } from "./data.json" with { integrity: "sha256-bbb", type: "json" };
```

**Warnings:** `["attrs:duplicate-key(integrity)"]`

---

### T07 — separator equivalence

**Input:** `?v=1&q=react&base=auto&treeshake=0:[*+as+X]`

**Canonical:** `?v=1&q=react&base=auto&treeshake=0:[* as X]`

**Emit:**

```js
export * as X from "react";
```

---

### T08 — `*` in import mode is namespace, not bare

**Input:** `?v=1&q=(import)react&base=auto&treeshake=0:[*]`

**Emit:**

```js
import * as react from "react";
```

---

### T09 — explicit bare import

**Input:** `?v=1&q=(import)./styles.css&base=auto&treeshake=0:[bare]`

**Emit:**

```js
import "./styles.css";
```

---

### T10 — bare import with attributes

**Input:** `?v=1&q=(import)./styles.css&base=auto&treeshake=0:[bare with{type:css}]`

**Canonical:** `?v=1&q=(import)./styles.css&base=auto&treeshake=0:[bare with{type:css}]`

**Emit:**

```js
import "./styles.css" with { type: "css" };
```

---

### T11 — bare in export mode drops item, falls back to base

**Input:** `?v=1&q=react&base=auto&treeshake=0:[bare]`

**Canonical:** `?v=1&q=react&base=auto`

Since `bare` has no export equivalent, the item is dropped. The bracket group
is now empty, so the override is removed and `base` (`auto`) applies.

**Emit:**

```js
export * as react from "react";
```

**Warnings:** `["override(0):dropped-all-items"]`

---

### T12 — phase on export is silently dropped

**Input:** `?v=1&q=react&base=auto&treeshake=0:[defer auto]`

**Canonical:** `?v=1&q=react&base=auto&treeshake=0:[auto]`

**Emit:**

```js
export * as react from "react";
```

**Warnings:** `["override(0):phase-ignored(export)"]`

---

### T13 — import defer with auto

**Input:** `?v=1&q=(import)./lazy.js&base=auto&treeshake=0:[defer auto]`

**Canonical:** `?v=1&q=(import)./lazy.js&base=auto&treeshake=0:[defer auto]`

**Emit:**

```js
import defer * as lazy from "./lazy.js";
```

---

### T14 — import source with identifier

**Input:** `?v=1&q=(import)./mod.wasm&base=auto&treeshake=0:[source id:Wasm]`

**Canonical:** `?v=1&q=(import)./mod.wasm&base=auto&treeshake=0:[source id:Wasm]`

**Emit:**

```js
import source Wasm from "./mod.wasm";
```

---

### T15 — phase mismatch: defer + named

**Input:** `?v=1&q=(import)react&base=auto&treeshake=0:[defer {useState}]`

**Canonical:** `?v=1&q=(import)react&base=auto&treeshake=0:[{useState}]`

Phase dropped because `defer` requires a namespace clause.

**Emit:**

```js
import { useState } from "react";
```

**Warnings:** `["override(0):phase-mismatch(defer)"]`

---

### T16 — type-only import of named exports

**Input:** `?v=1&q=(import)react&base=auto&treeshake=0:[type {type ReactNode, useState}]`

**Emit:**

```ts
import type { type ReactNode, useState } from "react";
```

---

### T17 — type-only export of named exports

**Input:** `?v=1&q=react&base=auto&treeshake=0:[type {ReactNode}]`

**Emit:**

```ts
export type { ReactNode } from "react";
```

---

### T18 — type-only export with namespace (TS 5.0+)

**Input:** `?v=1&q=@lib/types&base=auto&treeshake=0:[type auto]`

**Emit:**

```ts
export type * as libTypes from "@lib/types";
```

---

### T19 — type-only export with star (TS 5.0+)

**Input:** `?v=1&q=@lib/types&base=auto&treeshake=0:[type *]`

**Emit:**

```ts
export type * from "@lib/types";
```

---

### T20 — node: specifier naming

**Input:** `?v=1&q=node:fs/promises&base=auto`

**Emit:**

```js
export * as nodeFsPromises from "node:fs/promises";
```

---

### T21 — mixed import/export modes

**Input:** `?v=1&q=(import)react,react-dom/client,./data.json&base=auto|default&treeshake=2:[{parse} with{type:json}]`

**Canonical:** `?v=1&q=(import)react,react-dom/client,./data.json&base=auto|default&treeshake=2:[{parse} with{type:json}]`

**Emit:**

```js
import * as react from "react";
import reactDefault from "react";
export * as reactDomClient from "react-dom/client";
export { default as reactDomClientDefault } from "react-dom/client";
export { parse } from "./data.json" with { type: "json" };
```

---

### T22 — multiple items in one bracket

**Input:** `?v=1&q=react&base=auto&treeshake=0:[* as React|default]`

**Emit:**

```js
export * as React from "react";
export { default as reactDefault } from "react";
```

---

### T23 — unknown modifier is ignored

**Input:** `?v=1&q=react&base=auto&treeshake=0:[future auto]`

**Canonical:** `?v=1&q=react&base=auto&treeshake=0:[auto]`

**Emit:**

```js
export * as react from "react";
```

**Warnings:** `["override(0):unknown-modifier(future)"]`

---

### T24 — source + auto is a phase mismatch

**Input:** `?v=1&q=(import)./mod.wasm&base=auto&treeshake=0:[source auto]`

**Canonical:** `?v=1&q=(import)./mod.wasm&base=auto&treeshake=0:[auto]`

`source` requires an identifier clause, but `auto` is a namespace clause.
Phase dropped.

**Emit:**

```js
import * as mod from "./mod.wasm";
```

**Warnings:** `["override(0):phase-mismatch(source)"]`

---

### T25 — defer + type combination

**Input:** `?v=1&q=(import)./lazy.js&base=auto&treeshake=0:[defer type auto]`

**Emit:**

```ts
import defer type * as lazy from "./lazy.js";
```

---

### T26 — source + type combination

**Input:** `?v=1&q=(import)./mod.wasm&base=auto&treeshake=0:[source type id:Wasm]`

**Emit:**

```ts
import source type Wasm from "./mod.wasm";
```

---

## 19) Quick-reference cheat sheet

### Export mode (default)

| Bracket           | Behavior                              |
| ----------------- | ------------------------------------- |
| `[auto]`          | Safe namespace export                 |
| `[auto\|default]` | Namespace + ergonomic default         |
| `[{x, y}]`        | Named re-export                       |
| `[*]`             | Re-export all                         |
| `[* as X]`        | Namespace export under name X         |
| `[type {Foo}]`    | Type-only named re-export             |

### Import mode

| Bracket             | Behavior                            |
| ------------------- | ----------------------------------- |
| `[auto]`            | Namespace import                    |
| `[default]` / `[X]` | Default import                     |
| `[{x, y}]`          | Named import                       |
| `[bare]`            | Side-effect import                  |
| `[defer auto]`      | Deferred namespace import           |
| `[source id:X]`     | Source phase import                  |
| `[type {Foo}]`      | Type-only named import              |

---

## 20) Implementation checklist

1. **Parse** URL → raw query tokens.
2. **Normalize** → AST: module list, base, overrides, separator normalization.
3. **Validate** → degrade invalid modifiers, drop invalid items, record
   warnings.
4. **Emit** → pure function from AST to code strings.
5. **Canonicalize** → pure function from AST to canonical URL.

Test categories to cover:

- Golden tests: input URL → canonical URL → AST → emitted code
- Separator equivalence: space / `+` / `_` / `%20` produce identical ASTs
- Phase mismatch degrade: phase dropped, clause survives
- Export-phase degrade: phase always dropped
- Attribute dedup + sort: stable output
- Bare + export: item dropped, fallback to base
- AutoName collisions: suffix applied correctly
- Type modifier on all export clause forms
- Phase + type combinations
