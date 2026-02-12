/**
 * Scenario 12 — Runtime-Specific Condition Sets
 *
 * Tests that each supported runtime profile produces the correct
 * condition set, and that conditions flow correctly through the
 * entire resolution pipeline via `getResolverConditions()` and
 * `getRuntimeDefaults()`.
 *
 * @see docs/scenarios/12-runtime-conditions.md
 * @module
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  resolveModern,
  getResolverConditions,
  getRuntimeDefaults,
  isRequireContext,
  manifest,
  importArgs,
  resolveOpts,
  buildPackage,
  getOutputText,
  NETWORK_TIMEOUT,
  UNIT_TIMEOUT,
} from "./helpers.ts";

import type { ResolveRuntime } from "./helpers.ts";

// =============================================================================
// Unit tests — condition sets for every runtime
// =============================================================================

describe("12 · Runtime-Specific Condition Sets", () => {
  // ---------------------------------------------------------------------------
  // 12.1 — Default browser conditions
  // ---------------------------------------------------------------------------
  describe("12.1 — Default browser conditions", () => {
    it("produces import, browser, module, default", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ platform: "browser", format: "esm" }),
      );

      expect(conds.conditions).toContain("import");
      expect(conds.conditions).toContain("browser");
      expect(conds.conditions).toContain("module");
      expect(conds.conditions).toContain("default");
    });

    it("has browserField: true by default", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ platform: "browser" }),
      );

      expect(conds.browserField).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.2 — Deno runtime
  // ---------------------------------------------------------------------------
  describe("12.2 — Deno runtime", () => {
    it("includes deno + node conditions", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "deno" as ResolveRuntime }),
      );

      expect(conds.conditions).toContain("deno");
      expect(conds.conditions).toContain("node");
    });

    it("disables browserField", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "deno" as ResolveRuntime }),
      );

      expect(conds.browserField).toBe(false);
    });

    it("getRuntimeDefaults reports deno", () => {
      const defaults = getRuntimeDefaults("deno" as ResolveRuntime);
      expect(defaults.conditions).toContain("deno");
      expect(defaults.conditions).toContain("node");
      expect(defaults.browserField).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.3 — Bun runtime
  // ---------------------------------------------------------------------------
  describe("12.3 — Bun runtime", () => {
    it("includes bun + node conditions", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "bun" as ResolveRuntime }),
      );

      expect(conds.conditions).toContain("bun");
      expect(conds.conditions).toContain("node");
    });

    it("disables browserField", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "bun" as ResolveRuntime }),
      );

      expect(conds.browserField).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.4 — Cloudflare Workers (workerd)
  // ---------------------------------------------------------------------------
  describe("12.4 — Cloudflare Workers (workerd)", () => {
    it("includes workerd, worker, browser conditions", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "workerd" as ResolveRuntime }),
      );

      expect(conds.conditions).toContain("workerd");
      expect(conds.conditions).toContain("worker");
      expect(conds.conditions).toContain("browser");
    });

    it("disables browserField (server-like)", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "workerd" as ResolveRuntime }),
      );

      // Workers want browser-optimized *exports* paths but should NOT
      // apply legacy browser field remappings
      expect(conds.browserField).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.5 — Vercel Edge (edge-light)
  // ---------------------------------------------------------------------------
  describe("12.5 — Vercel Edge (edge-light)", () => {
    it("includes edge-light, worker, browser conditions", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "edge-light" as ResolveRuntime }),
      );

      expect(conds.conditions).toContain("edge-light");
      expect(conds.conditions).toContain("worker");
      expect(conds.conditions).toContain("browser");
    });

    it("enables browserField (unlike workerd)", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "edge-light" as ResolveRuntime }),
      );

      expect(conds.browserField).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.6 — React Native
  // ---------------------------------------------------------------------------
  describe("12.6 — React Native", () => {
    it("includes react-native condition", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "react-native" as ResolveRuntime }),
      );

      expect(conds.conditions).toContain("react-native");
    });

    it("disables browserField", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "react-native" as ResolveRuntime }),
      );

      expect(conds.browserField).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.7 — Electron main process
  // ---------------------------------------------------------------------------
  describe("12.7 — Electron main", () => {
    it("includes electron + node conditions", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "electron-main" as ResolveRuntime }),
      );

      expect(conds.conditions).toContain("electron");
      expect(conds.conditions).toContain("node");
    });

    it("disables browserField", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "electron-main" as ResolveRuntime }),
      );

      expect(conds.browserField).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.8 — Electron renderer
  // ---------------------------------------------------------------------------
  describe("12.8 — Electron renderer", () => {
    it("includes electron + browser conditions", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "electron-renderer" as ResolveRuntime }),
      );

      expect(conds.conditions).toContain("electron");
      expect(conds.conditions).toContain("browser");
    });

    it("enables browserField", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ runtime: "electron-renderer" as ResolveRuntime }),
      );

      expect(conds.browserField).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.9 — Custom user-provided conditions
  // ---------------------------------------------------------------------------
  describe("12.9 — Custom conditions", () => {
    it("adds user conditions to the list", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({
          platform: "browser",
          conditions: ["development", "react-server"],
        }),
      );

      expect(conds.conditions).toContain("development");
      expect(conds.conditions).toContain("react-server");
    });

    it("resolves solid-js development entry when development condition is present", () => {
      const pkg = manifest({
        name: "solid-js",
        version: "1.9.4",
        exports: {
          ".": {
            browser: {
              development: {
                import: "./dist/dev.js",
              },
              import: "./dist/solid.js",
            },
            default: "./dist/solid.cjs",
          },
        },
      });

      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({
          platform: "browser",
          conditions: ["development"],
        }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/dev.js");
    });

    it("resolves solid-js production entry without development condition", () => {
      const pkg = manifest({
        name: "solid-js",
        version: "1.9.4",
        exports: {
          ".": {
            browser: {
              development: {
                import: "./dist/dev.js",
              },
              import: "./dist/solid.js",
            },
            default: "./dist/solid.cjs",
          },
        },
      });

      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({ platform: "browser" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/solid.js");
    });
  });

  // ---------------------------------------------------------------------------
  // 12.10 — Condition deduplication
  // ---------------------------------------------------------------------------
  describe("12.10 — Condition deduplication", () => {
    it("browser appears only once even when platform and runtime both add it", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({
          platform: "browser",
          runtime: "electron-renderer" as ResolveRuntime,
        }),
      );

      // Count occurrences of "browser"
      const browserCount = conds.conditions.filter((c: string) => c === "browser").length;
      expect(browserCount).toBe(1);
    });

    it("node appears only once for electron-main + platform:node", () => {
      const conds = getResolverConditions(
        importArgs("import-statement"),
        resolveOpts({
          platform: "node",
          runtime: "electron-main" as ResolveRuntime,
        }),
      );

      const nodeCount = conds.conditions.filter((c: string) => c === "node").length;
      expect(nodeCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 12.11 — require context from CJS format
  // ---------------------------------------------------------------------------
  describe("12.11 — require context from CJS format", () => {
    it("CJS format + entry-point produces require context", () => {
      expect(
        isRequireContext(
          importArgs("entry-point"),
          resolveOpts({ format: "cjs" }),
        ),
      ).toBe(true);
    });

    it("ESM format + entry-point does NOT produce require context", () => {
      expect(
        isRequireContext(
          importArgs("entry-point"),
          resolveOpts({ format: "esm" }),
        ),
      ).toBe(false);
    });

    it("CJS format resolves uuid to require path", () => {
      const pkg = manifest({
        name: "uuid",
        exports: {
          ".": {
            node: {
              import: "./dist/esm/index.js",
              require: "./dist/cjs/index.js",
            },
            default: "./dist/esm-browser/index.js",
          },
        },
      });

      const conds = getResolverConditions(
        importArgs("require-call"),
        resolveOpts({ platform: "node", format: "cjs" }),
      );
      const result = resolveModern(pkg, ".", conds);
      expect(result.path).toBe("./dist/cjs/index.js");
    });
  });

  // ===========================================================================
  // Integration tests — end-to-end condition flow
  // ===========================================================================

  describe("integration: conditions flow through full pipeline", () => {
    it("12.1 — default browser build of solid-js succeeds", async () => {
      const result = await buildPackage("solid-js@1.9.4");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    }, { timeout: NETWORK_TIMEOUT });

    it("12.11 — CJS format build of uuid succeeds", async () => {
      const result = await buildPackage("uuid@11.0.5", {
        esbuild: { format: "cjs" },
      });

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    }, { timeout: NETWORK_TIMEOUT });
  });
});
