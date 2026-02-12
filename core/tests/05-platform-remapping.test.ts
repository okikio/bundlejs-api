/**
 * Scenario 05 — Platform-Specific Remapping (react-native, electron)
 *
 * Tests manifest field remappings beyond the `browser` field — specifically
 * the `react-native` and `electron` top-level fields.
 *
 * @see docs/scenarios/05-platform-remapping.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  applyManifestRemappings,
  REMAPPING_FIELDS,
  getResolverConditions,
  getRuntimeDefaults,
  manifest,
  importArgs,
  resolveOpts,
} from "./helpers.ts";

describe("05 · Platform-Specific Remapping", () => {
  describe("REMAPPING_FIELDS ordering", () => {
    test("is ordered: react-native → electron → browser", () => {
      expect(REMAPPING_FIELDS[0].condition).toBe("react-native");
      expect(REMAPPING_FIELDS[1].condition).toBe("electron");
      expect(REMAPPING_FIELDS[2].condition).toBe("browser");
    });
  });

  describe("5.2 — React Native object-form remapping (@exodus/bytes-like)", () => {
    const pkg = manifest({
      browser: {
        "./fallback/platform.js": "./fallback/platform.browser.js",
        "./fallback/utf8.auto.js": "./fallback/utf8.auto.browser.js",
      },
      "react-native": {
        "./fallback/platform.js": "./fallback/platform.native.js",
        "./fallback/utf8.auto.js": "./fallback/utf8.auto.native.js",
      },
    } as any);

    test("react-native runtime → remaps to .native.js", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "node", runtime: "react-native" }),
      );
      const result = applyManifestRemappings("./fallback/platform.js", pkg, conds);

      expect(result.matchedField).toBe("react-native");
      expect(result.path).toBe("./fallback/platform.native.js");
    });

    test("browser runtime → remaps to .browser.js", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = applyManifestRemappings("./fallback/platform.js", pkg, conds);

      expect(result.matchedField).toBe("browser");
      expect(result.path).toBe("./fallback/platform.browser.js");
    });
  });

  describe("5.3 — Priority: react-native > browser when both conditions active", () => {
    const pkg = manifest({
      browser: { "./lib/impl.js": "./lib/impl.browser.js" },
      "react-native": { "./lib/impl.js": "./lib/impl.native.js" },
    } as any);

    test("react-native wins over browser", () => {
      // Simulate both conditions being active
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "browser", runtime: "react-native" }),
      );
      const result = applyManifestRemappings("./lib/impl.js", pkg, conds);

      expect(result.matchedField).toBe("react-native");
      expect(result.path).toBe("./lib/impl.native.js");
    });
  });

  describe("5.4 — Electron renderer remapping", () => {
    const pkg = manifest({
      browser: { "./lib/crypto.js": "./lib/crypto.browser.js" },
      electron: { "./lib/crypto.js": "./lib/crypto.electron.js" },
    } as any);

    test("electron-renderer: electron field wins over browser", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "browser", runtime: "electron-renderer" }),
      );
      const result = applyManifestRemappings("./lib/crypto.js", pkg, conds);

      expect(result.matchedField).toBe("electron");
      expect(result.path).toBe("./lib/crypto.electron.js");
    });

    test("electron-main: electron field applies", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "node", runtime: "electron-main" }),
      );
      const result = applyManifestRemappings("./lib/crypto.js", pkg, conds);

      expect(result.matchedField).toBe("electron");
      expect(result.path).toBe("./lib/crypto.electron.js");
    });

    test("default browser build: browser field applies", () => {
      const conds = getResolverConditions(importArgs(), resolveOpts({ platform: "browser" }));
      const result = applyManifestRemappings("./lib/crypto.js", pkg, conds);

      expect(result.matchedField).toBe("browser");
      expect(result.path).toBe("./lib/crypto.browser.js");
    });
  });

  describe("5.5 — No remapping field matches (pass-through)", () => {
    const pkg = manifest({
      browser: { "./fallback/platform.js": "./fallback/platform.browser.js" },
      "react-native": { "./fallback/platform.js": "./fallback/platform.native.js" },
    } as any);

    test("deno runtime: no condition matches → pass-through", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "node", runtime: "deno" }),
      );
      const result = applyManifestRemappings("./fallback/platform.js", pkg, conds);

      expect(result.matchedField).toBeNull();
      expect(result.path).toBe("./fallback/platform.js");
    });
  });

  describe("5.6 — false exclusion for non-browser field", () => {
    const pkg = manifest({
      "react-native": {
        "./lib/dom-impl.js": false,
        "./lib/platform.js": "./lib/platform.native.js",
      },
    } as any);

    test("react-native build: false excludes the module", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "node", runtime: "react-native" }),
      );
      const result = applyManifestRemappings("./lib/dom-impl.js", pkg, conds);

      expect(result.excluded).toBe(true);
      expect(result.matchedField).toBe("react-native");
    });

    test("react-native build: normal remapping still works", () => {
      const conds = getResolverConditions(
        importArgs(),
        resolveOpts({ platform: "node", runtime: "react-native" }),
      );
      const result = applyManifestRemappings("./lib/platform.js", pkg, conds);

      expect(result.excluded).toBe(false);
      expect(result.matchedField).toBe("react-native");
      expect(result.path).toBe("./lib/platform.native.js");
    });
  });

  describe("5.7 — getRuntimeDefaults covers all runtimes", () => {
    test("react-native: browserField false", () => {
      const d = getRuntimeDefaults("react-native");
      expect(d.conditions).toContain("react-native");
      expect(d.browserField).toBe(false);
    });

    test("electron-main: adds electron + node", () => {
      const d = getRuntimeDefaults("electron-main");
      expect(d.conditions).toContain("electron");
      expect(d.conditions).toContain("node");
      expect(d.browserField).toBe(false);
    });

    test("electron-renderer: adds electron + browser, browserField true", () => {
      const d = getRuntimeDefaults("electron-renderer");
      expect(d.conditions).toContain("electron");
      expect(d.conditions).toContain("browser");
      expect(d.browserField).toBe(true);
    });

    test("undefined runtime: empty conditions, null browserField", () => {
      const d = getRuntimeDefaults(undefined);
      expect(d.conditions).toHaveLength(0);
      expect(d.browserField).toBeNull();
    });
  });
});
