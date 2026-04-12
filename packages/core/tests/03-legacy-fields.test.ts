/**
 * Scenario 03 — Legacy Field Resolution
 *
 * Tests packages without `exports` that rely on `main`, `module`,
 * `browser` (string form), `unpkg`, `bin`, and `./index.js` fallback.
 *
 * @see docs/scenarios/03-legacy-fields.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  resolveLegacy,
  resolvePackageEntry,
  getResolverConditions,
  getLegacyMainFields,
  manifest,
  importArgs,
  resolveOpts,
  buildPackage,
} from "./helpers.ts";

// =============================================================================
// Unit tests — resolveLegacy with synthetic manifests
// =============================================================================

describe("03 · Legacy Field Resolution", () => {
  describe("3.1 — Only main field (isarray-like)", () => {
    const pkg = manifest({ main: "index.js" });

    test("browser build resolves to main", () => {
      const fields = ["browser", "module", "main"];
      const result = resolveLegacy(pkg, { browser: true }, fields);

      expect(result.excluded).toBe(false);
      expect(result.entryPoint).toBe("./index.js");
    });

    test("node build resolves to main", () => {
      const fields = ["module", "main"];
      const result = resolveLegacy(pkg, { browser: false }, fields);

      expect(result.excluded).toBe(false);
      expect(result.entryPoint).toBe("./index.js");
    });
  });

  describe("3.2 — module field (lodash-es-like)", () => {
    const pkg = manifest({
      main: "lodash.js",
      module: "lodash.js",
      type: "module",
      sideEffects: false,
    });

    test("browser build picks module field", () => {
      const fields = ["browser", "module", "main"];
      const result = resolveLegacy(pkg, { browser: true }, fields);

      // No browser field → falls to module
      expect(result.excluded).toBe(false);
      expect(result.entryPoint).toBe("./lodash.js");
    });
  });

  describe("3.3 — browser string form (signal-exit-like)", () => {
    // Without exports so legacy path is taken
    const pkg = manifest({
      main: "./dist/cjs/index.js",
      module: "./dist/mjs/index.js",
      browser: "./dist/mjs/browser.js",
    });

    test("browser build uses the browser string entry", () => {
      const fields = ["browser", "module", "main"];
      const result = resolveLegacy(pkg, { browser: true }, fields);

      expect(result.excluded).toBe(false);
      expect(result.entryPoint).toBe("./dist/mjs/browser.js");
    });

    test("node build ignores browser → uses module", () => {
      const fields = ["module", "main"];
      const result = resolveLegacy(pkg, { browser: false }, fields);

      expect(result.excluded).toBe(false);
      expect(result.entryPoint).toBe("./dist/mjs/index.js");
    });
  });

  describe("3.4 — No entry point fields at all", () => {
    const pkg = manifest({});

    test("resolvePackageEntry falls back to ./index.js", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts());
      const fields = getLegacyMainFields(pkg, importArgs(), resolveOpts());
      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: ".",
        conditions: conds,
        legacyFields: fields,
      });

      expect(result.path).toBe("./index.js");
    });
  });

  describe("3.5 — unpkg / jsdelivr CDN fields", () => {
    const pkg = manifest({ unpkg: "dist/global.js" });

    test("falls to unpkg field when main/module are missing", () => {
      const fields = ["module", "main"];
      const result = resolveLegacy(pkg, { browser: false }, fields);

      // main/module missing → should fall to unpkg
      // resolveLegacy checks unpkg as a fallback
      // Note: legacy() normalizes the path with "./" prefix
      expect(result.entryPoint).toBe("./dist/global.js");
    });
  });

  describe("3.7 — jsnext:main is NOT recognized", () => {
    const pkg = manifest({
      main: "./moment.js",
      "jsnext:main": "./dist/moment.js",
    });

    test("resolveLegacy ignores jsnext:main, picks main", () => {
      const fields = ["module", "main"];
      const result = resolveLegacy(pkg, { browser: false }, fields);

      expect(result.entryPoint).toBe("./moment.js");
    });
  });

  describe("3.8 — exports takes precedence over legacy", () => {
    const pkg = manifest({
      main: "./dist/cjs/index.js",
      module: "./dist/mjs/index.js",
      browser: "./dist/mjs/browser.js",
      exports: {
        ".": {
          import: { default: "./dist/mjs/index.js" },
          require: { default: "./dist/cjs/index.js" },
        },
      },
    });

    test("resolvePackageEntry uses modern resolution (exports) first", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const fields = getLegacyMainFields(pkg, importArgs(), resolveOpts());
      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: ".",
        conditions: conds,
        legacyFields: fields,
      });

      // exports exists → should use modern resolution → import condition
      expect(result.usedModern).toBe(true);
      expect(result.path).toBe("./dist/mjs/index.js");
      // NOT ./dist/mjs/browser.js (which is the legacy browser field)
    });
  });

  // ===========================================================================
  // Integration tests
  // ===========================================================================

  describe("integration: real packages", () => {
    test("isarray@2.0.5 builds with only main field", async () => {
      await using result = await buildPackage("isarray@2.0.5");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("lodash-es@4.17.21 builds with module field", async () => {
      await using result = await buildPackage("lodash-es@4.17.21");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("ms@2.1.3 builds with extensionless main", async () => {
      await using result = await buildPackage("ms@2.1.3");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
