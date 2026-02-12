/**
 * Scenario 06 — Relative Imports, CDN Redirects, and Extension Probing
 *
 * Tests how the HttpPlugin resolves relative imports inside CDN-fetched
 * modules, handles CDN redirects, and probes for missing extensions.
 *
 * @see docs/scenarios/06-relative-imports.md
 * @module
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildPackage,
  buildWithEntry,
  getOutputText,
  NETWORK_TIMEOUT,
} from "./helpers.ts";

// =============================================================================
// Integration tests — these hit the network to verify real resolution paths
// =============================================================================

describe("06 · Relative Imports and CDN Behavior", () => {
  describe("6.1 — Post-redirect URL as resolve base", () => {
    it("react@19.0.0 via esm.sh resolves relative imports after redirect", async () => {
      const result = await buildPackage("react@19.0.0", {
        cdn: "esm.sh",
      });

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    }, { timeout: NETWORK_TIMEOUT });
  });

  describe("6.2 — Extension probing for extensionless imports", () => {
    it("events@3.3.0 resolves extensionless internal imports", async () => {
      const result = await buildPackage("events@3.3.0");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    }, { timeout: NETWORK_TIMEOUT });
  });

  describe("6.5 — Bare import inside HTTP module delegates to CdnPlugin", () => {
    it("axios@1.7.9 resolves transitive bare imports", async () => {
      const result = await buildPackage("axios@1.7.9");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    }, { timeout: NETWORK_TIMEOUT });
  });

  describe("6.8 — # imports inside HTTP modules", () => {
    it("chalk@5.4.1 resolves # imports in CDN-fetched source", async () => {
      const result = await buildPackage("chalk@5.4.1");

      // chalk uses #supports-color and #ansi-styles
      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    }, { timeout: NETWORK_TIMEOUT });
  });
});
