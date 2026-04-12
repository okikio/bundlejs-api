/**
 * Scenario 14 — CDN Format, Loader, Filesystem & Plugin Utility Correctness
 *
 * Tests correctness of utility modules that back the plugin pipeline:
 *
 * - cdn-format.ts: CDN style detection, origin resolution, URL generation, JSR specifier parsing
 * - loader.ts: Extension-to-esbuild-loader mapping
 * - side-effects.ts: Package-relative path normalization, JS detection, sideEffects computation
 * - cdn-resolution.ts: Path normalization, subpath joining, browser/manifest remapping
 * - filesystem.ts: Virtual FS round-trip, isValid, getResolvedPath, fileExists vs hasFile
 * - plugins/fs.ts: resolveVfsPath, stripAnyPrefix
 * - plugins/alias.ts: isAlias detection
 * - plugins/external.ts: isExternal detection
 * - plugins/tar.ts: parseTarballUrl, stripPackagePrefix
 * - utils/url.ts: encodeWhitespace, urlJoin, toURLPath
 * - utils/path.ts: isBareImport
 *
 * @see docs/scenarios/13-utility-correctness.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

// =============================================================================
// Imports: cdn-format.ts
// =============================================================================
import {
  getCDNStyle,
  isCDNStyle,
  getCDNOrigin,
  getPureImportPath,
  getCDNUrl,
  parseJSRSpecifier,
  getJSRDirectUrl,
  getJSRProxyUrl,
  isJSRSpecifier,
  isNpmCDN,
  isGitHubRaw,
} from "../utils/cdn-format.ts";

// =============================================================================
// Imports: loader.ts
// =============================================================================
import { inferLoader, RESOLVE_EXTENSIONS } from "../utils/loader.ts";

// =============================================================================
// Imports: side-effects.ts
// =============================================================================
import {
  normalizePkgRelPath,
  isJsLikePath,
  normalizeSideEffectsPattern,
  compileSideEffectsMatchers,
  computeEsbuildSideEffects,
} from "../utils/side-effects.ts";

// =============================================================================
// Imports: cdn-resolution.ts
// =============================================================================
import {
  normalizeResolvedPath,
  joinSubpaths,
  applyPathRemapping,
  applyManifestRemappings,
  resolvePackageEntry,
  computePeerDependencies,
  REMAPPING_FIELDS,
} from "../utils/cdn-resolution.ts";

import type { ResolverConditions, PathRemappings } from "../utils/cdn-resolution.ts";

// =============================================================================
// Imports: filesystem.ts
// =============================================================================
import {
  isValid,
  getResolvedPath,
  getFile,
  hasFile,
  fileExists,
  setFile,
  deleteFile,
  createDefaultFileSystem,
} from "../utils/filesystem.ts";

// =============================================================================
// Imports: plugins
// =============================================================================
import { resolveVfsPath, stripAnyPrefix } from "../plugins/fs.ts";
import { isAlias } from "../plugins/alias.ts";
import { isExternal } from "../plugins/external.ts";
import { parseTarballUrl, stripPackagePrefix } from "../plugins/tar.ts";

// =============================================================================
// Imports: utils/
// =============================================================================
import { encodeWhitespace, urlJoin, toURLPath } from "@bundle/utils/url";
import { isBareImport } from "@bundle/utils/path";
import type { PackageJson } from "@bundle/utils/types";

// #############################################################################
// cdn-format.ts
// #############################################################################

describe("cdn-format: getCDNStyle", () => {
  describe("npm-style CDNs", () => {
    test("esm: scheme", () => {
      expect(getCDNStyle("esm:react")).toBe("npm");
    });

    test("esm.sh: scheme", () => {
      expect(getCDNStyle("esm.sh:react")).toBe("npm");
    });

    test("unpkg: scheme", () => {
      expect(getCDNStyle("unpkg:lodash")).toBe("npm");
    });

    test("skypack: scheme", () => {
      expect(getCDNStyle("skypack:react")).toBe("npm");
    });

    test("jsdelivr: scheme", () => {
      expect(getCDNStyle("jsdelivr:axios")).toBe("npm");
    });

    test("esm.run: scheme (jsdelivr alias)", () => {
      expect(getCDNStyle("esm.run:vue")).toBe("npm");
    });

    test("https://esm.sh URL", () => {
      expect(getCDNStyle("https://esm.sh/react@18")).toBe("npm");
    });

    test("https://unpkg.com URL", () => {
      expect(getCDNStyle("https://unpkg.com/lodash@4")).toBe("npm");
    });

    test("https://cdn.jsdelivr.net/npm URL", () => {
      expect(getCDNStyle("https://cdn.jsdelivr.net/npm/vue@3")).toBe("npm");
    });

    test("https://cdn.skypack.dev URL", () => {
      expect(getCDNStyle("https://cdn.skypack.dev/preact")).toBe("npm");
    });
  });

  describe("JSR", () => {
    test("jsr: scheme", () => {
      expect(getCDNStyle("jsr:@std/path")).toBe("jsr");
    });

    test("https://jsr.io URL", () => {
      expect(getCDNStyle("https://jsr.io/@std/path/1.0.0/mod.ts")).toBe("jsr");
    });
  });

  describe("GitHub", () => {
    test("github: scheme", () => {
      expect(getCDNStyle("github:user/repo/file.js")).toBe("github");
    });

    test("jsdelivr.gh: scheme", () => {
      expect(getCDNStyle("jsdelivr.gh:user/repo/file.js")).toBe("github");
    });

    test("https://raw.githubusercontent.com URL", () => {
      expect(getCDNStyle("https://raw.githubusercontent.com/user/repo/main/file.js")).toBe("github");
    });

    test("https://cdn.jsdelivr.net/gh URL", () => {
      expect(getCDNStyle("https://cdn.jsdelivr.net/gh/user/repo/file.js")).toBe("github");
    });

    test("https://github.com (non-raw) is NOT github style", () => {
      // The 'github' style specifically means raw file access, not the GitHub website
      expect(getCDNStyle("https://github.com/user/repo")).toBe("other");
    });
  });

  describe("Deno", () => {
    test("deno: scheme", () => {
      expect(getCDNStyle("deno:oak")).toBe("deno");
    });

    test("https://deno.land/x URL", () => {
      expect(getCDNStyle("https://deno.land/x/oak/mod.ts")).toBe("deno");
    });
  });

  describe("tarball", () => {
    test("https://pkg.pr.new URL", () => {
      expect(getCDNStyle("https://pkg.pr.new/user/repo@commit")).toBe("tarball");
    });
  });

  describe("other / edge cases", () => {
    test("bare package name", () => {
      expect(getCDNStyle("react")).toBe("other");
    });

    test("empty string", () => {
      expect(getCDNStyle("")).toBe("other");
    });

    test("unknown URL", () => {
      expect(getCDNStyle("https://example.com/package.js")).toBe("other");
    });
  });
});

describe("cdn-format: isCDNStyle", () => {
  test("esm:react is npm style", () => {
    expect(isCDNStyle("esm:react", "npm")).toBe(true);
  });

  test("jsr:@std/path is NOT npm style", () => {
    expect(isCDNStyle("jsr:@std/path", "npm")).toBe(false);
  });

  test("jsr:@std/path is jsr style", () => {
    expect(isCDNStyle("jsr:@std/path", "jsr")).toBe(true);
  });
});

describe("cdn-format: getCDNOrigin", () => {
  test("esm: scheme → esm.sh origin", () => {
    expect(getCDNOrigin("esm:react")).toBe("https://esm.sh/");
  });

  test("esm.sh: scheme → esm.sh origin", () => {
    expect(getCDNOrigin("esm.sh:react")).toBe("https://esm.sh/");
  });

  test("jsr: scheme → jsr.io origin", () => {
    expect(getCDNOrigin("jsr:@std/path")).toBe("https://jsr.io/");
  });

  test("unpkg: scheme → unpkg origin", () => {
    expect(getCDNOrigin("unpkg:lodash")).toBe("https://unpkg.com/");
  });

  test("jsdelivr: scheme → jsdelivr npm origin", () => {
    expect(getCDNOrigin("jsdelivr:axios")).toBe("https://cdn.jsdelivr.net/npm/");
  });

  test("esm.run: scheme → same as jsdelivr", () => {
    expect(getCDNOrigin("esm.run:vue")).toBe("https://cdn.jsdelivr.net/npm/");
  });

  test("github: scheme → raw.githubusercontent.com", () => {
    expect(getCDNOrigin("github:user/repo")).toBe("https://raw.githubusercontent.com/");
  });

  test("jsdelivr.gh: scheme → jsdelivr gh", () => {
    expect(getCDNOrigin("jsdelivr.gh:user/repo")).toBe("https://cdn.jsdelivr.net/gh/");
  });

  test("deno: scheme → deno.land/x", () => {
    expect(getCDNOrigin("deno:oak")).toBe("https://deno.land/x/");
  });

  test("bare package uses default CDN", () => {
    expect(getCDNOrigin("react")).toBe("https://unpkg.com/");
  });

  test("bare package with custom CDN", () => {
    expect(getCDNOrigin("react", "https://cdn.esm.sh")).toBe("https://cdn.esm.sh/");
  });

  test("custom CDN already has trailing slash → no double slash", () => {
    expect(getCDNOrigin("react", "https://cdn.esm.sh/")).toBe("https://cdn.esm.sh/");
  });
});

describe("cdn-format: getPureImportPath", () => {
  test("strips esm: scheme", () => {
    expect(getPureImportPath("esm:react@18")).toBe("react@18");
  });

  test("strips jsr: scheme", () => {
    expect(getPureImportPath("jsr:@std/path@1.0.0")).toBe("@std/path@1.0.0");
  });

  test("strips unpkg: scheme", () => {
    expect(getPureImportPath("unpkg:lodash@4.17.0/get")).toBe("lodash@4.17.0/get");
  });

  test("strips esm.sh host from URL", () => {
    expect(getPureImportPath("https://esm.sh/react@18")).toBe("react@18");
  });

  test("strips jsr.io host from URL", () => {
    expect(getPureImportPath("https://jsr.io/@std/path/1.0.0/mod.ts")).toBe("@std/path/1.0.0/mod.ts");
  });

  test("strips unpkg.com host from URL", () => {
    expect(getPureImportPath("https://unpkg.com/lodash@4/lodash.min.js")).toBe("lodash@4/lodash.min.js");
  });

  test("bare package name is unchanged", () => {
    expect(getPureImportPath("react")).toBe("react");
  });

  test("strips cdn.jsdelivr.net/npm host from URL", () => {
    expect(getPureImportPath("https://cdn.jsdelivr.net/npm/vue@3")).toBe("vue@3");
  });
});

describe("cdn-format: getCDNUrl", () => {
  test("bare package uses default CDN", () => {
    const result = getCDNUrl("react@18");
    expect(result.import).toBe("react@18");
    expect(result.path).toBe("react@18");
    expect(result.origin).toBe("https://unpkg.com/");
    expect(result.url.href).toBe("https://unpkg.com/react@18");
  });

  test("esm: scheme routes to esm.sh", () => {
    const result = getCDNUrl("esm:react@18");
    expect(result.path).toBe("react@18");
    expect(result.origin).toBe("https://esm.sh/");
    expect(result.url.href).toBe("https://esm.sh/react@18");
  });

  test("jsr: scheme routes to jsr.io", () => {
    const result = getCDNUrl("jsr:@std/path@1.0.0");
    expect(result.path).toBe("@std/path@1.0.0");
    expect(result.origin).toBe("https://jsr.io/");
    expect(result.url.href).toBe("https://jsr.io/@std/path@1.0.0");
  });

  test("scoped package with version and subpath", () => {
    const result = getCDNUrl("esm:@tanstack/react-query@5.0.0/build");
    expect(result.path).toBe("@tanstack/react-query@5.0.0/build");
    expect(result.url.href).toBe("https://esm.sh/@tanstack/react-query@5.0.0/build");
  });

  test("custom CDN as second argument", () => {
    const result = getCDNUrl("react@18", "https://cdn.esm.sh");
    expect(result.origin).toBe("https://cdn.esm.sh/");
  });
});

describe("cdn-format: parseJSRSpecifier", () => {
  test("basic JSR specifier", () => {
    const result = parseJSRSpecifier("jsr:@std/path@1.0.0");
    expect(result).not.toBe(null);
    expect(result!.scope).toBe("std");
    expect(result!.name).toBe("path");
    expect(result!.version).toBe("1.0.0");
    expect(result!.subpath).toBe("");
  });

  test("JSR specifier with subpath", () => {
    const result = parseJSRSpecifier("jsr:@std/path@1.0.0/posix");
    expect(result!.subpath).toBe("/posix");
  });

  test("JSR specifier without version", () => {
    const result = parseJSRSpecifier("jsr:@std/path");
    expect(result!.scope).toBe("std");
    expect(result!.name).toBe("path");
    expect(result!.version).toBe(null);
    expect(result!.subpath).toBe("");
  });

  test("non-JSR specifier → null", () => {
    expect(parseJSRSpecifier("npm:lodash")).toBe(null);
  });

  test("invalid (missing @scope/) → null", () => {
    expect(parseJSRSpecifier("jsr:invalid")).toBe(null);
  });

  test("uppercase in scope → null (spec requires lowercase)", () => {
    expect(parseJSRSpecifier("jsr:@UPPER/case")).toBe(null);
  });

  test("minimal valid specifier", () => {
    const result = parseJSRSpecifier("jsr:@a/b");
    expect(result).not.toBe(null);
    expect(result!.scope).toBe("a");
    expect(result!.name).toBe("b");
  });
});

describe("cdn-format: getJSRDirectUrl", () => {
  test("default path is /mod.ts", () => {
    expect(getJSRDirectUrl("std", "path", "1.0.0"))
      .toBe("https://jsr.io/@std/path/1.0.0/mod.ts");
  });

  test("custom subpath", () => {
    expect(getJSRDirectUrl("std", "path", "1.0.0", "/posix.ts"))
      .toBe("https://jsr.io/@std/path/1.0.0/posix.ts");
  });

  test("subpath without leading slash gets one added", () => {
    expect(getJSRDirectUrl("std", "path", "1.0.0", "posix.ts"))
      .toBe("https://jsr.io/@std/path/1.0.0/posix.ts");
  });
});

describe("cdn-format: getJSRProxyUrl", () => {
  test("with version", () => {
    expect(getJSRProxyUrl("std", "path", "1.0.0"))
      .toBe("https://esm.sh/jsr/@std/path@1.0.0");
  });

  test("with version and subpath", () => {
    expect(getJSRProxyUrl("std", "path", "1.0.0", "/posix"))
      .toBe("https://esm.sh/jsr/@std/path@1.0.0/posix");
  });

  test("without version", () => {
    expect(getJSRProxyUrl("std", "path"))
      .toBe("https://esm.sh/jsr/@std/path");
  });
});

describe("cdn-format: isJSRSpecifier / isNpmCDN / isGitHubRaw", () => {
  test("jsr: is JSR specifier", () => {
    expect(isJSRSpecifier("jsr:@std/path")).toBe(true);
  });

  test("npm: is NOT JSR specifier", () => {
    expect(isJSRSpecifier("npm:lodash")).toBe(false);
  });

  test("esm:react is npm CDN", () => {
    expect(isNpmCDN("esm:react")).toBe(true);
  });

  test("jsr:@std/path is NOT npm CDN", () => {
    expect(isNpmCDN("jsr:@std/path")).toBe(false);
  });

  test("github:user/repo is GitHub raw", () => {
    expect(isGitHubRaw("github:user/repo")).toBe(true);
  });

  test("https://github.com is NOT GitHub raw", () => {
    expect(isGitHubRaw("https://github.com/user/repo")).toBe(false);
  });
});

// #############################################################################
// loader.ts
// #############################################################################

describe("loader: inferLoader", () => {
  describe("standard extensions", () => {
    test(".ts → ts", () => {
      expect(inferLoader("file.ts")).toBe("ts");
    });

    test(".tsx → tsx", () => {
      expect(inferLoader("file.tsx")).toBe("tsx");
    });

    test(".css → css", () => {
      expect(inferLoader("file.css")).toBe("css");
    });

    test(".json → json", () => {
      expect(inferLoader("file.json")).toBe("json");
    });
  });

  describe("JS treated as TS (intentional)", () => {
    // bundlejs treats all JS as TS for maximum compatibility.
    // This enables parsing JSX in .js files and using TS syntax.
    test(".js → ts (not js)", () => {
      expect(inferLoader("file.js")).toBe("ts");
    });

    test(".jsx → tsx (not jsx)", () => {
      expect(inferLoader("file.jsx")).toBe("tsx");
    });
  });

  describe("module extensions", () => {
    test(".mjs → ts", () => {
      expect(inferLoader("file.mjs")).toBe("ts");
    });

    test(".cjs → ts", () => {
      expect(inferLoader("file.cjs")).toBe("ts");
    });

    test(".mts → ts", () => {
      expect(inferLoader("file.mts")).toBe("ts");
    });

    test(".cts → ts", () => {
      expect(inferLoader("file.cts")).toBe("ts");
    });
  });

  describe("special formats", () => {
    test(".scss → css", () => {
      expect(inferLoader("file.scss")).toBe("css");
    });

    test(".png → dataurl", () => {
      expect(inferLoader("file.png")).toBe("dataurl");
    });

    test(".jpeg → dataurl", () => {
      expect(inferLoader("file.jpeg")).toBe("dataurl");
    });

    test(".ttf → dataurl", () => {
      expect(inferLoader("file.ttf")).toBe("dataurl");
    });

    test(".svg → text", () => {
      expect(inferLoader("file.svg")).toBe("text");
    });

    test(".html → text", () => {
      expect(inferLoader("file.html")).toBe("text");
    });

    test(".txt → text", () => {
      expect(inferLoader("file.txt")).toBe("text");
    });

    test(".wasm → file", () => {
      expect(inferLoader("file.wasm")).toBe("file");
    });
  });

  describe("edge cases", () => {
    test("no extension → ts (fallback)", () => {
      // When no extension is present, bundlejs assumes TypeScript
      expect(inferLoader("file")).toBe("ts");
    });

    test("unknown extension → text", () => {
      // Any unknown extension with length > 0 falls through to "text"
      expect(inferLoader("file.xyz")).toBe("text");
    });

    test("URL with path", () => {
      expect(inferLoader("https://esm.sh/react@18/index.js")).toBe("ts");
    });
  });

  test("RESOLVE_EXTENSIONS has expected entries", () => {
    expect(RESOLVE_EXTENSIONS).toEqual([".tsx", ".ts", ".jsx", ".js", ".css", ".json"]);
  });
});

// #############################################################################
// side-effects.ts
// #############################################################################

describe("side-effects: normalizePkgRelPath", () => {
  test("strips leading ./", () => {
    expect(normalizePkgRelPath("./src/index.js")).toBe("src/index.js");
  });

  test("strips leading /", () => {
    expect(normalizePkgRelPath("/src/index.js")).toBe("src/index.js");
  });

  test("strips multiple leading slashes", () => {
    expect(normalizePkgRelPath("///src/index.js")).toBe("src/index.js");
  });

  test("strips query string", () => {
    expect(normalizePkgRelPath("src/index.js?module")).toBe("src/index.js");
  });

  test("strips hash fragment", () => {
    expect(normalizePkgRelPath("src/index.js#section")).toBe("src/index.js");
  });

  test("empty string stays empty", () => {
    expect(normalizePkgRelPath("")).toBe("");
  });

  test("already normalized stays unchanged", () => {
    expect(normalizePkgRelPath("src/index.js")).toBe("src/index.js");
  });
});

describe("side-effects: isJsLikePath", () => {
  describe("JS-like extensions → true", () => {
    test(".js", () => expect(isJsLikePath("file.js")).toBe(true));
    test(".mjs", () => expect(isJsLikePath("file.mjs")).toBe(true));
    test(".cjs", () => expect(isJsLikePath("file.cjs")).toBe(true));
    test(".ts", () => expect(isJsLikePath("file.ts")).toBe(true));
    test(".mts", () => expect(isJsLikePath("file.mts")).toBe(true));
    test(".cts", () => expect(isJsLikePath("file.cts")).toBe(true));
    test(".jsx", () => expect(isJsLikePath("file.jsx")).toBe(true));
    test(".tsx", () => expect(isJsLikePath("file.tsx")).toBe(true));
  });

  describe("non-JS extensions → false", () => {
    test(".css", () => expect(isJsLikePath("file.css")).toBe(false));
    test(".json", () => expect(isJsLikePath("file.json")).toBe(false));
    test(".scss", () => expect(isJsLikePath("file.scss")).toBe(false));
    test(".wasm", () => expect(isJsLikePath("file.wasm")).toBe(false));
  });

  test("no extension → true (treated as JS-like)", () => {
    // Extensionless paths could be directory entries resolved later
    expect(isJsLikePath("file")).toBe(true);
  });

  test("case-insensitive (.JS → true)", () => {
    expect(isJsLikePath("file.JS")).toBe(true);
  });

  test("strips leading ./ before checking", () => {
    expect(isJsLikePath("./src/index.ts")).toBe(true);
  });
});

describe("side-effects: normalizeSideEffectsPattern", () => {
  test("no slash → prepends **/", () => {
    expect(normalizeSideEffectsPattern("*.css")).toBe("**/*.css");
  });

  test("has slash → no ** added", () => {
    expect(normalizeSideEffectsPattern("src/*.js")).toBe("src/*.js");
  });

  test("strips leading ./", () => {
    expect(normalizeSideEffectsPattern("./src/*.js")).toBe("src/*.js");
  });

  test("trims whitespace", () => {
    expect(normalizeSideEffectsPattern("  *.css  ")).toBe("**/*.css");
  });

  test("explicit file path unchanged (has slash)", () => {
    expect(normalizeSideEffectsPattern("dist/index.js")).toBe("dist/index.js");
  });
});

describe("side-effects: compileSideEffectsMatchers", () => {
  test("compiles multiple patterns", () => {
    const result = compileSideEffectsMatchers(["*.css", "*.scss"]);
    expect(result.raw).toEqual(["*.css", "*.scss"]);
    expect(result.matchers.length).toBe(2);
  });

  test("empty array → empty matchers", () => {
    const result = compileSideEffectsMatchers([]);
    expect(result.matchers.length).toBe(0);
  });

  test("skips non-string entries", () => {
    // Package manifests can have unexpected shapes
    const result = compileSideEffectsMatchers([42 as unknown as string, "*.css"]);
    expect(result.matchers.length).toBe(1);
  });

  test("compiled regex matches expected paths", () => {
    const result = compileSideEffectsMatchers(["*.css"]);
    // "*.css" → "**/*.css" after normalization → should match nested paths
    expect(result.matchers[0].test("src/styles/main.css")).toBe(true);
    expect(result.matchers[0].test("index.css")).toBe(true);
    expect(result.matchers[0].test("index.js")).toBe(false);
  });
});

describe("side-effects: computeEsbuildSideEffects", () => {
  test("null manifest → undefined", () => {
    expect(computeEsbuildSideEffects(null, "index.js")).toBe(undefined);
  });

  test("sideEffects: true → undefined (default behavior)", () => {
    expect(computeEsbuildSideEffects({ sideEffects: true }, "index.js")).toBe(undefined);
  });

  test("sideEffects not present → undefined (conservative)", () => {
    expect(computeEsbuildSideEffects({}, "index.js")).toBe(undefined);
  });

  test("sideEffects: false → false (whole package is side-effect-free)", () => {
    expect(computeEsbuildSideEffects({ sideEffects: false }, "index.js")).toBe(false);
  });

  test("sideEffects: false + CSS path → undefined (CSS exempt)", () => {
    // CSS files are always treated as having side effects in CDN mode,
    // even if the package says sideEffects: false
    expect(computeEsbuildSideEffects({ sideEffects: false }, "file.css")).toBe(undefined);
  });

  test("sideEffects array: file in list → undefined (keeps side effects)", () => {
    const manifest = { sideEffects: ["src/polyfill.js"] };
    expect(computeEsbuildSideEffects(manifest, "src/polyfill.js")).toBe(undefined);
  });

  test("sideEffects array: file NOT in list → false (side-effect-free)", () => {
    const manifest = { sideEffects: ["src/polyfill.js"] };
    expect(computeEsbuildSideEffects(manifest, "src/utils.js")).toBe(false);
  });

  test("sideEffects array with glob: *.css matches CSS files → but isJsLikePath gates it", () => {
    // Even though *.css is in the sideEffects array, CSS paths
    // return undefined early because !isJsLikePath
    const manifest = { sideEffects: ["*.css"] };
    expect(computeEsbuildSideEffects(manifest, "file.css")).toBe(undefined);
  });

  test("matcher cache is reused", () => {
    const cache = new Map();
    const manifest = { sideEffects: ["src/setup.js"] };

    computeEsbuildSideEffects(manifest, "src/utils.js", { matcherCache: cache, packageId: "pkg@1" });
    expect(cache.has("pkg@1")).toBe(true);

    // Second call should reuse cached matchers
    const result = computeEsbuildSideEffects(manifest, "src/other.js", { matcherCache: cache, packageId: "pkg@1" });
    expect(result).toBe(false); // not in sideEffects list
  });
});

// #############################################################################
// cdn-resolution.ts — Pure utility functions
// #############################################################################

describe("cdn-resolution: normalizeResolvedPath", () => {
  test("./dist/index.js → /dist/index.js", () => {
    expect(normalizeResolvedPath("./dist/index.js")).toBe("/dist/index.js");
  });

  test("dist/index.js → /dist/index.js", () => {
    expect(normalizeResolvedPath("dist/index.js")).toBe("/dist/index.js");
  });

  test("already absolute → unchanged", () => {
    expect(normalizeResolvedPath("/dist/index.js")).toBe("/dist/index.js");
  });

  test("dot path normalizes to root-dot (caller decides fallback)", () => {
    expect(normalizeResolvedPath(".")).toBe("/.");
  });
});

describe("cdn-resolution: joinSubpaths", () => {
  test("both empty → empty string", () => {
    expect(joinSubpaths("", "")).toBe("");
  });

  test("base only → base", () => {
    expect(joinSubpaths("base", "")).toBe("base");
  });

  test("extra only → extra", () => {
    expect(joinSubpaths("", "extra")).toBe("extra");
  });

  test("both present → joined with /", () => {
    expect(joinSubpaths("base", "extra")).toBe("base/extra");
  });

  test("trailing slashes on base are stripped", () => {
    expect(joinSubpaths("base/", "extra")).toBe("base/extra");
  });

  test("leading slashes on extra are stripped", () => {
    expect(joinSubpaths("base", "/extra")).toBe("base/extra");
  });

  test("redundant slashes on both sides → clean join", () => {
    expect(joinSubpaths("base///", "///extra")).toBe("base/extra");
  });
});

describe("cdn-resolution: applyPathRemapping", () => {
  test("exact match", () => {
    const remappings: PathRemappings = { "./lib/node.js": "./lib/browser.js" };
    expect(applyPathRemapping("./lib/node.js", remappings)).toBe("./lib/browser.js");
  });

  test("match without ./ prefix", () => {
    const remappings: PathRemappings = { "./lib/node.js": "./lib/browser.js" };
    // "lib/node.js" should match "./lib/node.js" via variant generation
    expect(applyPathRemapping("lib/node.js", remappings)).toBe("./lib/browser.js");
  });

  test("mapped to false (exclusion)", () => {
    const remappings: PathRemappings = { "fs": false };
    expect(applyPathRemapping("fs", remappings)).toBe(false);
  });

  test("no matching remapping → returns original", () => {
    const remappings: PathRemappings = { "./lib/node.js": "./lib/browser.js" };
    expect(applyPathRemapping("./other.js", remappings)).toBe("./other.js");
  });

  test("null remappings → returns original", () => {
    expect(applyPathRemapping("./lib/node.js", null)).toBe("./lib/node.js");
  });

  test("empty resolved path → returns empty (falsy check)", () => {
    const remappings: PathRemappings = { "": "something" };
    expect(applyPathRemapping("", remappings)).toBe("");
  });

  test("leading slash variant: /lib/node.js matches ./lib/node.js", () => {
    // The function generates variants including without leading / and with ./
    const remappings: PathRemappings = { "./lib/node.js": "./lib/browser.js" };
    expect(applyPathRemapping("/lib/node.js", remappings)).toBe("./lib/browser.js");
  });
});

describe("cdn-resolution: applyManifestRemappings", () => {
  const browserConditions: ResolverConditions = {
    conditions: ["import", "browser", "default"],
    browser: true,
    require: false,
  };

  const nodeConditions: ResolverConditions = {
    conditions: ["import", "node", "default"],
    browser: false,
    require: false,
  };

  const reactNativeConditions: ResolverConditions = {
    conditions: ["import", "react-native", "default"],
    browser: false,
    require: false,
  };

  test("browser remapping applied", () => {
    const manifest = {
      browser: { "./fallback/platform.js": "./fallback/platform.browser.js" },
    };
    const result = applyManifestRemappings("./fallback/platform.js", manifest, browserConditions);
    expect(result.path).toBe("./fallback/platform.browser.js");
    expect(result.excluded).toBe(false);
    expect(result.matchedField).toBe("browser");
  });

  test("browser remapping not applied for node conditions", () => {
    const manifest = {
      browser: { "./fallback/platform.js": "./fallback/platform.browser.js" },
    };
    const result = applyManifestRemappings("./fallback/platform.js", manifest, nodeConditions);
    expect(result.path).toBe("./fallback/platform.js");
    expect(result.matchedField).toBe(null);
  });

  test("react-native remapping takes priority over browser", () => {
    const manifest = {
      "react-native": { "./util.js": "./util.native.js" },
      browser: { "./util.js": "./util.browser.js" },
    };
    // react-native is first in REMAPPING_FIELDS, so it wins
    const rnBrowserConditions: ResolverConditions = {
      conditions: ["import", "react-native", "browser", "default"],
      browser: true,
      require: false,
    };
    const result = applyManifestRemappings("./util.js", manifest, rnBrowserConditions);
    expect(result.path).toBe("./util.native.js");
    expect(result.matchedField).toBe("react-native");
  });

  test("exclusion via false", () => {
    const manifest: Partial<PackageJson> = { browser: { "fs": false } };
    const result = applyManifestRemappings("fs", manifest, browserConditions);
    expect(result.excluded).toBe(true);
    expect(result.matchedField).toBe("browser");
  });

  test("null manifest → no change", () => {
    const result = applyManifestRemappings("./file.js", null, browserConditions);
    expect(result.path).toBe("./file.js");
    expect(result.matchedField).toBe(null);
  });

  test("manifest field is string (not object) → skipped", () => {
    // browser: "./index.js" is a string entry point, not a remapping table
    const manifest = { browser: "./index.js" };
    const result = applyManifestRemappings("./lib/node.js", manifest, browserConditions);
    expect(result.path).toBe("./lib/node.js");
    expect(result.matchedField).toBe(null);
  });
});

describe("cdn-resolution: resolvePackageEntry", () => {
  const browserConditions: ResolverConditions = {
    conditions: ["import", "browser", "module", "default"],
    browser: true,
    require: false,
  };

  test("modern exports resolves first", () => {
    const manifest = {
      exports: { ".": { import: "./dist/esm/index.mjs", default: "./dist/cjs/index.cjs" } },
      main: "./dist/cjs/index.cjs",
    };
    const result = resolvePackageEntry({
      manifest,
      subpath: "",
      conditions: browserConditions,
      legacyFields: ["browser", "module", "main"],
    });
    expect(result.usedModern).toBe(true);
    expect(result.path).toBe("./dist/esm/index.mjs");
  });

  test("falls back to legacy when no exports", () => {
    const manifest = {
      module: "./dist/esm/index.js",
      main: "./dist/cjs/index.js",
    };
    const result = resolvePackageEntry({
      manifest,
      subpath: "",
      conditions: browserConditions,
      legacyFields: ["browser", "module", "main"],
    });
    expect(result.usedModern).toBe(false);
    expect(result.path).toBe("./dist/esm/index.js");
  });

  test("no exports, no main, no module → fallback ./index.js", () => {
    const result = resolvePackageEntry({
      manifest: {},
      subpath: "",
      conditions: browserConditions,
      legacyFields: ["browser", "module", "main"],
    });
    expect(result.path).toBe("./index.js");
  });

  test("browser: false exclusion", () => {
    const manifest: Partial<PackageJson> = { browser: false };
    const result = resolvePackageEntry({
      manifest: manifest,
      subpath: "",
      conditions: browserConditions,
      legacyFields: ["browser", "module", "main"],
    });
    expect(result.excluded).toBe(true);
  });

  test("allowLiteralSubpath uses subpath directly when nothing resolves", () => {
    const result = resolvePackageEntry({
      manifest: { exports: { ".": "./index.js" } },
      subpath: "/dist/custom.js",
      conditions: browserConditions,
      legacyFields: ["module", "main"],
      allowLiteralSubpath: true,
    });
    expect(result.path).toBe("./dist/custom.js");
  });

  test("browser object remapping applied to legacy entry point", () => {
    const manifest = {
      browser: { "./lib/node.js": "./lib/browser.js" },
      main: "./lib/node.js",
    };
    const result = resolvePackageEntry({
      manifest,
      subpath: "",
      conditions: browserConditions,
      legacyFields: ["browser", "module", "main"],
    });
    expect(result.path).toBe("./lib/browser.js");
    expect(result.appliedPathRemapping).toBe(true);
    expect(result.pathRemappings).not.toBe(null);
  });
});

describe("cdn-resolution: computePeerDependencies", () => {
  test("adds self as peer dependency", () => {
    const result = computePeerDependencies({
      initialManifest: {},
      resolvedManifest: {},
      initialDeps: {},
      packageName: "my-pkg",
      packageVersion: "1.0.0",
      isNpmCdn: true,
    });
    expect(result["my-pkg"]).toBe("1.0.0");
  });

  test("merges peer deps from both manifests", () => {
    const result = computePeerDependencies({
      initialManifest: { peerDependencies: { react: "^18.0.0" } },
      resolvedManifest: { peerDependencies: { "react-dom": "^18.0.0" } },
      initialDeps: {},
      packageName: "my-pkg",
      packageVersion: "1.0.0",
      isNpmCdn: true,
    });
    expect(result.react).toBe("^18.0.0");
    expect(result["react-dom"]).toBe("^18.0.0");
  });

  test("initialDeps override peer dependency versions", () => {
    const result = computePeerDependencies({
      initialManifest: {},
      resolvedManifest: { peerDependencies: { react: "^18.0.0" } },
      initialDeps: { react: "18.2.0" },
      packageName: "my-pkg",
      packageVersion: "1.0.0",
      isNpmCdn: true,
    });
    // initialDeps should take precedence for version stabilization
    expect(result.react).toBe("18.2.0");
  });

  test("non-npm CDN: uses initialDeps version for self if available", () => {
    const result = computePeerDependencies({
      initialManifest: {},
      resolvedManifest: {},
      initialDeps: { "my-pkg": "2.0.0" },
      packageName: "my-pkg",
      packageVersion: "1.0.0",
      isNpmCdn: false,
    });
    // When not npm CDN, prefers initialDeps version over packageVersion
    expect(result["my-pkg"]).toBe("2.0.0");
  });
});

describe("cdn-resolution: REMAPPING_FIELDS order", () => {
  test("react-native comes before electron, electron before browser", () => {
    const conditions = REMAPPING_FIELDS.map(f => f.condition);
    expect(conditions.indexOf("react-native")).toBeLessThan(conditions.indexOf("electron"));
    expect(conditions.indexOf("electron")).toBeLessThan(conditions.indexOf("browser"));
  });
});

// #############################################################################
// filesystem.ts
// #############################################################################

describe("filesystem: isValid", () => {
  test("undefined → false", () => expect(isValid(undefined)).toBe(false));
  test("null → false", () => expect(isValid(null)).toBe(false));
  test("NaN → false", () => expect(isValid(NaN)).toBe(false));
  test("0 → true", () => expect(isValid(0)).toBe(true));
  test("empty string → true", () => expect(isValid("")).toBe(true));
  test("empty Uint8Array → true", () => expect(isValid(new Uint8Array(0))).toBe(true));
  test("false → true (boolean false is valid content)", () => expect(isValid(false)).toBe(true));
});

describe("filesystem: getResolvedPath", () => {
  test("relative + importer → resolved", () => {
    expect(getResolvedPath("./foo.ts", "/src/bar.ts")).toBe("/src/foo.ts");
  });

  test("relative without importer → unchanged", () => {
    expect(getResolvedPath("./foo.ts")).toBe("./foo.ts");
  });

  test("absolute path ignores importer (does not start with .)", () => {
    expect(getResolvedPath("/abs/path.ts", "/src/bar.ts")).toBe("/abs/path.ts");
  });

  test("parent directory: ../up.ts", () => {
    expect(getResolvedPath("../up.ts", "/src/deep/bar.ts")).toBe("/src/up.ts");
  });
});

describe("filesystem: round-trip with createDefaultFileSystem", () => {
  test("set + get string content", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/test.ts", "const x = 1;");
    const content = await getFile(fs, "/test.ts", "string");
    expect(content).toBe("const x = 1;");
  });

  test("set + get binary content", async () => {
    const fs = createDefaultFileSystem();
    const data = new Uint8Array([1, 2, 3]);
    await setFile(fs, "/test.bin", data);
    const content = await getFile(fs, "/test.bin", "buffer");
    expect(content).toEqual(data);
  });

  test("getFile for non-existent path → null", async () => {
    const fs = createDefaultFileSystem();
    const content = await getFile(fs, "/missing.ts", "string");
    expect(content).toBe(null);
  });

  test("hasFile returns true for existing file", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/exists.ts", "hello");
    expect(await hasFile(fs, "/exists.ts")).toBe(true);
  });

  test("hasFile returns false for non-existent file", async () => {
    const fs = createDefaultFileSystem();
    expect(await hasFile(fs, "/nope.ts")).toBe(false);
  });

  test("fileExists validates content (not just key)", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/real.ts", "code");
    expect(await fileExists(fs, "/real.ts")).toBe(true);
  });

  test("fileExists returns false for non-existent", async () => {
    const fs = createDefaultFileSystem();
    expect(await fileExists(fs, "/ghost.ts")).toBe(false);
  });

  test("deleteFile removes existing file", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/remove-me.ts", "bye");
    await deleteFile(fs, "/remove-me.ts");
    expect(await hasFile(fs, "/remove-me.ts")).toBe(false);
  });

  test("deleteFile returns false for non-existent file", async () => {
    const fs = createDefaultFileSystem();
    const result = await deleteFile(fs, "/never-existed.ts");
    expect(result).toBe(false);
  });

  test("setFile with null content is a no-op", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/nothing.ts", null as unknown as string);
    expect(await hasFile(fs, "/nothing.ts")).toBe(false);
  });

  test("setFile with undefined content is a no-op", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/nothing.ts", undefined as unknown as string);
    expect(await hasFile(fs, "/nothing.ts")).toBe(false);
  });
});

// #############################################################################
// plugins/fs.ts — VFS resolution utilities
// #############################################################################

describe("plugins/fs: stripAnyPrefix", () => {
  test("strips vfs: prefix", () => {
    expect(stripAnyPrefix("vfs:/index.tsx", ["vfs:", "virtual:"])).toBe("/index.tsx");
  });

  test("strips virtual: prefix and adds leading /", () => {
    expect(stripAnyPrefix("virtual:src/main.ts", ["vfs:", "virtual:"])).toBe("/src/main.ts");
  });

  test("already has / after prefix → no double slash", () => {
    expect(stripAnyPrefix("virtual:/src/main.ts", ["vfs:", "virtual:"])).toBe("/src/main.ts");
  });

  test("no matching prefix → unchanged", () => {
    expect(stripAnyPrefix("other:path", ["vfs:", "virtual:"])).toBe("other:path");
  });

  test("empty prefix list → unchanged", () => {
    expect(stripAnyPrefix("vfs:/index.tsx", [])).toBe("vfs:/index.tsx");
  });
});

describe("plugins/fs: resolveVfsPath", () => {
  test("exact file match", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/src/index.ts", "export const x = 1");
    const result = await resolveVfsPath(fs, "/src/index.ts", RESOLVE_EXTENSIONS);
    expect(result).toBe("/src/index.ts");
  });

  test("extension probing: /src/index → /src/index.tsx", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/src/index.tsx", "export default () => <div />");
    const result = await resolveVfsPath(fs, "/src/index", RESOLVE_EXTENSIONS);
    expect(result).toBe("/src/index.tsx");
  });

  test("index fallback: /src → /src/index.ts", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/src/index.ts", "export const y = 2");
    const result = await resolveVfsPath(fs, "/src", RESOLVE_EXTENSIONS);
    expect(result).toBe("/src/index.ts");
  });

  test("nothing found → null", async () => {
    const fs = createDefaultFileSystem();
    const result = await resolveVfsPath(fs, "/missing", RESOLVE_EXTENSIONS);
    expect(result).toBe(null);
  });

  test("enableIndexFallback=false skips directory/index probing", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/lib/index.ts", "content");
    const result = await resolveVfsPath(fs, "/lib", RESOLVE_EXTENSIONS, false);
    // Without index fallback, /lib should check /lib.tsx, /lib.ts, etc., but not /lib/index.ts
    // Since none of those exist, result should be null
    expect(result).toBe(null);
  });

  test("extension probing respects order (.tsx before .ts)", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/comp.tsx", "TSX content");
    await setFile(fs, "/comp.ts", "TS content");
    // RESOLVE_EXTENSIONS is [".tsx", ".ts", ...], so .tsx should win
    const result = await resolveVfsPath(fs, "/comp", RESOLVE_EXTENSIONS);
    expect(result).toBe("/comp.tsx");
  });

  test("suffix-style import probing: /Expo.fx -> /Expo.fx.ts", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/Expo.fx.ts", "export const Expo = 1;");
    const result = await resolveVfsPath(fs, "/Expo.fx", RESOLVE_EXTENSIONS);
    expect(result).toBe("/Expo.fx.ts");
  });

  test("suffix-style import probing: /uuid.types -> /uuid.types.ts", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/uuid.types.ts", "export type UUID = string;");
    const result = await resolveVfsPath(fs, "/uuid.types", RESOLVE_EXTENSIONS);
    expect(result).toBe("/uuid.types.ts");
  });

  test("known extension still resolves exact path only", async () => {
    const fs = createDefaultFileSystem();
    await setFile(fs, "/lib.ts", "export const lib = 1;");
    const result = await resolveVfsPath(fs, "/lib.ts", RESOLVE_EXTENSIONS);
    expect(result).toBe("/lib.ts");
  });
});

// #############################################################################
// plugins/alias.ts: isAlias
// #############################################################################

describe("plugins/alias: isAlias", () => {
  test("matching bare import → returns alias key", () => {
    expect(isAlias("fs", { fs: "memfs" })).toBe("fs");
  });

  test("scoped package alias", () => {
    expect(isAlias("@scope/pkg", { "@scope/pkg": "alias" })).toBe("@scope/pkg");
  });

  test("no aliases → undefined", () => {
    expect(isAlias("react", {})).toBeUndefined();
  });

  test("relative path → false (not a bare import)", () => {
    expect(isAlias("./local", { "./local": "x" })).toBe(false);
  });

  test("private import #internal → passes through to alias lookup", () => {
    // isAlias intentionally allows # imports through the guard:
    // the condition `!/^#/.test(id)` is false, short-circuiting the AND,
    // so # imports are checked against the alias table.
    expect(isAlias("#internal", { "#internal": "x" })).toBe("#internal");
  });

  test("subpath matches by name: lodash/get with alias for lodash", () => {
    expect(isAlias("lodash/get", { lodash: "lodash-es" })).toBe("lodash");
  });

  test("no match → undefined", () => {
    expect(isAlias("react", { vue: "vue3" })).toBeUndefined();
  });
});

// #############################################################################
// plugins/external.ts: isExternal
// #############################################################################

describe("plugins/external: isExternal", () => {
  test("fs is external (node builtin)", () => {
    expect(isExternal("fs")).toBe("fs");
  });

  test("path is external (node builtin)", () => {
    expect(isExternal("path")).toBe("path");
  });

  test("node:fs strips prefix for matching", () => {
    expect(isExternal("node:fs")).toBe("fs");
  });

  test("fs/promises matches fs parent", () => {
    expect(isExternal("fs/promises")).toBe("fs");
  });

  test("crypto is external", () => {
    expect(isExternal("crypto")).toBe("crypto");
  });

  test("react is NOT external by default", () => {
    expect(isExternal("react")).toBeUndefined();
  });

  test("custom external pattern", () => {
    expect(isExternal("react", ["react"])).toBe("react");
  });

  test("custom external with subpath", () => {
    expect(isExternal("@scope/pkg/sub", ["@scope/pkg"])).toBe("@scope/pkg");
  });
});

// #############################################################################
// plugins/tar.ts: parseTarballUrl, stripPackagePrefix
// #############################################################################

describe("plugins/tar: stripPackagePrefix", () => {
  test("strips package/ prefix", () => {
    expect(stripPackagePrefix("package/dist/index.js")).toBe("dist/index.js");
  });

  test("no prefix → unchanged", () => {
    expect(stripPackagePrefix("dist/index.js")).toBe("dist/index.js");
  });

  test("package/ alone → empty string", () => {
    expect(stripPackagePrefix("package/")).toBe("");
  });

  test("'package' without slash → unchanged", () => {
    expect(stripPackagePrefix("package")).toBe("package");
  });
});

describe("plugins/tar: parseTarballUrl", () => {
  test("compact form: scoped package", () => {
    const url = new URL("https://pkg.pr.new/@tanstack/react-query@7988");
    const result = parseTarballUrl(url);
    expect(result.name).toBe("@tanstack/react-query");
    expect(result.version).toBe("7988");
    expect(result.subpath).toBe("");
    expect(result.owner).toBe(null);
    expect(result.repo).toBe(null);
  });

  test("compact form: scoped package with subpath", () => {
    const url = new URL("https://pkg.pr.new/@tanstack/react-query@7988/build/modern");
    const result = parseTarballUrl(url);
    expect(result.name).toBe("@tanstack/react-query");
    expect(result.version).toBe("7988");
    expect(result.subpath).toBe("/build/modern");
  });

  test("compact form: unscoped package", () => {
    const url = new URL("https://pkg.pr.new/tinybench@a832a55");
    const result = parseTarballUrl(url);
    expect(result.name).toBe("tinybench");
    expect(result.version).toBe("a832a55");
    expect(result.subpath).toBe("");
  });

  test("non-compact form: owner/repo/pkg", () => {
    const url = new URL("https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55");
    const result = parseTarballUrl(url);
    expect(result.owner).toBe("tinylibs");
    expect(result.repo).toBe("tinybench");
    expect(result.name).toBe("tinybench");
    expect(result.version).toBe("a832a55");
  });

  test("empty path → empty result", () => {
    const url = new URL("https://pkg.pr.new/");
    const result = parseTarballUrl(url);
    expect(result.name).toBe("");
    expect(result.pkgSpec).toBe("");
  });

  test("known non-package route (template/) throws", () => {
    const url = new URL("https://pkg.pr.new/template/foo");
    expect(() => parseTarballUrl(url)).toThrow();
  });

  test("known non-package route with ignoreError → empty", () => {
    const url = new URL("https://pkg.pr.new/badge/something");
    const result = parseTarballUrl(url, { ignoreError: true });
    expect(result.name).toBe("");
  });

  test("no version → uses defaultVersion", () => {
    const url = new URL("https://pkg.pr.new/my-package");
    const result = parseTarballUrl(url);
    expect(result.name).toBe("my-package");
    expect(result.version).toBe("latest");
  });

  test("custom defaultVersion", () => {
    const url = new URL("https://pkg.pr.new/my-package");
    const result = parseTarballUrl(url, { defaultVersion: "0.0.0" });
    expect(result.version).toBe("0.0.0");
  });

  test("packageUrl strips query and hash", () => {
    const url = new URL("https://pkg.pr.new/tinybench@abc123?debug=true#section");
    const result = parseTarballUrl(url);
    expect(result.packageUrl.search).toBe("");
    expect(result.packageUrl.hash).toBe("");
  });
});

// #############################################################################
// utils/url.ts
// #############################################################################

describe("utils/url: encodeWhitespace", () => {
  test("encodes spaces", () => {
    expect(encodeWhitespace("hello world")).toBe("hello%20world");
  });

  test("encodes tabs", () => {
    expect(encodeWhitespace("tab\there")).toBe("tab%09here");
  });

  test("no whitespace → unchanged", () => {
    expect(encodeWhitespace("no-spaces")).toBe("no-spaces");
  });

  test("empty string → empty string", () => {
    expect(encodeWhitespace("")).toBe("");
  });
});

describe("utils/url: urlJoin", () => {
  test("joins path to URL", () => {
    const result = urlJoin("https://esm.sh/", "react");
    expect(result).toBe("https://esm.sh/react");
  });

  test("resolves parent directory", () => {
    const result = urlJoin("https://esm.sh/react@18/index.js", "../utils.js");
    expect(result).toBe("https://esm.sh/react@18/utils.js");
  });

  test("multiple segments", () => {
    const result = urlJoin("https://esm.sh/", "react@18", "index.js");
    expect(result).toBe("https://esm.sh/react@18/index.js");
  });
});

describe("utils/url: toURLPath", () => {
  test("converts URL to /_host_/path format", () => {
    const result = toURLPath("https://esm.sh/react");
    expect(result).toBe("/esm_sh/react");
  });

  test("dots in host become underscores", () => {
    const result = toURLPath("https://cdn.jsdelivr.net/npm/lodash");
    expect(result).toBe("/cdn_jsdelivr_net/npm/lodash");
  });

  test("URL object input", () => {
    const result = toURLPath(new URL("https://unpkg.com/lodash@4/lodash.min.js"));
    expect(result).toBe("/unpkg_com/lodash@4/lodash.min.js");
  });
});

// #############################################################################
// utils/path.ts: isBareImport
// #############################################################################

describe("utils/path: isBareImport", () => {
  test("simple package → true", () => {
    expect(isBareImport("react")).toBe(true);
  });

  test("scoped package → true", () => {
    expect(isBareImport("@scope/pkg")).toBe(true);
  });

  test("relative ./ → false", () => {
    expect(isBareImport("./local")).toBe(false);
  });

  test("relative ../ → false", () => {
    expect(isBareImport("../up")).toBe(false);
  });

  test("absolute / → false", () => {
    expect(isBareImport("/absolute")).toBe(false);
  });

  test("private import # → false", () => {
    // Subpath imports have special resolution rules and are NOT bare
    expect(isBareImport("#internal")).toBe(false);
  });

  test("data: URL → false", () => {
    expect(isBareImport("data:text/javascript,export default 1")).toBe(false);
  });

  test("node:fs → true (treated as bare import)", () => {
    // node: prefix is recognized by other plugins, but syntactically it's bare
    expect(isBareImport("node:fs")).toBe(true);
  });
});
