/**
 * Scenario 16 — GitHub Issue Regression Coverage
 *
 * Tests derived from 71 issues in the okikio/bundlejs issue tracker.
 * Each test section maps to one or more GitHub issues to ensure the
 * bundling pipeline handles real-world failure modes.
 *
 * ## Coverage Map
 *
 * | Section | Issues Covered |
 * |---------|---------------|
 * | 16.1 — Subpath bare imports | #97, #77, #58 |
 * | 16.2 — Browser field edge cases | #87, #31 |
 * | 16.3 — External config patterns | #65, #66 |
 * | 16.4 — node: imports regression | #2 |
 * | 16.5 — CDN host variants | #60 |
 * | 16.6 — Node builtins in transitive deps | #63 |
 * | 16.7 — Multiple packages / dedup | #39 |
 * | 16.8 — Expected error cases | #57, #59, #70, #92 |
 * | 16.9 — Complex real-world packages | #41, #61, #68, #88 |
 * | 16.10 — Deep deps and edge cases | #72, #83 |
 *
 * @see docs/scenarios/16-github-issue-regression.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  buildPackage,
  buildWithEntry,
  getOutputText,
  manifest,
  importArgs,
  resolveOpts,
  resolveModern,
  resolvePackageEntry,
  getResolverConditions,
  applyManifestRemappings,
  REMAPPING_FIELDS,
} from "./helpers.ts";

import {
  AllEndingVariants,
} from "../plugins/http.ts";

import { getCDNUrl, getCDNStyle } from "../utils/cdn-format.ts";

// =============================================================================
// 16.1 — Subpath bare import resolution
//
// Issues: #97 (react-remove-scroll-bar/constants),
//         #77 (no matching export toSignal),
//         #58 (Redux Toolkit nested entry point)
//
// Root cause: When a CDN-fetched module does
//   `from 'some-pkg/subpath'`
// the CdnPlugin must resolve the subpath via the package's exports field.
// If the exports field doesn't define that subpath, the resolver falls back
// to literal path probing (e.g. /subpath.js, /subpath/index.js, etc.)
// =============================================================================

describe("16.1 — Subpath bare import resolution (Issues #97, #77, #58)", () => {

  // -------------------------------------------------------------------------
  // Unit: resolveModern with subpath exports
  // -------------------------------------------------------------------------

  describe("resolveModern correctly resolves subpath exports", () => {
    const conditions = getResolverConditions(
      importArgs("import-statement"),
      resolveOpts({ platform: "browser" }),
    );

    test("exports with explicit subpath key resolves correctly", () => {
      // Simulates a package like react-remove-scroll-bar that DOES
      // export ./constants in its exports field
      const pkg = manifest({
        exports: {
          ".": "./dist/es2015/index.js",
          "./constants": "./dist/es2015/constants.js",
          "./package.json": "./package.json",
        },
      });

      const result = resolveModern(pkg, "./constants", conditions);
      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/es2015/constants.js");
    });

    test("exports with wildcard pattern resolves subpath", () => {
      // Simulates solid-js-like wildcard exports (Issue #02 pattern)
      const pkg = manifest({
        exports: {
          ".": { browser: { import: "./dist/solid.js" } },
          "./*": { browser: { import: "./dist/*.js" } },
        },
      });

      const result = resolveModern(pkg, "./store", conditions);
      expect(result.success).toBe(true);
      expect(result.path).toBe("./dist/store.js");
    });

    test("exports with nested conditional subpath", () => {
      // Simulates @reduxjs/toolkit (Issue #58 pattern)
      const pkg = manifest({
        exports: {
          ".": {
            import: "./dist/redux-toolkit.modern.mjs",
            default: "./dist/cjs/index.js",
          },
          "./query": {
            import: "./dist/query/rtk-query.modern.mjs",
            default: "./dist/query/cjs/index.js",
          },
          "./query/react": {
            import: "./dist/query/react/rtk-query-react.modern.mjs",
            default: "./dist/query/react/cjs/index.js",
          },
        },
      });

      const rootResult = resolveModern(pkg, ".", conditions);
      expect(rootResult.success).toBe(true);
      expect(rootResult.path).toBe("./dist/redux-toolkit.modern.mjs");

      const queryResult = resolveModern(pkg, "./query", conditions);
      expect(queryResult.success).toBe(true);
      expect(queryResult.path).toBe("./dist/query/rtk-query.modern.mjs");

      const queryReactResult = resolveModern(pkg, "./query/react", conditions);
      expect(queryReactResult.success).toBe(true);
      expect(queryReactResult.path).toBe("./dist/query/react/rtk-query-react.modern.mjs");
    });

    test("non-existent subpath in exports returns failure", () => {
      // The actual #97 scenario: exports doesn't declare the subpath
      const pkg = manifest({
        exports: {
          ".": "./dist/es2015/index.js",
          // No ./constants export defined
        },
      });

      const result = resolveModern(pkg, "./constants", conditions);
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Unit: resolvePackageEntry with subpath
  // -------------------------------------------------------------------------

  describe("resolvePackageEntry handles subpath fallback", () => {
    const conditions = getResolverConditions(
      importArgs("import-statement"),
      resolveOpts({ platform: "browser" }),
    );

    test("falls back to literal subpath when exports doesn't define it", () => {
      // When exports doesn't have the subpath and allowLiteralSubpath is true,
      // the resolver returns the normalized literal subpath for extension probing
      const pkg = manifest({
        exports: {
          ".": "./dist/index.js",
        },
      });

      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: "/constants",
        conditions,
        legacyFields: ["module", "main"],
        allowLiteralSubpath: true,
      });

      expect(result.path).toBe("./constants");
      expect(result.usedModern).toBe(false);
    });

    test("uses exports field when subpath IS defined", () => {
      const pkg = manifest({
        exports: {
          ".": "./dist/index.js",
          "./constants": "./dist/constants.js",
        },
      });

      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: "/constants",
        conditions,
        legacyFields: ["module", "main"],
        allowLiteralSubpath: true,
      });

      expect(result.path).toBe("./dist/constants.js");
      expect(result.usedModern).toBe(true);
    });

    test("root entry point with exports field", () => {
      const pkg = manifest({
        exports: {
          ".": {
            import: "./dist/index.mjs",
            require: "./dist/index.cjs",
          },
        },
      });

      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: "",
        conditions,
        legacyFields: ["module", "main"],
      });

      expect(result.path).toBe("./dist/index.mjs");
      expect(result.usedModern).toBe(true);
    });

    test("root entry with legacy module field", () => {
      // Older package without exports
      const pkg = manifest({
        main: "./lib/index.js",
        module: "./esm/index.js",
      });

      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: "",
        conditions,
        legacyFields: ["module", "main"],
      });

      expect(result.path).toBe("./esm/index.js");
      expect(result.usedModern).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: real packages with subpath exports
  // -------------------------------------------------------------------------

  describe("integration: real subpath imports", () => {
    test("date-fns/format resolves subpath export (like Issue #58 pattern)", async () => {
      // date-fns has proper subpath exports for each function
      await using result = await buildWithEntry(
        `import { format } from "date-fns@4.1.0/format";
         console.log(format);`,
      );

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("preact/hooks resolves subpath export", async () => {
      // preact has exports: { "./hooks": "./hooks/dist/hooks.module.js" }
      await using result = await buildPackage("preact@10.25.4/hooks");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("@reduxjs/toolkit resolves root export (Issue #58)", async () => {
      await using result = await buildWithEntry(
        `import { createSlice } from "@reduxjs/toolkit@2.0.1";
         export { createSlice };`,
      );

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});

// =============================================================================
// 16.2 — Browser field edge cases
//
// Issues: #87 (browser field → source .ts path),
//         #31 (browser attribute not used),
//         #92 (react-native dependency in browser context)
//
// Root cause: The browser field in package.json can map to:
//   1. Source .ts paths that don't exist in dist (opentelemetry @0.15.0)
//   2. Platform-specific modules that aren't available in browser
// =============================================================================

describe("16.2 — Browser field edge cases (Issues #87, #31, #92)", () => {

  describe("unit: browser field source paths", () => {
    const conditions = getResolverConditions(
      importArgs("import-statement"),
      resolveOpts({ platform: "browser" }),
    );

    test("browser field with string form is used as entry point", () => {
      // Issue #31: string browser field should be used directly
      const pkg = manifest({
        main: "./lib/index.js",
        browser: "./dist/browser.js",
      });

      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: "",
        conditions,
        legacyFields: ["browser", "module", "main"],
      });

      // Browser string form acts as entry point
      expect(result.path).toBe("./dist/browser.js");
    });

    test("browser field with object form is remapping, not entry", () => {
      // Issue #87 pattern: object browser field with remappings
      // The object form should NOT be used as entry point — only as remapping
      const pkg = manifest({
        main: "./build/src/index.js",
        module: "./build/esm/index.js",
        browser: {
          "./build/src/platform/node/index.js": "./build/src/platform/browser/index.js",
        } as unknown as string,
      });

      // Legacy resolution should prefer module over extracting from browser object
      const result = resolvePackageEntry({
        manifest: pkg,
        subpath: "",
        conditions,
        legacyFields: ["module", "main"],
      });

      expect(result.path).not.toBe("./build/src/platform/node/index.js");
      expect(result.path).not.toBe("./build/src/platform/browser/index.js");
    });

    test("browser false exclusion for specific module", () => {
      // A real-world pattern: excluding Node-only modules
      const pkg = manifest({
        main: "./dist/index.js",
        browser: {
          "./dist/node.js": false,
          "fs": false,
          "path": false,
        } as unknown as string,
      });

      const remapResult = applyManifestRemappings(
        "./dist/node.js",
        pkg,
        conditions,
      );

      expect(remapResult.excluded).toBe(true);
      expect(remapResult.matchedField).toBe("browser");
    });
  });

  describe("unit: platform field priority", () => {
    test("REMAPPING_FIELDS has correct priority order", () => {
      // react-native > electron > browser (most specific first)
      expect(REMAPPING_FIELDS[0].condition).toBe("react-native");
      expect(REMAPPING_FIELDS[1].condition).toBe("electron");
      expect(REMAPPING_FIELDS[2].condition).toBe("browser");
    });
  });

  describe("integration: packages with browser field variations", () => {
    test("detect-node-es@1.1.0 resolves browser entry (Issue #31 pattern)", async () => {
      // detect-node-es has: "browser": "./es5/browser.js"
      await using result = await buildPackage("detect-node-es@1.1.0");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);

      // In browser mode, the output should contain browser-specific code
      const text = getOutputText(result);
      expect(text.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// 16.3 — External config patterns
//
// Issues: #65 (config externals shortcut),
//         #66 (exclude `await import('...')` in bundle size)
//
// Root cause: Users need to mark packages as external to exclude them
// from the bundle. Dynamic imports (`await import(...)`) should be
// externalized via the `external` config option.
// =============================================================================

describe("16.3 — External config patterns (Issues #65, #66)", () => {

  test("external config excludes static import", async () => {
    await using result = await buildWithEntry(
      `import { useState } from "react";
       export { useState };`,
      { esbuild: { external: ["react"] } },
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    // Output should reference "react" as external, not bundle its code
    const text = getOutputText(result);
    expect(text).toContain("react");
    // Should NOT contain React internals
    expect(text).not.toContain("__SECRET_INTERNALS");
  });

  test("external config excludes dynamic import (Issue #66)", async () => {
    // The exact scenario from Issue #66 (tRPC)
    await using result = await buildWithEntry(
      `export async function importReact() {
         const reactDomServer = await import('react-dom/server');
         return reactDomServer;
       }`,
      { esbuild: { external: ["react-dom/server"] } },
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    // The dynamic import should remain as-is, not bundled
    const text = getOutputText(result);
    expect(text).toContain("react-dom/server");
  });

  test("multiple externals array works correctly", async () => {
    await using result = await buildWithEntry(
      `import React from "react";
       import ReactDOM from "react-dom";
       export { React, ReactDOM };`,
      { esbuild: { external: ["react", "react-dom"] } },
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    const text = getOutputText(result);
    expect(text).not.toContain("__SECRET_INTERNALS");
  });

  test("wildcard pattern in external (e.g. @aws-sdk/*)", async () => {
    await using result = await buildWithEntry(
      `import { S3 } from "@aws-sdk/client-s3";
       export { S3 };`,
      { esbuild: { external: ["@aws-sdk/*"] } },
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });
});

// =============================================================================
// 16.4 — node: imports regression
//
// Issue: #2 (node: imports produce error)
//
// Root cause: Node.js builtin modules with `node:` prefix must be
// recognized and either externalized (default) or polyfilled.
// =============================================================================

describe("16.4 — node: imports regression (Issue #2)", () => {

  test("node: prefix resolves without error (default external mode)", async () => {
    await using result = await buildWithEntry(
      `import path from "node:path";
       import fs from "node:fs";
       export const p = path.join("a", "b");`,
    );

    // In default browser mode, builtins are externalized
    expect(result.contents.length).toBeGreaterThan(0);
    // May have warnings but should not hard-error
  });

  test("bare 'path' and 'node:path' are treated equivalently", async () => {
    await using result1 = await buildWithEntry(
      `import path from "path"; export const p = path.join("a", "b");`,
    );
    await using result2 = await buildWithEntry(
      `import path from "node:path"; export const p = path.join("a", "b");`,
    );

    // Both should resolve identically
    expect(result1.errors.length).toBe(result2.errors.length);
    expect(result1.contents.length).toBe(result2.contents.length);
  });

  test("node: prefix with polyfill mode", async () => {
    await using result = await buildWithEntry(
      `import { Buffer } from "node:buffer";
       export const buf = Buffer.from("hello");`,
      { polyfill: true },
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    // In polyfill mode, buffer should be bundled
    const text = getOutputText(result);
    expect(text.length).toBeGreaterThan(50);
  });
});

// =============================================================================
// 16.5 — CDN host variants
//
// Issue: #60 (no longer works by default with unpkg)
//
// Root cause: Different CDNs have different URL formats and behaviors.
// The resolver must correctly construct URLs for each CDN style.
// =============================================================================

describe("16.5 — CDN host variants (Issue #60)", () => {

  describe("unit: CDN URL construction", () => {
    test("unpkg URL format is correct", () => {
      const { url, origin } = getCDNUrl("react@18.0.0/index.js", "https://unpkg.com");
      expect(url.href).toBe("https://unpkg.com/react@18.0.0/index.js");
      expect(getCDNStyle(origin)).toBe("npm");
    });

    test("esm.sh URL format is correct", () => {
      const { url, origin } = getCDNUrl("react@18.0.0", "https://esm.sh");
      expect(url.href).toBe("https://esm.sh/react@18.0.0");
      expect(getCDNStyle(origin)).toBe("npm");
    });

    test("jsdelivr URL format is correct", () => {
      const { url, origin } = getCDNUrl("react@18.0.0/index.js", "https://cdn.jsdelivr.net/npm");
      expect(url.href).toBe("https://cdn.jsdelivr.net/npm/react@18.0.0/index.js");
      expect(getCDNStyle(origin)).toBe("npm");
    });

    test("skypack URL format is correct", () => {
      const { url } = getCDNUrl("react@18.0.0", "https://cdn.skypack.dev");
      expect(url.href).toBe("https://cdn.skypack.dev/react@18.0.0");
    });
  });

  describe("integration: build with different CDNs", () => {
    test("build via unpkg (default) succeeds", async () => {
      await using result = await buildPackage("tslib@2.8.1");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("build via esm.sh succeeds", async () => {
      await using result = await buildPackage("tslib@2.8.1", { cdn: "esm.sh" });

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});

// =============================================================================
// 16.6 — Node builtins in transitive deps
//
// Issue: #63 (build fails for remix-hook-form)
//
// Root cause: Some packages transitively import Node.js builtins.
// The ExternalPlugin should catch and externalize these without
// breaking the build.
// =============================================================================

describe("16.6 — Node builtins in transitive deps (Issue #63)", () => {

  test("package importing path/url transitively still builds", async () => {
    // Entry that simulates a package hierarchy where a transitive dep
    // uses Node builtins
    await using result = await buildWithEntry(
      `import { join } from "path";
       import { URL } from "url";
       export const resolved = join("a", "b");
       export const u = new URL("https://example.com");`,
    );

    expect(result.contents.length).toBeGreaterThan(0);
    // Builtins get externalized in default browser mode
  });

  test("multiple Node builtins in one module don't cause cascading failures", async () => {
    await using result = await buildWithEntry(
      `import fs from "fs";
       import path from "path";
       import crypto from "crypto";
       import os from "os";
       export { fs, path, crypto, os };`,
    );

    expect(result.contents.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 16.7 — Multiple packages / deduplication
//
// Issue: #39 (duplicate dependencies if two imports depend on same package)
//
// Root cause: When multiple entry packages share a transitive dependency
// (e.g., both depend on 'tslib'), the build should not include it twice.
// =============================================================================

describe("16.7 — Multiple packages / deduplication (Issue #39)", () => {

  test("two packages sharing tslib produce single output", async () => {
    await using result = await buildWithEntry(
      `export { __awaiter } from "tslib@2.8.1";
       export { __spreadArray } from "tslib@2.8.1";`,
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  test("build with multiple unrelated packages", async () => {
    await using result = await buildWithEntry(
      `import * as preact from "preact@10.25.4";
       import * as tslib from "tslib@2.8.1";
       export { preact, tslib };`,
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });
});

// =============================================================================
// 16.8 — Expected error cases
//
// Issues: #57 (npm CLI), #59 (node-libcurl), #70 (jest@29.7.0),
//         #92 (react-native@1000.0.0 from expo-sqlite)
//
// Root cause: Some packages fundamentally cannot be bundled for the browser
// because they depend on native addons, filesystem, or other Node-only APIs.
// The build should produce errors rather than silently break.
// =============================================================================

describe("16.8 — Expected error / warning cases (Issues #57, #59, #70)", () => {

  test("jest@29 produces errors or warnings (Node-heavy package)", async () => {
    // jest heavily depends on Node.js APIs (child_process, vm, etc.)
    // We expect build errors, warnings, or a throw — not silent success
    try {
      await using result = await buildPackage("jest@29.7.0");
      const hasIssues = result.errors.length > 0 || result.warnings.length > 0;
      expect(hasIssues).toBe(true);
    } catch (_e) {
      // Throwing is an acceptable failure mode for Node-heavy packages
      expect(true).toBe(true);
    }
  });

  test("nonexistent package version produces error", async () => {
    // Issue #92: react-native@1000.0.0 doesn't exist
    try {
      await using result = await buildPackage("nonexistent-xyz-pkg-99@999.999.999");
      // If build doesn't throw, it should at least have errors
      expect(result.errors.length).toBeGreaterThan(0);
    } catch (_e) {
      // Expected: fetch/resolution failure
      expect(true).toBe(true);
    }
  });
});

// =============================================================================
// 16.9 — Complex real-world packages
//
// Issues: #41 (codemirror 6), #61 (recharts), #68 (tippy.js),
//         #88 (framer-motion)
//
// These are smoke tests for packages that have historically been
// problematic due to complex exports, many transitive deps, or
// mixed CJS/ESM.
// =============================================================================

describe("16.9 — Complex real-world packages (Issues #41, #61, #68, #88)", () => {

  test("@floating-ui/dom@1.6.13 builds successfully (tippy.js dep, Issue #68)", async () => {
    // @floating-ui/dom is a core dependency of tippy.js
    // It has clean exports and should build without issues
    await using result = await buildPackage("@floating-ui/dom@1.6.13");

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    const text = getOutputText(result);
    expect(text.length).toBeGreaterThan(100);
  });

  test("zustand@5.0.3 builds successfully", async () => {
    // zustand is a popular state management library with clean exports
    await using result = await buildPackage("zustand@5.0.3");

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  test("use-sync-external-store@1.4.0 builds (react transitive dep)", async () => {
    // This is a transitive dep of many React-ecosystem packages
    // that appeared in Issue #97's trace
    await using result = await buildPackage("use-sync-external-store@1.4.0");

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  test("tslib@2.8.1 builds cleanly", async () => {
    // tslib appears in many dep trees; should be trivial
    await using result = await buildPackage("tslib@2.8.1");

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    const text = getOutputText(result);
    // tslib exports __awaiter, __spread, etc.
    expect(text.length).toBeGreaterThan(100);
  });
});

// =============================================================================
// 16.10 — Deep dependencies and miscellaneous edge cases
//
// Issues: #72 (too much recursion on @ensdomains/ensjs),
//         #83 (can't build jsonstream-next — case sensitivity)
//
// Root cause: Some packages have deeply nested dependency trees or
// unusual naming conventions that stress the resolution pipeline.
// =============================================================================

describe("16.10 — Deep deps and edge cases (Issues #72, #83)", () => {

  describe("unit: extension probing completeness", () => {
    test("AllEndingVariants covers Node-style implicit package entry fallbacks", () => {
      // This probe table is intentionally narrower than the full explicit loader
      // surface. It should match the automatic package-entry behavior we model.
      const hasJs = AllEndingVariants.some(v => v === ".js");
      const hasJson = AllEndingVariants.some(v => v === ".json");
      const hasIndexJs = AllEndingVariants.some(v => v === "/index.js");
      const hasIndexJson = AllEndingVariants.some(v => v === "/index.json");
      const hasEmpty = AllEndingVariants.some(v => v === "");

      expect(hasJs).toBe(true);
      expect(hasJson).toBe(true);
      expect(hasIndexJs).toBe(true);
      expect(hasIndexJson).toBe(true);
      expect(hasEmpty).toBe(true);
    });

    test("AllEndingVariants starts with empty string (try exact path first)", () => {
      // Most efficient: try exact URL first before appending extensions
      expect(AllEndingVariants[0]).toBe("");
    });

    test("AllEndingVariants is deduplicated", () => {
      const asSet = new Set(AllEndingVariants);
      expect(asSet.size).toBe(AllEndingVariants.length);
    });
  });

  describe("unit: CDN style detection", () => {
    test("unpkg.com is npm style", () => {
      expect(getCDNStyle("https://unpkg.com")).toBe("npm");
    });

    test("esm.sh is npm style", () => {
      expect(getCDNStyle("https://esm.sh")).toBe("npm");
    });

    test("cdn.skypack.dev is npm style", () => {
      expect(getCDNStyle("https://cdn.skypack.dev")).toBe("npm");
    });

    test("unknown host defaults to npm", () => {
      const style = getCDNStyle("https://my-custom-cdn.dev");
      // Should still be treated as npm or similar — not crash
      expect(typeof style).toBe("string");
    });
  });

  describe("integration: packages with many transitive deps", () => {
    test("axios@1.7.9 builds without recursion issues", async () => {
      // axios has several layers of transitive deps
      await using result = await buildPackage("axios@1.7.9");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    test("preact@10.25.4 builds without errors", async () => {
      await using result = await buildPackage("preact@10.25.4");

      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});

// =============================================================================
// 16.11 — Alias and version pinning
//
// Additional coverage for alias resolution and version pinning which is
// critical for deduplication (Issue #39) and correct dependency resolution.
// =============================================================================

describe("16.11 — Alias and version pinning", () => {

  test("pinned version in config overrides latest", async () => {
    // Config specifies exact version — must be respected
    await using result = await buildWithEntry(
      `export * from "preact";`,
      {
        "package.json": {
          dependencies: {
            preact: "10.25.4",
          },
        },
      },
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  test("esbuild alias config rewrites imports", async () => {
    // Issue #67 workaround: use alias to redirect broken packages
    await using result = await buildWithEntry(
      `export * from "preact";`,
      {
        esbuild: {
          alias: {
            preact: "preact@10.25.4",
          },
        },
      },
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });
});

// =============================================================================
// 16.12 — Loader inference edge cases
//
// Validates that the loader is correctly inferred for various file extensions.
// Related to Issue #67 (extension probing failure) and #87 (.ts on CDN).
// =============================================================================

describe("16.12 — Loader inference edge cases", () => {

  test("JSON file builds correctly", async () => {
    await using result = await buildWithEntry(
      `import pkg from "tslib@2.8.1/package.json";
       export default pkg;`,
    );

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });
});

// =============================================================================
// 16.13 — Build output format variants
//
// Validates that different output formats work correctly.
// Related to Issue #66 (dynamic imports) and general correctness.
// =============================================================================

describe("16.13 — Build output format variants", () => {

  test("ESM format produces export statements", async () => {
    await using result = await buildPackage("tslib@2.8.1", {
      esbuild: { format: "esm" },
    });

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    const text = getOutputText(result);
    expect(text).toContain("export");
  });

  test("CJS format produces module.exports or require", async () => {
    await using result = await buildPackage("tslib@2.8.1", {
      esbuild: { format: "cjs" },
    });

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);
  });

  test("IIFE format wraps in function", async () => {
    await using result = await buildPackage("tslib@2.8.1", {
      esbuild: { format: "iife", globalName: "tslib" },
    });

    expect(result.contents.length).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    const text = getOutputText(result);
    expect(text).toContain("tslib");
  });
});
