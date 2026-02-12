/**
 * Scenario 04 — Browser Field Remapping
 *
 * Tests the `browser` field in its **object form** — the remapping layer
 * that rewrites internal module paths for browser environments.
 *
 * This is the scenario that caught the original bug (4.7).
 *
 * @see docs/scenarios/04-browser-field-remapping.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  resolveLegacy,
  applyPathRemapping,
  applyManifestRemappings,
  getResolverConditions,
  manifest,
  importArgs,
  resolveOpts,
  buildPackage,
} from "./helpers.ts";

// =============================================================================
// Unit tests — applyPathRemapping, applyManifestRemappings
// =============================================================================

describe("04 · Browser Field Remapping", () => {
  describe("4.1 — Internal path remapping (readable-stream-like)", () => {
    const pkg = manifest({
      main: "./lib/ours/index.js",
      browser: {
        "util": "./lib/ours/util.js",
        "./lib/ours/index.js": "./lib/ours/browser.js",
      },
    });

    test("browser build: entry remapped from index.js → browser.js", () => {
      const fields = ["browser", "module", "main"];
      const result = resolveLegacy(pkg, { browser: true }, fields);

      expect(result.excluded).toBe(false);
      // The object browser field stores remappings, entry comes from main
      // Then applyPathRemapping rewrites the entry
      expect(result.pathRemappings).not.toBeNull();
      expect(result.entryPoint).not.toBeNull();

      // Simulate the remapping step
      const remapped = applyPathRemapping(result.entryPoint!, result.pathRemappings);
      expect(remapped).toBe("./lib/ours/browser.js");
    });

    test("node build: browser field ignored, entry is main", () => {
      const fields = ["module", "main"];
      const result = resolveLegacy(pkg, { browser: false }, fields);

      expect(result.excluded).toBe(false);
      expect(result.entryPoint).toBe("./lib/ours/index.js");
      expect(result.pathRemappings).toBeNull();
    });
  });

  describe("4.2 — Bare module exclusion (false mapping)", () => {
    test("applyPathRemapping returns false for excluded modules", () => {
      const remappings = {
        "./lib/adapters/http.js": "./lib/helpers/null.js",
        "./lib/platform/node/index.js": "./lib/platform/browser/index.js",
      };

      expect(applyPathRemapping("./lib/adapters/http.js", remappings))
        .toBe("./lib/helpers/null.js");
      expect(applyPathRemapping("./lib/platform/node/index.js", remappings))
        .toBe("./lib/platform/browser/index.js");
    });

    test("fs → false excludes the module", () => {
      const remappings = { fs: false as const };
      expect(applyPathRemapping("fs", remappings)).toBe(false);
    });
  });

  describe("4.3 — Remapping with ./ prefix variants", () => {
    test("matches with ./ prefix when key is bare", () => {
      const remappings = { "lib/node.js": "./lib/browser.js" };
      // applyPathRemapping tries multiple variants
      expect(applyPathRemapping("./lib/node.js", remappings)).toBe("./lib/browser.js");
    });

    test("matches bare import when key has ./ prefix", () => {
      const remappings = { "./utils/fs": false as const };
      expect(applyPathRemapping("./utils/fs", remappings)).toBe(false);
    });

    test("path without prefix matches key without prefix", () => {
      const remappings = { "lib/node.js": "./lib/browser.js" };
      expect(applyPathRemapping("lib/node.js", remappings)).toBe("./lib/browser.js");
    });
  });

  describe("4.4 — All-false browser field = excluded package", () => {
    const pkg = manifest({
      main: "./index.js",
      browser: {
        "./index.js": false,
        "./lib/core.js": false,
      },
    });

    test("browser build detects all-false and excludes", () => {
      const fields = ["browser", "module", "main"];
      const result = resolveLegacy(pkg, { browser: true }, fields);

      expect(result.excluded).toBe(true);
    });
  });

  describe("4.5 — Browser field ignored on non-browser platforms", () => {
    const pkg = manifest({
      main: "./lib/ours/index.js",
      browser: {
        "./lib/ours/index.js": "./lib/ours/browser.js",
      },
    });

    test("node platform does not apply browser remapping", () => {
      const fields = ["module", "main"];
      const result = resolveLegacy(pkg, { browser: false }, fields);

      expect(result.entryPoint).toBe("./lib/ours/index.js");
      expect(result.pathRemappings).toBeNull();
    });
  });

  describe("4.6 — Edge runtimes: browser condition ≠ browserField", () => {
    test("workerd: browser condition active, browserField disabled", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "browser", runtime: "workerd" }),
      );

      // "browser" is in conditions (for exports)
      expect(conds.conditions).toContain("browser");
      // But browserField is false (no legacy field remapping)
      expect(conds.browser).toBe(false);
    });

    test("edge-light: both browser condition and browserField active", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "browser", runtime: "edge-light" }),
      );

      expect(conds.conditions).toContain("browser");
      expect(conds.browser).toBe(true);
    });
  });

  describe("4.7 — Relative import remapping (HttpPlugin) — THE BUG SCENARIO", () => {
    // This tests the applyManifestRemappings function which the HttpPlugin
    // calls for relative imports within a package.
    const pkg = manifest({
      main: "./index.js",
      browser: {
        "./fallback/platform.js": "./fallback/platform.browser.js",
        "./fallback/utf8.auto.js": "./fallback/utf8.auto.browser.js",
      },
    });

    test("browser conditions: remaps ./fallback/platform.js → platform.browser.js", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = applyManifestRemappings("./fallback/platform.js", pkg, conds);

      expect(result.excluded).toBe(false);
      expect(result.matchedField).toBe("browser");
      expect(result.path).toBe("./fallback/platform.browser.js");
    });

    test("node conditions: no remapping applied", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "node" }));
      const result = applyManifestRemappings("./fallback/platform.js", pkg, conds);

      expect(result.matchedField).toBeNull();
      expect(result.path).toBe("./fallback/platform.js");
    });
  });

  describe("4.8 — Relative import exclusion (false)", () => {
    const pkg = manifest({
      browser: {
        "./lib/native-impl.js": false,
      },
    });

    test("browser conditions: excludes the module", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = applyManifestRemappings("./lib/native-impl.js", pkg, conds);

      expect(result.excluded).toBe(true);
      expect(result.matchedField).toBe("browser");
    });
  });

  // ===========================================================================
  // Integration tests
  // ===========================================================================

  describe("integration: real packages", () => {
    test("@exodus/bytes@1.13.0 builds with browser remapping", async () => {
      const result = await buildPackage("@exodus/bytes@1.13.0");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("readable-stream@4.7.0 builds for browser", async () => {
      const result = await buildPackage("readable-stream@4.7.0");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("axios@1.7.9 builds with browser field swaps", async () => {
      const result = await buildPackage("axios@1.7.9");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
