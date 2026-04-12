/**
 * Scenario 08 — Non-npm Resolution (JSR, Tarballs, Import Maps)
 *
 * Tests resolution paths that bypass the standard npm CDN pipeline —
 * JSR registry, tarball extraction, and import map remapping.
 *
 * @see docs/scenarios/08-non-npm-resolution.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildPackage,
  buildWithEntry,
} from "./helpers.ts";

// =============================================================================
// Integration tests — JSR
// =============================================================================

describe("08 · Non-npm Resolution", () => {
  describe("JSR resolution", () => {
    test("8.1 — basic jsr:@std/path@1.0.0 resolves", async () => {
      await using result = await buildPackage("jsr:@std/path@1.0.0");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("8.3 — JSR with subpath export (jsr:@std/path@1.0.0/posix)", async () => {
      await using result = await buildWithEntry(
        `export * from "jsr:@std/path@1.0.0/posix";`,
      );

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });

  // ===========================================================================
  // Integration tests — Tarballs
  // ===========================================================================

  describe("Tarball extraction", () => {
    test("8.6 — tarball from pkg.pr.new resolves", async () => {
      await using result = await buildWithEntry(
        `export * from "https://pkg.pr.new/@tanstack/react-query@7988";`,
      );

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
