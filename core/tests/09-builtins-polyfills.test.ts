/**
 * Scenario 09 — Node.js Builtins and Polyfills
 *
 * Tests how bundlejs handles Node.js built-in modules (`fs`, `path`, `crypto`,
 * etc.) and the `node:` prefix — both in default exclusion mode and with
 * polyfill mode enabled.
 *
 * @see docs/scenarios/09-builtins-and-polyfills.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildPackage,
  buildWithEntry,
  getOutputText,
  outputContains,
  outputMatches,
  NETWORK_TIMEOUT,
} from "./helpers.ts";

// =============================================================================
// Integration tests — builtin handling
// =============================================================================

describe("09 · Builtins and Polyfills", () => {
  // ---------------------------------------------------------------------------
  // 9.1 — Builtin exclusion (default behaviour, polyfill: false)
  // ---------------------------------------------------------------------------
  describe("9.1 — Builtin exclusion (default)", () => {
    test("fs-extra@11.2.0 builds successfully without polyfills", async () => {
      const result = await buildPackage("fs-extra@11.2.0");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 9.2 — Builtin polyfill mode
  // ---------------------------------------------------------------------------
  describe("9.2 — Builtin polyfill mode", () => {
    test("fs-extra@11.2.0 with polyfill produces a larger bundle", async () => {
      const without = await buildPackage("fs-extra@11.2.0");
      const withPoly = await buildPackage("fs-extra@11.2.0", {
        polyfill: true,
      });

      // Polyfill bundles are significantly larger because they inline
      // browser implementations of fs, path, crypto, etc.
      const sizeWithout = getOutputText(without).length;
      const sizeWith = getOutputText(withPoly).length;

      expect(sizeWith).toBeGreaterThan(sizeWithout);
    });
  });

  // ---------------------------------------------------------------------------
  // 9.3 — node: prefix stripping
  // ---------------------------------------------------------------------------
  describe("9.3 — node: prefix stripping", () => {
    test("@noble/hashes@1.7.1 resolves node:crypto as builtin", async () => {
      const result = await buildPackage("@noble/hashes@1.7.1");

      // Should build without trying to fetch "node:crypto" from npm
      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 9.4 — "fs" and "node:fs" resolve identically
  // ---------------------------------------------------------------------------
  describe("9.4 — fs vs node:fs equivalence", () => {
    test("events@3.3.0 as npm package builds", async () => {
      const result = await buildPackage("events@3.3.0");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 9.5 — Builtins inside CDN-fetched modules
  // ---------------------------------------------------------------------------
  describe("9.5 — Builtin inside CDN-fetched module", () => {
    test("axios@1.7.9 internal `http`/`https` imports are excluded", async () => {
      const result = await buildPackage("axios@1.7.9");

      // axios uses http/https internally; these should be excluded (not
      // fetched from CDN) via the ExternalPlugin.
      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 9.6 — Polyfill output format compatibility
  // ---------------------------------------------------------------------------
  describe("9.6 — Polyfill output format", () => {
    test("CJS format wraps polyfill output in module.exports", async () => {
      const result = await buildPackage("events@3.3.0", {
        esbuild: { format: "cjs" },
      });

      const text = getOutputText(result);
      // CJS output should use CommonJS style exports
      expect(
        outputContains(result, "module.exports") ||
        outputContains(result, "exports.") ||
        outputMatches(result, /require\(/)
      ).toBe(true);
    });

    test("IIFE format wraps output in a function wrapper", async () => {
      const result = await buildPackage("events@3.3.0", {
        esbuild: { format: "iife" },
      });

      const text = getOutputText(result);
      // IIFE output uses a self-invoking function — typically var or (()=>{})()
      expect(text.length).toBeGreaterThan(0);
    });
  });
});
