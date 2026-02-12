/**
 * Scenario 07 — Tree-Shaking and Side Effects
 *
 * Tests how bundlejs reads the `sideEffects` field and passes it
 * to esbuild for dead code elimination.
 *
 * @see docs/scenarios/07-tree-shaking.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  computeEsbuildSideEffects,
  compileSideEffectsMatchers,
  normalizeSideEffectsPattern,
  normalizePkgRelPath,
  isJsLikePath,
  manifest,
  buildPackage,
  buildWithEntry,
  getOutputText,
  NETWORK_TIMEOUT,
  UNIT_TIMEOUT,
} from "./helpers.ts";

// =============================================================================
// Unit tests — sideEffects computation
// =============================================================================

describe("07 · Tree-Shaking and Side Effects", () => {
  describe("sideEffects: false", () => {
    test("returns false when manifest has sideEffects: false", () => {
      const pkg = manifest({ sideEffects: false });
      const result = computeEsbuildSideEffects(pkg, "./index.js", {
        packageId: "lodash-es@4.17.21",
      });

      expect(result).toBe(false);
    });

    test("returns undefined when sideEffects field is absent", () => {
      const pkg = manifest({});
      const result = computeEsbuildSideEffects(pkg, "./index.js", {
        packageId: "moment@2.30.1",
      });

      // No sideEffects field → conservative (undefined = keep all)
      expect(result).toBeUndefined();
    });
  });

  describe("sideEffects: glob patterns", () => {
    test("JS file not in glob list returns false (tree-shakeable)", () => {
      const pkg = manifest({ sideEffects: ["./src/nodes/**/*"] });
      const result = computeEsbuildSideEffects(pkg, "./src/math/Vector3.js", {
        packageId: "three@0.171.0",
      });

      expect(result).toBe(false);
    });

    test("file matching glob returns undefined (has side effects)", () => {
      const pkg = manifest({ sideEffects: ["./src/nodes/**/*"] });
      const result = computeEsbuildSideEffects(pkg, "./src/nodes/ShaderNode.js", {
        packageId: "three@0.171.0",
      });

      expect(result).toBeUndefined();
    });

    test("*.css glob keeps CSS files", () => {
      const pkg = manifest({ sideEffects: ["*.css"] });
      const result = computeEsbuildSideEffects(pkg, "./styles/main.css", {
        packageId: "test-pkg@1.0.0",
      });

      expect(result).toBeUndefined();
    });

    test("*.css glob marks JS files as tree-shakeable", () => {
      const pkg = manifest({ sideEffects: ["*.css"] });
      const result = computeEsbuildSideEffects(pkg, "./src/index.js", {
        packageId: "test-pkg@1.0.0",
      });

      expect(result).toBe(false);
    });
  });

  describe("sideEffects: explicit file list", () => {
    test("exact match returns undefined (has side effects)", () => {
      const pkg = manifest({
        sideEffects: [
          "./src/reanimated2/core.js",
          "./plugin.js",
        ],
      });
      const result = computeEsbuildSideEffects(pkg, "./src/reanimated2/core.js", {
        packageId: "react-native-reanimated@3.16.7",
      });

      expect(result).toBeUndefined();
    });

    test("non-matching file returns false (tree-shakeable)", () => {
      const pkg = manifest({
        sideEffects: [
          "./src/reanimated2/core.js",
          "./plugin.js",
        ],
      });
      const result = computeEsbuildSideEffects(pkg, "./src/utils/helpers.js", {
        packageId: "react-native-reanimated@3.16.7",
      });

      expect(result).toBe(false);
    });
  });

  describe("path normalization utilities", () => {
    test("normalizePkgRelPath strips leading ./", () => {
      expect(normalizePkgRelPath("./src/index.js")).toBe("src/index.js");
    });

    test("normalizePkgRelPath handles bare paths", () => {
      expect(normalizePkgRelPath("src/index.js")).toBe("src/index.js");
    });

    test("isJsLikePath recognizes JS extensions", () => {
      expect(isJsLikePath("index.js")).toBe(true);
      expect(isJsLikePath("index.mjs")).toBe(true);
      expect(isJsLikePath("index.ts")).toBe(true);
      expect(isJsLikePath("index.tsx")).toBe(true);
    });

    test("isJsLikePath rejects non-JS extensions", () => {
      expect(isJsLikePath("styles.css")).toBe(false);
      expect(isJsLikePath("image.png")).toBe(false);
    });
  });

  // ===========================================================================
  // Integration tests
  // ===========================================================================

  describe("integration: tree-shaking with real packages", () => {
    test("lodash-es: selective import is smaller than full import", async () => {
      // Full import
      const full = await buildPackage("lodash-es@4.17.21");
      // Selective (tree-shaken) import
      const selective = await buildWithEntry(
        `export { debounce } from "lodash-es@4.17.21";`,
      );

      // Tree-shaken bundle should be significantly smaller
      const fullSize = full.contents.reduce((s, f) => s + f.contents.byteLength, 0);
      const selectiveSize = selective.contents.reduce((s, f) => s + f.contents.byteLength, 0);

      expect(selectiveSize).toBeLessThan(fullSize);
    });
  });
});
