/**
 * Scenario 02 — Subpath Patterns and Subpath Imports
 *
 * Tests wildcard patterns in `exports`, deep subpath resolution,
 * and the private `#` imports mechanism.
 *
 * @see docs/scenarios/02-subpath-patterns-and-imports.md
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
// Unit tests — wildcard patterns
// =============================================================================

describe("02 · Subpath Patterns and Imports", () => {
  describe("2.1 — Basic wildcard pattern (solid-js-like)", () => {
    const pkg = manifest({
      exports: {
        ".": { import: "./dist/solid.js" },
        "./web": { import: "./web/dist/web.js" },
        "./dist/*": "./dist/*",
        "./web/dist/*": "./web/dist/*",
      },
    });

    test("./dist/solid.js matches the wildcard and substitutes", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "./dist/solid.js", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/solid.js");
    });

    test("./web/dist/web.js matches the web wildcard", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "./web/dist/web.js", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./web/dist/web.js");
    });
  });

  describe("2.2 — Explicit key priority over wildcard", () => {
    const pkg = manifest({
      exports: {
        ".": { import: "./dist/solid.js" },
        "./web": { import: "./web/dist/web.js" },
        "./dist/*": "./dist/*",
      },
    });

    test("./web matches the explicit key, not a wildcard", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "./web", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./web/dist/web.js");
    });
  });

  describe("2.3 — Wildcard with conditional exports (rxjs-like)", () => {
    const pkg = manifest({
      exports: {
        ".": { import: "./dist/esm5/index.js" },
        "./operators": { import: "./dist/esm5/operators/index.js" },
        "./internal/*": {
          node: "./dist/cjs/internal/*.js",
          default: "./dist/esm5/internal/*.js",
          require: "./dist/cjs/internal/*.js",
        },
      },
    });

    test("browser default → esm5 path", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = resolveModern(pkg, "./internal/operators/map", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/esm5/internal/operators/map.js");
    });

    test("node build → cjs path", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "node" }));
      const result = resolveModern(pkg, "./internal/operators/map", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/cjs/internal/operators/map.js");
    });
  });

  describe("2.4 — Overlapping: explicit subpath vs wildcard", () => {
    const pkg = manifest({
      exports: {
        ".": { import: "./dist/esm5/index.js" },
        "./operators": { import: "./dist/esm5/operators/index.js" },
        "./internal/*": { default: "./dist/esm5/internal/*.js" },
      },
    });

    test("./operators hits the explicit key", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "./operators", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/esm5/operators/index.js");
    });

    test("./internal/operators/map hits the wildcard", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "./internal/operators/map", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/esm5/internal/operators/map.js");
    });
  });

  // ===========================================================================
  // Subpath Imports (#-prefix)
  // ===========================================================================

  describe("2.5 — Conditional # import (chalk-like)", () => {
    const pkg = manifest({
      imports: {
        "#ansi-styles": "./source/vendor/ansi-styles/index.js",
        "#supports-color": {
          node: "./source/vendor/supports-color/index.js",
          default: "./source/vendor/supports-color/browser.js",
        },
      },
    });

    test("browser build resolves #supports-color to browser.js", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = resolveModern(pkg, "#supports-color", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./source/vendor/supports-color/browser.js");
    });

    test("node build resolves #supports-color to index.js", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "node" }));
      const result = resolveModern(pkg, "#supports-color", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./source/vendor/supports-color/index.js");
    });
  });

  describe("2.6 — Unconditional # import", () => {
    const pkg = manifest({
      imports: {
        "#ansi-styles": "./source/vendor/ansi-styles/index.js",
      },
    });

    test("resolves to the single path regardless of platform", () => {
      const browserConds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const nodeConds = getResolverConditions(importArgs(), resolveOpts({ platform: "node" }));

      const browserResult = resolveModern(pkg, "#ansi-styles", browserConds);
      const nodeResult = resolveModern(pkg, "#ansi-styles", nodeConds);

      expect(browserResult.success).toBe(true);
      expect(nodeResult.success).toBe(true);
      expect(browserResult.path).toBe("./source/vendor/ansi-styles/index.js");
      expect(nodeResult.path).toBe("./source/vendor/ansi-styles/index.js");
    });
  });

  describe("2.7 — Failed # import = hard error", () => {
    const pkg = manifest({
      imports: {
        "#exists": "./source/exists.js",
      },
    });

    test("#nonexistent does not resolve (hard failure)", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "#nonexistent", conds);

      expect(result.success).toBe(false);
      expect(result.path).toBeNull();
    });
  });

  describe("2.8 — Self-referencing through exports (yargs-like)", () => {
    const pkg = manifest({
      name: "yargs",
      exports: {
        ".": [
          { import: "./index.mjs", require: "./index.cjs" },
          "./index.cjs",
        ],
        "./helpers": {
          import: "./helpers/helpers.mjs",
          require: "./helpers/index.js",
        },
      },
    });

    test("./helpers resolves through exports", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const result = resolveModern(pkg, "./helpers", conds);

      expect(result.success).toBe(true);
      expect(result.path).toBe("./helpers/helpers.mjs");
    });
  });

  // ===========================================================================
  // Integration tests
  // ===========================================================================

  describe("integration: real packages", () => {
    test("chalk@5.4.1 resolves # imports correctly", async () => {
      await using result = await buildPackage("chalk@5.4.1");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("rxjs@7.8.1 builds a subpath import", async () => {
      await using result = await buildPackage("rxjs@7.8.1");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
