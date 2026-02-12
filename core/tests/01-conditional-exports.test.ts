/**
 * Scenario 01 — Conditional Exports
 *
 * Tests the modern `exports` field with nested conditions, multiple subpaths,
 * and platform-specific branching.
 *
 * @see docs/scenarios/01-conditional-exports.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  resolveModern,
  getResolverConditions,
  manifest,
  importArgs,
  resolveOpts,
  buildPackage,
} from "./helpers.ts";

// =============================================================================
// Unit tests — resolveModern / resolvePackageEntry with synthetic manifests
// =============================================================================

describe("01 · Conditional Exports", () => {
  describe("1.1 — Simple conditional exports (preact-like)", () => {
    const pkg = manifest({
      exports: {
        ".": {
          types: "./src/index.d.ts",
          browser: "./dist/preact.module.js",
          import: "./dist/preact.mjs",
          require: "./dist/preact.js",
        },
      },
    });

    test("browser build picks the 'browser' condition", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      // "browser" should be active and match before "import"
      expect(result.path).toBe("./dist/preact.module.js");
    });

    test("node build picks 'import' (no browser condition)", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "node" }));
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/preact.mjs");
    });

    test("CJS node build picks 'require'", () => {
      const conds = getResolverConditions(
        importArgs("entry-point"),
        resolveOpts({ platform: "node", format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/preact.js");
    });
  });

  describe("1.2 — Deeply nested conditions (solid-js-like)", () => {
    const pkg = manifest({
      exports: {
        ".": {
          deno: { import: "./dist/server.js", require: "./dist/server.cjs" },
          node: { import: "./dist/server.js", require: "./dist/server.cjs" },
          worker: { import: "./dist/server.js", require: "./dist/server.cjs" },
          browser: {
            development: {
              import: "./dist/dev.js",
              require: "./dist/dev.cjs",
            },
            import: "./dist/solid.js",
            require: "./dist/solid.cjs",
          },
          import: "./dist/solid.js",
          require: "./dist/solid.cjs",
        },
      },
    });

    test("browser production resolves to ./dist/solid.js", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/solid.js");
    });

    test("browser + development resolves to ./dist/dev.js", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "browser", conditions: ["development"] }),
      );
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/dev.js");
    });

    test("deno runtime resolves to ./dist/server.js", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "node", runtime: "deno" }),
      );
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/server.js");
    });
  });

  describe("1.3 — Node-specific CJS/ESM nesting (vue-like)", () => {
    const pkg = manifest({
      exports: {
        ".": {
          import: {
            node: "./index.mjs",
            types: "./dist/vue.d.mts",
            default: "./dist/vue.runtime.esm-bundler.js",
          },
          require: {
            node: {
              production: "./dist/vue.cjs.prod.js",
              development: "./dist/vue.cjs.js",
              default: "./index.js",
            },
            types: "./dist/vue.d.ts",
            default: "./index.js",
          },
        },
      },
    });

    test("browser ESM resolves to bundler entry", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/vue.runtime.esm-bundler.js");
    });

    test("node ESM resolves to ./index.mjs", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "node" }));
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./index.mjs");
    });

    test("node CJS resolves through 'require' → 'node' → 'default'", () => {
      const conds = getResolverConditions(
        importArgs("entry-point"),
        resolveOpts({ platform: "node", format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./index.js");
    });
  });

  describe("1.4 — 2×2 matrix: format × platform (uuid-like)", () => {
    const pkg = manifest({
      exports: {
        ".": {
          node: {
            import: "./dist/esm/index.js",
            require: "./dist/cjs/index.js",
          },
          browser: {
            import: "./dist/esm-browser/index.js",
            require: "./dist/cjs-browser/index.js",
          },
          default: "./dist/esm-browser/index.js",
        },
      },
    });

    test("browser + ESM → esm-browser", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/esm-browser/index.js");
    });

    test("browser + CJS → cjs-browser", () => {
      const conds = getResolverConditions(
        importArgs("entry-point"),
        resolveOpts({ platform: "browser", format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/cjs-browser/index.js");
    });

    test("node + ESM → esm", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "node" }));
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/esm/index.js");
    });

    test("node + CJS → cjs", () => {
      const conds = getResolverConditions(
        importArgs("entry-point"),
        resolveOpts({ platform: "node", format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/cjs/index.js");
    });
  });

  describe("1.5 — Single-string exports (chalk-like)", () => {
    const pkg = manifest({
      type: "module",
      exports: "./source/index.js",
    });

    test("resolves the string directly", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./source/index.js");
    });
  });

  describe("1.6 — Array fallbacks (yargs-like)", () => {
    const pkg = manifest({
      exports: {
        ".": [
          { import: "./index.mjs", require: "./index.cjs" },
          "./index.cjs",
        ],
      },
    });

    test("ESM picks import from the first array entry", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./index.mjs");
    });

    test("CJS picks require from the first array entry", () => {
      const conds = getResolverConditions(
        importArgs("entry-point"),
        resolveOpts({ format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./index.cjs");
    });
  });

  describe("1.7 — Explicit null exclusion", () => {
    const pkg = manifest({
      exports: {
        ".": "./index.js",
        "./internal": null,
      },
    });

    test("root resolves normally", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, ".", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./index.js");
    });

    test("./internal produces a resolution failure (null exclusion)", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "./internal", conds);

      // null exclusion → success should be false or path should be null
      expect(result.path).toBeNull();
      expect(result.success).toBe(false);
    });
  });

  // ===========================================================================
  // Integration tests — full build pipeline
  // ===========================================================================

  describe("integration: real packages", () => {
    test("preact@10.25.4 builds successfully for browser", { }, async () => {
      const result = await buildPackage("preact@10.25.4");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("solid-js@1.9.4 builds for browser", async () => {
      const result = await buildPackage("solid-js@1.9.4");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("uuid@11.0.5 builds for browser", async () => {
      const result = await buildPackage("uuid@11.0.5");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("chalk@5.4.1 builds for browser", async () => {
      const result = await buildPackage("chalk@5.4.1");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
