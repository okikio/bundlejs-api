---
description: Test quality standards for this repo
applyTo: "**/*test*.ts,**/*.test.ts"
---

# Testing Rules

## Tools

| Role                                | Import                             |
| ----------------------------------- | ---------------------------------- |
| Test runner                         | `deno test` (via `deno task test`) |
| BDD structure (`describe` / `test`) | `@std/testing/bdd`                 |
| Assertions                          | `@std/expect` (`expect`)           |

Imports follow this pattern at the top of every test file:

```ts
import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";
```

## Core principle: test behavior, not implementation

Treat the module as a black box. Call the public API, assert on the output.
Never assert on internal state, private methods, or implementation details. A
refactor that preserves observable behavior must not break any test.

## Test independence and determinism

- No shared mutable state between tests.
- No ordering dependencies — tests must pass in any order.
- No reliance on wall-clock time, random seeds, or external resources unless
  clearly isolated.
- One logical behavior per test. If a test description needs "and", split it.

## Clarity over DRYness

Tests are documentation. When a test fails, a developer should understand the
scenario immediately without chasing through helper abstractions.

Use the **AAA pattern** (Arrange, Act, Assert) for every test:

```ts
// Arrange: set up inputs
const pkg = manifest({
  exports: {
    ".": { import: "./dist/index.mjs" },
  },
});

// Act: call the public API
const result = resolveModern(pkg, ".", conds);

// Assert: verify the observable output
expect(result.success).toBe(true);
expect(result.path).toBe("./dist/index.mjs");
```

Duplicating setup between two tests is acceptable when it makes each test
self-explanatory. Extract helpers only when they genuinely reduce noise without
obscuring intent.

## Test file conventions

This project uses numbered, scenario-based test files in `core/tests/`:

```
core/tests/
├── helpers.ts                          # shared helpers (manifest, buildPackage, etc.)
├── 01-conditional-exports.test.ts
├── 02-subpath-patterns.test.ts
├── ...
└── 19-registry-tarballs.test.ts
```

Each file focuses on one scenario category. The number prefix keeps files
adjacent in directory listings and makes the test surface easy to scan.

When adding a new scenario, pick the next unused number. When extending an
existing scenario, add tests to the matching file.

## Helper usage

Shared helpers live in `core/tests/helpers.ts`. These are teaching surfaces: use
them to reduce noise, but keep individual tests self-explanatory.

Key helpers:

- `manifest(partial)` — build a synthetic `package.json` for resolution tests
- `buildPackage(name, manifest, opts)` — write a manifest to VFS and run the
  full build pipeline
- `importArgs()` / `resolveOpts(overrides)` — create resolver inputs with
  sensible defaults

Each helper call gets a fresh filesystem to prevent cross-test state leakage.

## Boundary value tests

For any feature with a threshold (retry count, size limit, timeout, condition
priority), always test at:

- N = 0 (degenerate case)
- N = 1 (minimal case)
- N = 2 (first non-trivial case)
- N = boundary value (exact limit)

## Edge cases to always cover

These are often missed but expose real bugs:

- Empty `exports` field / missing `main` field
- Circular or self-referencing subpath patterns
- Mixed condition types (string vs object in the same `exports` entry)
- Non-ASCII package names
- `package.json` with no `name` field
- Tarball with malformed or missing files
- HTTP responses with unexpected status codes (301, 404, 500)
- Build with zero entry points
- Compression of empty input

## Anti-patterns to avoid

- **Asserting full multi-line string equality** when a structural assertion
  would be more robust. Prefer `expect(result).toContain(...)`, line-count
  checks, or prefix/suffix assertions when exact output isn't what matters.
- **Mutation-blind assertions**: a test that runs a code path but never checks
  the return value provides false safety. Every act step must have an assert
  step.
- **Over-mocking**: mock only external boundaries (network, filesystem). Let
  internal modules exercise their real code paths.
- **Asserting implementation details**: don't test internal function signatures,
  private method calls, or cache internals. Test the observable output.
