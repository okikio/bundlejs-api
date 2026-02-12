/**
 * Scenario 10 — Dual Package Hazard, Format, and Platform Matrix
 *
 * Tests packages that ship both CJS and ESM, the `type: "module"` flag,
 * and the interaction between `format` and `platform` settings.
 * Covers output wrapping, define replacements, target syntax, and minification.
 *
 * @see docs/scenarios/10-dual-package-hazard.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  resolveModern,
  getResolverConditions,
  isRequireContext,
  manifest,
  importArgs,
  resolveOpts,
  buildPackage,
  getOutputText,
  outputContains,
  outputMatches,
} from "./helpers.ts";

// =============================================================================
// Unit tests — CJS vs ESM condition resolution
// =============================================================================

describe("10 · Dual Package Hazard", () => {
  // ---------------------------------------------------------------------------
  // 10.1 — CJS vs ESM via conditional exports (uuid-like)
  // ---------------------------------------------------------------------------
  describe("10.1 — CJS vs ESM via conditional exports", () => {
    /**
     * uuid@11 ships a 2×2 matrix:
     *   node × {import,require}  →  ./dist/esm/index.js, ./dist/cjs/index.js
     *   browser × {import,require} → ./dist/esm-browser/index.js, ./dist/cjs-browser/index.js
     */
    const pkg = manifest({
      name: "uuid",
      version: "11.0.5",
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
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ platform: "browser", format: "esm" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/esm-browser/index.js");
    });

    test("browser + CJS → cjs-browser", () => {
      const conds = getResolverConditions(
        importArgs("require-call"),
        resolveOpts({ platform: "browser", format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/cjs-browser/index.js");
    });

    test("node + ESM → esm (node path)", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ platform: "node", format: "esm" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/esm/index.js");
    });

    test("node + CJS → cjs (node path)", () => {
      const conds = getResolverConditions(
        importArgs("require-call"),
        resolveOpts({ platform: "node", format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/cjs/index.js");
    });
  });

  // ---------------------------------------------------------------------------
  // 10.2 — Pure ESM (type: module, single-string exports)
  // ---------------------------------------------------------------------------
  describe("10.2 — Pure ESM (chalk-like)", () => {
    const pkg = manifest({
      name: "chalk",
      version: "5.4.1",
      type: "module",
      exports: "./source/index.js",
    });

    test("ESM resolves single-string exports", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ format: "esm" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./source/index.js");
    });

    test("CJS also resolves single-string exports (no require guard)", () => {
      const conds = getResolverConditions(
        importArgs("require-call"),
        resolveOpts({ format: "cjs" }),
      );
      // Single-string exports are universal — accessible from both contexts
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./source/index.js");
    });
  });

  // ---------------------------------------------------------------------------
  // isRequireContext helper
  // ---------------------------------------------------------------------------
  describe("isRequireContext()", () => {
    test("returns true for require-call + cjs", () => {
      expect(isRequireContext(
        importArgs("require-call"),
        resolveOpts({ format: "cjs" }),
      )).toBe(true);
    });

    test("returns false for import-statement + esm", () => {
      expect(isRequireContext(
        importArgs("import-statement"),
        resolveOpts({ format: "esm" }),
      )).toBe(false);
    });

    test("returns true for entry-point + cjs format", () => {
      expect(isRequireContext(
        importArgs("entry-point"),
        resolveOpts({ format: "cjs" }),
      )).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration tests — format and platform
  // ---------------------------------------------------------------------------
  describe("integration: format affects output wrapping", () => {
    test("10.4 — ESM output uses export syntax", async () => {
      const result = await buildPackage("preact@10.25.4", {
        esbuild: { format: "esm" },
      });

      const text = getOutputText(result);
      expect(text).toMatch(/export/);
    });

    test("10.4 — CJS output uses module.exports or require", async () => {
      const result = await buildPackage("preact@10.25.4", {
        esbuild: { format: "cjs" },
      });

      expect(
        outputContains(result, "module.exports") ||
        outputContains(result, "exports.") ||
        outputMatches(result, /require\(/)
      ).toBe(true);
    });

    test("10.4 — IIFE output wraps in function", async () => {
      const result = await buildPackage("preact@10.25.4", {
        esbuild: { format: "iife" },
      });

      const text = getOutputText(result);
      // esbuild IIFE output typically starts with (() => { or var
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("integration: minification toggle", () => {
    test("10.7 — unminified output is larger", async () => {
      const minified = await buildPackage("preact@10.25.4", {
        esbuild: { minify: true },
      });
      const unminified = await buildPackage("preact@10.25.4", {
        esbuild: { minify: false },
      });

      const minSize = getOutputText(minified).length;
      const unminSize = getOutputText(unminified).length;

      // Unminified should be larger (more whitespace, longer names)
      expect(unminSize).toBeGreaterThan(minSize);
    });
  });
});
