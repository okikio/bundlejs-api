/**
 * Scenario 13 — Utility Module Correctness
 *
 * Tests correctness of utility modules used by the CDN resolution system.
 * Focuses on edge cases that are easy to get wrong:
 *
 * - npm-spec.ts: Pre-release version classification
 * - parse-package-name.ts: Scoped packages, edge cases
 * - validate-package-name.ts: Validation against npm rules
 * - resolve-conditions.ts: Condition computation ordering
 * - resolve-import-map.ts: WHATWG spec compliance
 *
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseNpmSpec, isGitHubShorthand } from "@bundle/utils/npm-spec";
import { parsePackageName, buildPackageSpec, normalizeSubpath, getScope, getUnscopedName } from "@bundle/utils/parse-package-name";
import { validatePackageName, isValidPackageName, isNodeBuiltin } from "@bundle/utils/validate-package-name";
import { getResolverConditions, getRuntimeDefaults, isRequireContext, getLegacyMainFields, mergeConditions } from "@bundle/utils/resolve-conditions";
import { resolveImportMap, createImportMap, mergeImportMaps, validateImportMap } from "@bundle/utils/resolve-import-map";

// =============================================================================
// npm-spec.ts — Spec Classification
// =============================================================================

describe("npm-spec: parseNpmSpec", () => {
  describe("semver ranges", () => {
    test("caret range", () => {
      const spec = parseNpmSpec("^1.2.3");
      expect(spec.kind).toBe("semver");
      expect(spec.raw).toBe("^1.2.3");
    });

    test("tilde range", () => {
      const spec = parseNpmSpec("~1.2.3");
      expect(spec.kind).toBe("semver");
    });

    test("range with comparison operators", () => {
      const spec = parseNpmSpec(">=1.0.0 <2.0.0");
      expect(spec.kind).toBe("semver");
    });

    test("wildcard ranges", () => {
      expect(parseNpmSpec("*").kind).toBe("semver");
      expect(parseNpmSpec("1.x").kind).toBe("semver");
      expect(parseNpmSpec("1.2.x").kind).toBe("semver");
    });

    test("empty string is unknown (not valid in package.json)", () => {
      // parseNpmSpec treats empty string as invalid input (unlike parseRegistrySpec
      // which would treat it as a wildcard). This is correct behavior since
      // empty dependency strings in package.json are errors.
      const spec = parseNpmSpec("");
      expect(spec.kind).toBe("unknown");
    });
  });

  describe("exact versions (including pre-release)", () => {
    test("simple exact version", () => {
      const spec = parseNpmSpec("1.2.3");
      expect(spec.kind).toBe("version");
    });

    test("pre-release version: 1.0.0-rc.1", () => {
      // BUG FIX: was classified as "tag" before the looksLikeSemver fix
      const spec = parseNpmSpec("1.0.0-rc.1");
      expect(spec.kind).toBe("version");
    });

    test("pre-release version: 1.0.0-alpha.0", () => {
      const spec = parseNpmSpec("1.0.0-alpha.0");
      expect(spec.kind).toBe("version");
    });

    test("pre-release version: 2.0.0-beta.3", () => {
      const spec = parseNpmSpec("2.0.0-beta.3");
      expect(spec.kind).toBe("version");
    });

    test("version with build metadata: 1.0.0+build.123", () => {
      const spec = parseNpmSpec("1.0.0+build.123");
      expect(spec.kind).toBe("version");
    });

    test("pre-release + build: 1.0.0-rc.1+build.456", () => {
      const spec = parseNpmSpec("1.0.0-rc.1+build.456");
      expect(spec.kind).toBe("version");
    });
  });

  describe("semver ranges with pre-release identifiers", () => {
    test("caret range with pre-release: ^1.0.0-beta.1", () => {
      // BUG FIX: was classified as "unknown" before the looksLikeSemver fix
      const spec = parseNpmSpec("^1.0.0-beta.1");
      expect(spec.kind).toBe("semver");
    });

    test("tilde range with pre-release: ~1.0.0-alpha.2", () => {
      const spec = parseNpmSpec("~1.0.0-alpha.2");
      expect(spec.kind).toBe("semver");
    });

    test("comparison with pre-release: >=1.0.0-beta.1", () => {
      const spec = parseNpmSpec(">=1.0.0-beta.1");
      expect(spec.kind).toBe("semver");
    });
  });

  describe("dist-tags", () => {
    test("latest", () => {
      const spec = parseNpmSpec("latest");
      expect(spec.kind).toBe("tag");
    });

    test("next", () => {
      const spec = parseNpmSpec("next");
      expect(spec.kind).toBe("tag");
    });

    test("beta tag (not version)", () => {
      // Just the word "beta" is a dist-tag, not a semver range
      const spec = parseNpmSpec("beta");
      expect(spec.kind).toBe("tag");
    });

    test("canary", () => {
      const spec = parseNpmSpec("canary");
      expect(spec.kind).toBe("tag");
    });
  });

  describe("git specs", () => {
    test("GitHub shorthand: user/repo", () => {
      const spec = parseNpmSpec("facebook/react");
      expect(spec.kind).toBe("git");
    });

    test("GitHub shorthand with committish: user/repo#branch", () => {
      const spec = parseNpmSpec("facebook/react#main");
      expect(spec.kind).toBe("git");
    });

    test("git+https URL", () => {
      const spec = parseNpmSpec("git+https://github.com/user/repo.git");
      expect(spec.kind).toBe("git");
    });

    test("github: prefix", () => {
      const spec = parseNpmSpec("github:user/repo");
      expect(spec.kind).toBe("git");
    });
  });

  describe("URL specs", () => {
    test("HTTPS URL", () => {
      const spec = parseNpmSpec("https://example.com/package.tgz");
      expect(spec.kind).toBe("url");
    });
  });

  describe("alias specs", () => {
    test("npm: alias", () => {
      const spec = parseNpmSpec("npm:other-package@^1.0.0");
      expect(spec.kind).toBe("alias");
    });
  });

  describe("workspace/link specs", () => {
    test("workspace:", () => {
      const spec = parseNpmSpec("workspace:*");
      expect(spec.kind).toBe("workspace");
    });

    test("link:", () => {
      const spec = parseNpmSpec("link:../other-package");
      expect(spec.kind).toBe("link");
    });
  });

  describe("file/directory specs", () => {
    test("file: protocol", () => {
      const spec = parseNpmSpec("file:./package.tgz");
      expect(spec.kind).toBe("file");
    });

    test("relative directory", () => {
      const spec = parseNpmSpec("./local-package");
      expect(spec.kind).toBe("directory");
    });
  });
});

describe("npm-spec: isGitHubShorthand", () => {
  test("basic user/repo → true", () => {
    expect(isGitHubShorthand("facebook/react")).toBe(true);
  });

  test("user/repo#branch → true", () => {
    expect(isGitHubShorthand("user/repo#main")).toBe(true);
  });

  test("scoped package @scope/name → false", () => {
    expect(isGitHubShorthand("@types/node")).toBe(false);
  });

  test("relative path ./foo → false", () => {
    expect(isGitHubShorthand("./foo")).toBe(false);
  });

  test("SCP URL git@github.com:user/repo → false", () => {
    expect(isGitHubShorthand("git@github.com:user/repo")).toBe(false);
  });

  test("multi-level path a/b/c → false", () => {
    expect(isGitHubShorthand("a/b/c")).toBe(false);
  });

  test("trailing slash user/repo/ → false", () => {
    expect(isGitHubShorthand("user/repo/")).toBe(false);
  });
});

// =============================================================================
// parse-package-name.ts
// =============================================================================

describe("parse-package-name: parsePackageName", () => {
  test("simple package", () => {
    const p = parsePackageName("react");
    expect(p.name).toBe("react");
    expect(p.version).toBe("latest");
    expect(p.path).toBe("");
    expect(p.isScoped).toBe(false);
  });

  test("package with version", () => {
    const p = parsePackageName("react@18.2.0");
    expect(p.name).toBe("react");
    expect(p.version).toBe("18.2.0");
  });

  test("package with semver range", () => {
    const p = parsePackageName("react@^18.0.0");
    expect(p.name).toBe("react");
    expect(p.version).toBe("^18.0.0");
  });

  test("scoped package", () => {
    const p = parsePackageName("@tanstack/react-query@5.0.0");
    expect(p.name).toBe("@tanstack/react-query");
    expect(p.version).toBe("5.0.0");
    expect(p.scope).toBe("@tanstack");
    expect(p.isScoped).toBe(true);
  });

  test("scoped package escaped name", () => {
    const p = parsePackageName("@types/node@^20");
    expect(p.escapedName).toBe("@types%2fnode");
  });

  test("package with subpath", () => {
    const p = parsePackageName("lodash@^4.17.0/get");
    expect(p.name).toBe("lodash");
    expect(p.version).toBe("^4.17.0");
    expect(p.path).toBe("/get");
  });

  test("scoped package with subpath", () => {
    const p = parsePackageName("@emotion/react@11/jsx-runtime");
    expect(p.name).toBe("@emotion/react");
    expect(p.version).toBe("11");
    expect(p.path).toBe("/jsx-runtime");
  });

  test("no version defaults to 'latest'", () => {
    const p = parsePackageName("react");
    expect(p.version).toBe("latest");
  });

  test("no version with defaultVersion=null", () => {
    const p = parsePackageName("react", { defaultVersion: null });
    expect(p.version).toBe(null);
  });

  test("invalid input with ignoreError", () => {
    const p = parsePackageName("", { ignoreError: true });
    expect(p.name).toBe("");
  });
});

describe("parse-package-name: utilities", () => {
  test("buildPackageSpec basic", () => {
    expect(buildPackageSpec("react", "18.2.0")).toBe("react@18.2.0");
  });

  test("buildPackageSpec with path", () => {
    expect(buildPackageSpec("@types/node", "^20", "/fs"))
      .toBe("@types/node@^20/fs");
  });

  test("buildPackageSpec no version", () => {
    expect(buildPackageSpec("react")).toBe("react");
  });

  test("normalizeSubpath adds leading slash", () => {
    expect(normalizeSubpath("dist/index.js")).toBe("/dist/index.js");
  });

  test("normalizeSubpath removes trailing slash", () => {
    expect(normalizeSubpath("/dist/")).toBe("/dist");
  });

  test("normalizeSubpath keeps root /", () => {
    expect(normalizeSubpath("/")).toBe("/");
  });

  test("getScope returns scope", () => {
    expect(getScope("@types/node")).toBe("@types");
  });

  test("getScope returns null for unscoped", () => {
    expect(getScope("react")).toBe(null);
  });

  test("getUnscopedName strips scope", () => {
    expect(getUnscopedName("@types/node")).toBe("node");
  });

  test("getUnscopedName passthrough for unscoped", () => {
    expect(getUnscopedName("react")).toBe("react");
  });
});

// =============================================================================
// validate-package-name.ts
// =============================================================================

describe("validate-package-name: validatePackageName", () => {
  test("valid simple name", () => {
    const r = validatePackageName("lodash");
    expect(r.valid).toBe(true);
    expect(r.errors.length).toBe(0);
  });

  test("valid scoped name", () => {
    const r = validatePackageName("@scope/package");
    expect(r.valid).toBe(true);
  });

  test("valid name with hyphens and dots", () => {
    expect(validatePackageName("my-package.js").valid).toBe(true);
  });

  test("invalid: empty string", () => {
    const r = validatePackageName("");
    expect(r.valid).toBe(false);
  });

  test("invalid: starts with dot", () => {
    const r = validatePackageName(".hidden");
    expect(r.valid).toBe(false);
  });

  test("invalid: starts with underscore", () => {
    const r = validatePackageName("_internal");
    expect(r.valid).toBe(false);
  });

  test("invalid: uppercase letters", () => {
    const r = validatePackageName("MyPackage");
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("name must be lowercase");
  });

  test("invalid: special characters", () => {
    const r = validatePackageName("my~package");
    expect(r.valid).toBe(false);
  });

  test("invalid: too long (>214 chars)", () => {
    const r = validatePackageName("a".repeat(215));
    expect(r.valid).toBe(false);
  });

  test("invalid: node builtin name", () => {
    const r = validatePackageName("fs");
    expect(r.valid).toBe(false);
  });

  test("invalid: reserved name", () => {
    const r = validatePackageName("node_modules");
    expect(r.valid).toBe(false);
  });

  test("invalid: empty scope", () => {
    const r = validatePackageName("@/package");
    expect(r.valid).toBe(false);
  });

  test("invalid: scoped without slash", () => {
    const r = validatePackageName("@scope");
    expect(r.valid).toBe(false);
  });

  test("warnings: node- prefix", () => {
    const r = validatePackageName("node-helper");
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test("warnings: -js suffix", () => {
    const r = validatePackageName("my-tool-js");
    expect(r.valid).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("validate-package-name: isNodeBuiltin", () => {
  test("fs is builtin", () => {
    expect(isNodeBuiltin("fs")).toBe(true);
  });

  test("node:fs with prefix", () => {
    expect(isNodeBuiltin("node:fs")).toBe(true);
  });

  test("fs/promises subpath", () => {
    expect(isNodeBuiltin("fs/promises")).toBe(true);
  });

  test("lodash is not builtin", () => {
    expect(isNodeBuiltin("lodash")).toBe(false);
  });
});

// =============================================================================
// resolve-conditions.ts
// =============================================================================

describe("resolve-conditions: getResolverConditions", () => {
  test("browser import-statement", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "browser" }
    );
    expect(c.conditions).toContain("import");
    expect(c.conditions).toContain("browser");
    expect(c.conditions).toContain("module");
    expect(c.conditions).toContain("default");
    expect(c.browser).toBe(true);
    expect(c.require).toBe(false);
  });

  test("node require-call", () => {
    const c = getResolverConditions(
      { kind: "require-call" },
      { platform: "node" }
    );
    expect(c.conditions).toContain("require");
    expect(c.conditions).toContain("node");
    expect(c.require).toBe(true);
  });

  test("neutral platform has no auto 'module'", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "neutral" }
    );
    expect(c.conditions).not.toContain("module");
    expect(c.conditions).toContain("import");
    expect(c.conditions).toContain("default");
  });

  test("default is always last", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "browser" }
    );
    const lastCondition = c.conditions[c.conditions.length - 1];
    expect(lastCondition).toBe("default");
  });

  test("deno runtime adds deno and node conditions", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "node", runtime: "deno" }
    );
    expect(c.conditions).toContain("deno");
    expect(c.conditions).toContain("node");
    expect(c.browser).toBe(false);
  });

  test("react-native runtime disables browser field", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "neutral", runtime: "react-native" }
    );
    expect(c.conditions).toContain("react-native");
    expect(c.browser).toBe(false);
  });

  test("electron-renderer uses browser field", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "browser", runtime: "electron-renderer" }
    );
    expect(c.conditions).toContain("electron");
    expect(c.conditions).toContain("browser");
    expect(c.browser).toBe(true);
  });

  test("user conditions are appended", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "browser", conditions: ["production"] }
    );
    expect(c.conditions).toContain("production");
    // When user provides explicit conditions, "module" is NOT auto-added
    expect(c.conditions).not.toContain("module");
  });

  test("no duplicate conditions", () => {
    const c = getResolverConditions(
      { kind: "import-statement" },
      { platform: "node", runtime: "deno", conditions: ["node", "deno"] }
    );
    const nodeCount = c.conditions.filter(c => c === "node").length;
    const denoCount = c.conditions.filter(c => c === "deno").length;
    expect(nodeCount).toBe(1);
    expect(denoCount).toBe(1);
  });

  test("entry-point with cjs format → require context", () => {
    expect(
      isRequireContext({ kind: "entry-point" }, { format: "cjs" })
    ).toBe(true);
  });

  test("entry-point with esm format → import context", () => {
    expect(
      isRequireContext({ kind: "entry-point" }, { format: "esm" })
    ).toBe(false);
  });
});

describe("resolve-conditions: getRuntimeDefaults", () => {
  test("workerd has worker + browser conditions", () => {
    const d = getRuntimeDefaults("workerd");
    expect(d.conditions).toContain("workerd");
    expect(d.conditions).toContain("worker");
    expect(d.conditions).toContain("browser");
    expect(d.browserField).toBe(false);
  });

  test("bun has bun + node conditions", () => {
    const d = getRuntimeDefaults("bun");
    expect(d.conditions).toContain("bun");
    expect(d.conditions).toContain("node");
    expect(d.browserField).toBe(false);
  });

  test("undefined runtime returns empty defaults", () => {
    const d = getRuntimeDefaults(undefined);
    expect(d.conditions).toEqual([]);
    expect(d.browserField).toBe(null);
  });
});

describe("resolve-conditions: getLegacyMainFields", () => {
  test("browser platform: browser, module, main", () => {
    const fields = getLegacyMainFields(
      {},
      { kind: "import-statement" },
      { platform: "browser" }
    );
    expect(fields).toEqual(["browser", "module", "main"]);
  });

  test("node platform: module, main", () => {
    const fields = getLegacyMainFields(
      {},
      { kind: "import-statement" },
      { platform: "node" }
    );
    expect(fields).toEqual(["module", "main"]);
  });

  test("require context in non-module package moves main to front", () => {
    const fields = getLegacyMainFields(
      { type: undefined },
      { kind: "require-call" },
      { platform: "node" }
    );
    expect(fields[0]).toBe("main");
  });

  test("user mainFields override defaults", () => {
    const fields = getLegacyMainFields(
      {},
      { kind: "import-statement" },
      { platform: "browser", mainFields: ["jsnext:main", "main"] }
    );
    expect(fields).toEqual(["jsnext:main", "main"]);
  });
});

describe("resolve-conditions: mergeConditions", () => {
  test("deduplicates entries", () => {
    const merged = mergeConditions(["import", "browser"], ["browser", "node"]);
    expect(merged).toEqual(["import", "browser", "node"]);
  });

  test("preserves order of base", () => {
    const merged = mergeConditions(["a", "b"], ["c"]);
    expect(merged[0]).toBe("a");
    expect(merged[1]).toBe("b");
    expect(merged[2]).toBe("c");
  });
});

// =============================================================================
// resolve-import-map.ts
// =============================================================================

describe("resolve-import-map: resolveImportMap", () => {
  test("exact match", () => {
    const map = createImportMap({
      imports: { "react": "https://esm.sh/react@18" }
    });
    expect(resolveImportMap(map, "react")).toBe("https://esm.sh/react@18");
  });

  test("prefix match with trailing slash", () => {
    const map = createImportMap({
      imports: { "lodash/": "https://esm.sh/lodash-es/" }
    });
    expect(resolveImportMap(map, "lodash/get"))
      .toBe("https://esm.sh/lodash-es/get");
  });

  test("no match returns null", () => {
    const map = createImportMap({
      imports: { "react": "https://esm.sh/react@18" }
    });
    expect(resolveImportMap(map, "vue")).toBe(null);
  });

  test("scoped resolution: longest scope match wins", () => {
    const map: ReturnType<typeof createImportMap> = {
      imports: { "react": "https://esm.sh/react@18" },
      scopes: {
        "/vendor/legacy/": { "react": "https://esm.sh/react@16" },
        "/vendor/": { "react": "https://esm.sh/react@17" },
      }
    };
    // /vendor/legacy/ is longer than /vendor/, so it wins
    expect(resolveImportMap(map, "react", "/vendor/legacy/old.js"))
      .toBe("https://esm.sh/react@16");
  });

  test("scoped resolution: falls through to top-level", () => {
    const map: ReturnType<typeof createImportMap> = {
      imports: { "react": "https://esm.sh/react@18" },
      scopes: {
        "/vendor/": { "vue": "https://esm.sh/vue@3" },
      }
    };
    // "react" isn't in the /vendor/ scope, so falls through to top-level
    expect(resolveImportMap(map, "react", "/vendor/app.js"))
      .toBe("https://esm.sh/react@18");
  });

  test("prefix key longest match: longer key wins", () => {
    const map = createImportMap({
      imports: {
        "lodash/": "https://cdn.a/lodash/",
        "lodash/fp/": "https://cdn.b/lodash-fp/",
      }
    });
    // "lodash/fp/add" should match "lodash/fp/" (longer) not "lodash/"
    expect(resolveImportMap(map, "lodash/fp/add"))
      .toBe("https://cdn.b/lodash-fp/add");
  });
});

describe("resolve-import-map: createImportMap", () => {
  test("creates normalized map", () => {
    const map = createImportMap({ imports: { "x": "y" } });
    expect(map.imports).toBeDefined();
    expect(map.imports?.["x"]).toBe("y");
  });
});

describe("resolve-import-map: mergeImportMaps", () => {
  test("later map overrides earlier", () => {
    const a = createImportMap({ imports: { "react": "url-a" } });
    const b = createImportMap({ imports: { "react": "url-b" } });
    const merged = mergeImportMaps(a, b);
    expect(merged.imports?.["react"]).toBe("url-b");
  });

  test("scopes from both maps are merged", () => {
    const a: ReturnType<typeof createImportMap> = {
      imports: {},
      scopes: { "/a/": { "x": "1" } }
    };
    const b: ReturnType<typeof createImportMap> = {
      imports: {},
      scopes: { "/b/": { "y": "2" } }
    };
    const merged = mergeImportMaps(a, b);
    expect(merged.scopes?.["/a/"]).toBeDefined();
    expect(merged.scopes?.["/b/"]).toBeDefined();
  });
});

describe("resolve-import-map: validateImportMap", () => {
  test("valid map passes", () => {
    const result = validateImportMap(createImportMap({
      imports: { "react": "https://esm.sh/react@18" }
    }));
    expect(result.valid).toBe(true);
  });

  test("empty key is an error", () => {
    const result = validateImportMap(createImportMap({
      imports: { "": "https://example.com" }
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
