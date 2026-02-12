/**
 * Scenario 19 — Registry Tarballs & Generic `.tgz` URLs
 *
 * Tests for the extension-based tarball URL detection, generic tarball URL
 * parsing, TarResolution routing between pkg.pr.new and generic tarball
 * sources, and VFS tarball path detection.
 *
 * ## Coverage Map
 *
 * | Section | Scenario |
 * |---------|----------|
 * | 19.1 — isTarballUrl detection | CDN-style and extension-based detection |
 * | 19.2 — parseGenericTarballUrl | Splitting tarball URL from subpath |
 * | 19.3 — parseTarballUrl (pkg.pr.new) | Compact/non-compact path parsing |
 * | 19.4 — TarResolution routing | pkg.pr.new vs registry dispatch |
 * | 19.5 — resolvePackageEntry | Subpath resolution via exports/main |
 * | 19.6 — stripPackagePrefix | Tarball path prefix stripping |
 * | 19.7 — Edge cases | Case sensitivity, multi-extension, archive-detect coverage |
 * | 19.8 — VFS tarball path detection | isTarballPath + findTarballSplitInPathname for VFS paths |
 * | 19.9 — Registry CDN style detection | getCDNStyle for npm:, npm.registry:, jsr.registry:, URLs |
 * | 19.10 — getNpmTarballUrl construction | Tarball URL construction for scoped/unscoped packages |
 * | 19.11 — getPackageTarballUrl | Manifest dist.tarball preference vs fallback |
 * | 19.12 — npm: and jsr.registry: scheme helpers | Origin, path, URL generation for shorthand schemes |
 *
 * @see docs/scenarios/19-registry-tarballs.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  isTarballUrl,
  isTarballPath,
  parseGenericTarballUrl,
  parseTarballUrl,
  stripPackagePrefix,
  resolvePackageEntry,
  findTarballSplitInPathname,
} from "../plugins/tar.ts";

import { getResolverConditions } from "../../utils/resolve-conditions.ts";
import { getCDNStyle, getCDNOrigin, getPureImportPath, getCDNUrl } from "../utils/cdn-format.ts";
import { getNpmTarballUrl, getPackageTarballUrl } from "@bundle/utils/npm-search";
import { TAR_MULTI_EXTENSIONS, TAR_SHORT_EXTENSIONS } from "@bundle/utils/archive-detect";

// =============================================================================
// 19.1 — isTarballUrl detection
// =============================================================================

describe("19.1 — isTarballUrl detection", () => {
  describe("CDN-style detection (pkg.pr.new)", () => {
    test("pkg.pr.new root URL", () => {
      const url = new URL("https://pkg.pr.new/@tanstack/react-query@7988");
      expect(isTarballUrl(url)).toBe(true);
    });

    test("pkg.pr.new with subpath", () => {
      const url = new URL("https://pkg.pr.new/@tanstack/react-query@7988/build/modern");
      expect(isTarballUrl(url)).toBe(true);
    });

    test("getCDNStyle still returns 'tarball' for pkg.pr.new", () => {
      expect(getCDNStyle("https://pkg.pr.new")).toBe("tarball");
    });
  });

  describe("Extension-based detection (.tgz)", () => {
    test("npm registry tarball — unscoped", () => {
      const url = new URL("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
      expect(isTarballUrl(url)).toBe(true);
    });

    test("npm registry tarball — scoped", () => {
      const url = new URL("https://registry.npmjs.org/@tanstack/react-query/-/react-query-5.0.0.tgz");
      expect(isTarballUrl(url)).toBe(true);
    });

    test("npm registry tarball with subpath", () => {
      const url = new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator");
      expect(isTarballUrl(url)).toBe(true);
    });

    test("GitHub release .tar.gz", () => {
      const url = new URL("https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz");
      expect(isTarballUrl(url)).toBe(true);
    });

    test("GitHub release .tar.gz with subpath", () => {
      const url = new URL("https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz/lib/index");
      expect(isTarballUrl(url)).toBe(true);
    });

    test("generic .tgz URL", () => {
      const url = new URL("https://example.com/packages/my-lib-1.0.0.tgz");
      expect(isTarballUrl(url)).toBe(true);
    });

    test(".tar.zst extension (zstd-compressed tarball)", () => {
      const url = new URL("https://example.com/packages/my-lib-1.0.0.tar.zst");
      expect(isTarballUrl(url)).toBe(true);
    });

    test(".txz extension (xz-compressed tarball)", () => {
      const url = new URL("https://example.com/packages/my-lib-1.0.0.txz");
      expect(isTarballUrl(url)).toBe(true);
    });

    test(".tar.xz extension", () => {
      const url = new URL("https://example.com/packages/my-lib-1.0.0.tar.xz");
      expect(isTarballUrl(url)).toBe(true);
    });

    test(".tbz2 extension (bzip2-compressed tarball)", () => {
      const url = new URL("https://example.com/packages/my-lib-1.0.0.tbz2");
      expect(isTarballUrl(url)).toBe(true);
    });

    test(".tar.bz2 extension", () => {
      const url = new URL("https://example.com/packages/my-lib-1.0.0.tar.bz2");
      expect(isTarballUrl(url)).toBe(true);
    });

    test(".tar (uncompressed) extension", () => {
      const url = new URL("https://example.com/packages/my-lib-1.0.0.tar");
      expect(isTarballUrl(url)).toBe(true);
    });

    test(".tar.zst with subpath", () => {
      const url = new URL("https://example.com/packages/my-lib.tar.zst/lib/index");
      expect(isTarballUrl(url)).toBe(true);
    });
  });

  describe("Non-tarball URLs (should return false)", () => {
    test("npm CDN (esm.sh)", () => {
      const url = new URL("https://esm.sh/react@18");
      expect(isTarballUrl(url)).toBe(false);
    });

    test("unpkg CDN", () => {
      const url = new URL("https://unpkg.com/lodash@4.17.21/lodash.js");
      expect(isTarballUrl(url)).toBe(false);
    });

    test("jsdelivr CDN", () => {
      const url = new URL("https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.js");
      expect(isTarballUrl(url)).toBe(false);
    });

    test("raw JS file URL", () => {
      const url = new URL("https://example.com/index.js");
      expect(isTarballUrl(url)).toBe(false);
    });

    test("URL with 'tgz' in hostname but not in path", () => {
      const url = new URL("https://tgz-server.example.com/package");
      expect(isTarballUrl(url)).toBe(false);
    });
  });
});

// =============================================================================
// 19.2 — parseGenericTarballUrl
// =============================================================================

describe("19.2 — parseGenericTarballUrl", () => {
  test("npm registry tarball — no subpath", () => {
    const url = new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz");
    expect(result.subpath).toBe("");
  });

  test("npm registry tarball — with single-segment subpath", () => {
    const url = new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz");
    expect(result.subpath).toBe("/expo-sqlite");
  });

  test("npm registry tarball — with multi-segment subpath", () => {
    const url = new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz");
    expect(result.subpath).toBe("/expo-sqlite/migrator");
  });

  test("scoped package tarball — no subpath", () => {
    const url = new URL("https://registry.npmjs.org/@tanstack/react-query/-/react-query-5.0.0.tgz");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/@tanstack/react-query/-/react-query-5.0.0.tgz");
    expect(result.subpath).toBe("");
  });

  test(".tar.gz extension — no subpath", () => {
    const url = new URL("https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz");
    expect(result.subpath).toBe("");
  });

  test(".tar.gz extension — with subpath", () => {
    const url = new URL("https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz/lib/index");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://github.com/user/repo/releases/download/v1.0.0/package.tar.gz");
    expect(result.subpath).toBe("/lib/index");
  });

  test("strips query and hash from tarball URL", () => {
    const url = new URL("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz?token=abc#section");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
    expect(result.tarballUrl.search).toBe("");
    expect(result.tarballUrl.hash).toBe("");
    expect(result.subpath).toBe("");
  });

  test("fallback for non-tarball URL", () => {
    const url = new URL("https://example.com/package/index.js");
    const result = parseGenericTarballUrl(url);

    // Returns the full URL as tarballUrl, empty subpath
    expect(result.tarballUrl.href).toBe("https://example.com/package/index.js");
    expect(result.subpath).toBe("");
  });
});

// =============================================================================
// 19.3 — parseTarballUrl (pkg.pr.new) still works
// =============================================================================

describe("19.3 — parseTarballUrl (pkg.pr.new) unchanged", () => {
  test("compact scoped package", () => {
    const url = new URL("https://pkg.pr.new/@tanstack/react-query@7988");
    const result = parseTarballUrl(url);

    expect(result.name).toBe("@tanstack/react-query");
    expect(result.version).toBe("7988");
    expect(result.subpath).toBe("");
  });

  test("compact scoped package with subpath", () => {
    const url = new URL("https://pkg.pr.new/@tanstack/react-query@7988/build/modern");
    const result = parseTarballUrl(url);

    expect(result.name).toBe("@tanstack/react-query");
    expect(result.version).toBe("7988");
    expect(result.subpath).toBe("/build/modern");
  });

  test("non-compact form with owner/repo", () => {
    const url = new URL("https://pkg.pr.new/tinylibs/tinybench/tinybench@a832a55");
    const result = parseTarballUrl(url);

    expect(result.owner).toBe("tinylibs");
    expect(result.repo).toBe("tinybench");
    expect(result.name).toBe("tinybench");
    expect(result.version).toBe("a832a55");
  });
});

// =============================================================================
// 19.4 — TarResolution routing
// =============================================================================

describe("19.4 — TarResolution routing logic", () => {
  test("pkg.pr.new URL routes to parseTarballUrl", () => {
    const url = new URL("https://pkg.pr.new/@tanstack/react-query@7988");

    // Verify the routing condition matches
    expect(getCDNStyle(url.origin) === "tarball").toBe(true);
  });

  test("registry tarball routes to parseGenericTarballUrl", () => {
    const url = new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz");

    // Not a CDN-style tarball, but IS a tarball URL
    expect(getCDNStyle(url.origin) === "tarball").toBe(false);
    expect(isTarballUrl(url)).toBe(true);

    // So it would take the generic parsing path
    const result = parseGenericTarballUrl(url);
    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz");
    expect(result.subpath).toBe("");
  });

  test("registry tarball with subpath routes correctly", () => {
    const url = new URL("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator");

    expect(getCDNStyle(url.origin) === "tarball").toBe(false);
    expect(isTarballUrl(url)).toBe(true);

    const result = parseGenericTarballUrl(url);
    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/drizzle-orm/-/drizzle-orm-0.45.1.tgz");
    expect(result.subpath).toBe("/expo-sqlite/migrator");
  });
});

// =============================================================================
// 19.5 — resolvePackageEntry with subpaths
// =============================================================================

describe("19.5 — resolvePackageEntry with subpaths", () => {
  const defaultConditions = {
    browser: true,
    require: false,
    conditions: ["import", "browser", "default"],
  };

  test("root import resolves via exports[\".\"]", () => {
    const manifest = {
      name: "drizzle-orm",
      version: "0.45.1",
      exports: {
        ".": {
          import: "./dist/index.js",
          default: "./dist/index.cjs",
        },
      },
    };

    const entry = resolvePackageEntry(manifest, "", defaultConditions);
    expect(entry).toBe("/dist/index.js");
  });

  test("subpath import resolves via exports[\"./expo-sqlite\"]", () => {
    const manifest = {
      name: "drizzle-orm",
      version: "0.45.1",
      exports: {
        ".": { import: "./dist/index.js" },
        "./expo-sqlite": { import: "./expo-sqlite/index.js" },
        "./expo-sqlite/migrator": { import: "./expo-sqlite/migrator.js" },
      },
    };

    const entry = resolvePackageEntry(manifest, "/expo-sqlite", defaultConditions);
    expect(entry).toBe("/expo-sqlite/index.js");
  });

  test("deep subpath import resolves via exports[\"./expo-sqlite/migrator\"]", () => {
    const manifest = {
      name: "drizzle-orm",
      version: "0.45.1",
      exports: {
        ".": { import: "./dist/index.js" },
        "./expo-sqlite": { import: "./expo-sqlite/index.js" },
        "./expo-sqlite/migrator": { import: "./expo-sqlite/migrator.js" },
      },
    };

    const entry = resolvePackageEntry(manifest, "/expo-sqlite/migrator", defaultConditions);
    expect(entry).toBe("/expo-sqlite/migrator.js");
  });

  test("root import falls back to main when no exports", () => {
    const manifest = {
      name: "legacy-pkg",
      version: "1.0.0",
      main: "./lib/index.js",
    };

    const entry = resolvePackageEntry(manifest, "", defaultConditions);
    expect(entry).toBe("/lib/index.js");
  });

  test("root import falls back to module over main", () => {
    const manifest = {
      name: "hybrid-pkg",
      version: "1.0.0",
      main: "./lib/index.cjs",
      module: "./lib/index.mjs",
    };

    const entry = resolvePackageEntry(manifest, "", defaultConditions);
    // module is preferred for browser context
    expect(entry).toMatch(/\.mjs|\.js/);
  });
});

// =============================================================================
// 19.6 — stripPackagePrefix
// =============================================================================

describe("19.6 — stripPackagePrefix", () => {
  test("strips 'package/' prefix", () => {
    expect(stripPackagePrefix("package/lib/index.js")).toBe("lib/index.js");
  });

  test("strips 'package/' for package.json", () => {
    expect(stripPackagePrefix("package/package.json")).toBe("package.json");
  });

  test("leaves non-prefixed paths unchanged", () => {
    expect(stripPackagePrefix("lib/index.js")).toBe("lib/index.js");
  });

  test("leaves empty string unchanged", () => {
    expect(stripPackagePrefix("")).toBe("");
  });
});

// =============================================================================
// 19.7 — Edge cases
// =============================================================================

describe("19.7 — Edge cases", () => {
  test("case insensitive .TGZ detection", () => {
    const url = new URL("https://example.com/package.TGZ");
    expect(isTarballUrl(url)).toBe(true);

    const result = parseGenericTarballUrl(url);
    expect(result.tarballUrl.href).toBe("https://example.com/package.TGZ");
    expect(result.subpath).toBe("");
  });

  test("case insensitive .TAR.GZ detection", () => {
    const url = new URL("https://example.com/package.TAR.GZ");
    expect(isTarballUrl(url)).toBe(true);
  });

  test(".tgz in the middle of a longer extension is not matched", () => {
    // ".tgz" followed by more extension chars (not / or end) — should NOT match
    // e.g. hypothetical ".tgzx" extension
    const url = new URL("https://example.com/package.tgzx");
    expect(isTarballUrl(url)).toBe(false);
  });

  test("multiple .tgz in path — first tarball-like segment wins", () => {
    // Contrived: both a directory and file named with .tgz
    // With segment walking, the FIRST tarball-like segment is the split point.
    // This is correct: "old.tgz" IS the tarball; everything after is its subpath.
    const url = new URL("https://example.com/cache/old.tgz/new-pkg.tgz/lib/index");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://example.com/cache/old.tgz");
    expect(result.subpath).toBe("/new-pkg.tgz/lib/index");
  });

  test(".tar.zst URL splits correctly", () => {
    const url = new URL("https://example.com/packages/my-lib.tar.zst/src/index");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://example.com/packages/my-lib.tar.zst");
    expect(result.subpath).toBe("/src/index");
  });

  test(".tar.xz URL splits correctly", () => {
    const url = new URL("https://example.com/packages/my-lib.tar.xz/lib/main");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://example.com/packages/my-lib.tar.xz");
    expect(result.subpath).toBe("/lib/main");
  });

  test(".tar URL splits correctly", () => {
    const url = new URL("https://example.com/packages/my-lib.tar/dist");
    const result = parseGenericTarballUrl(url);

    expect(result.tarballUrl.href).toBe("https://example.com/packages/my-lib.tar");
    expect(result.subpath).toBe("/dist");
  });

  test("archive-detect extensions are all recognized by isTarballUrl", () => {
    // Verify every extension from archive-detect's two lists + .tar is detected.
    // This confirms the tar plugin properly delegates to detectArchiveFromPathHint()
    // rather than maintaining its own extension list.
    const allExtensions = [...TAR_MULTI_EXTENSIONS, ...TAR_SHORT_EXTENSIONS, ".tar"];

    for (const ext of allExtensions) {
      const url = new URL(`https://example.com/pkg${ext}`);
      expect(isTarballUrl(url)).toBe(true);
    }
  });

  test("archive-detect extensions all split correctly in parseGenericTarballUrl", () => {
    const allExtensions = [...TAR_MULTI_EXTENSIONS, ...TAR_SHORT_EXTENSIONS, ".tar"];

    for (const ext of allExtensions) {
      const url = new URL(`https://example.com/pkg${ext}/sub/path`);
      const result = parseGenericTarballUrl(url);

      expect(result.tarballUrl.href).toBe(`https://example.com/pkg${ext}`);
      expect(result.subpath).toBe("/sub/path");
    }
  });

  test("findTarballSplitInPathname returns null for non-tarball paths", () => {
    expect(findTarballSplitInPathname("/path/to/file.js")).toBe(null);
    expect(findTarballSplitInPathname("/")).toBe(null);
    expect(findTarballSplitInPathname("")).toBe(null);
  });

  test("findTarballSplitInPathname splits at first tarball segment", () => {
    const result = findTarballSplitInPathname("/drizzle-orm/-/drizzle-orm-0.45.1.tgz/expo-sqlite/migrator");
    expect(result).not.toBe(null);
    expect(result!.tarballPath).toBe("/drizzle-orm/-/drizzle-orm-0.45.1.tgz");
    expect(result!.subpath).toBe("/expo-sqlite/migrator");
  });

  test("expo-sqlite registry tarball", () => {
    const url = new URL("https://registry.npmjs.org/expo-sqlite/-/expo-sqlite-16.0.10.tgz");
    expect(isTarballUrl(url)).toBe(true);

    const result = parseGenericTarballUrl(url);
    expect(result.tarballUrl.href).toBe("https://registry.npmjs.org/expo-sqlite/-/expo-sqlite-16.0.10.tgz");
    expect(result.subpath).toBe("");
  });
});

// =============================================================================
// 19.8 — VFS tarball path detection (isTarballPath)
// =============================================================================

describe("19.8 — VFS tarball path detection", () => {
  test("absolute VFS path with .tgz", () => {
    expect(isTarballPath("/packages/my-lib.tgz")).toBe(true);
  });

  test("absolute VFS path with .tar.gz", () => {
    expect(isTarballPath("/vendor/pkg.tar.gz")).toBe(true);
  });

  test("absolute VFS path with .tgz and subpath", () => {
    expect(isTarballPath("/packages/my-lib.tgz/lib/index")).toBe(true);
  });

  test("absolute VFS path with .tar.zst", () => {
    expect(isTarballPath("/cache/my-lib.tar.zst")).toBe(true);
  });

  test("regular VFS path is not tarball-like", () => {
    expect(isTarballPath("/src/index.ts")).toBe(false);
  });

  test("bare specifier is not tarball-like", () => {
    expect(isTarballPath("react")).toBe(false);
  });

  test("relative tarball path", () => {
    expect(isTarballPath("./vendor/my-lib.tgz")).toBe(true);
  });

  test("relative non-tarball path", () => {
    expect(isTarballPath("./src/utils.ts")).toBe(false);
  });

  test("VFS tarball path splits correctly via findTarballSplitInPathname", () => {
    const result = findTarballSplitInPathname("/packages/my-lib.tgz/lib/index");
    expect(result).not.toBe(null);
    expect(result!.tarballPath).toBe("/packages/my-lib.tgz");
    expect(result!.subpath).toBe("/lib/index");
  });

  test("VFS tarball path without subpath", () => {
    const result = findTarballSplitInPathname("/vendor/pkg.tar.gz");
    expect(result).not.toBe(null);
    expect(result!.tarballPath).toBe("/vendor/pkg.tar.gz");
    expect(result!.subpath).toBe("");
  });

  test("isTarballUrl delegates to isTarballPath for extension check", () => {
    // Verify isTarballUrl still works — it internally uses isTarballPath
    const url = new URL("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
    expect(isTarballUrl(url)).toBe(true);
    // And the underlying path check agrees
    expect(isTarballPath(url.pathname)).toBe(true);
  });

  test("every archive-detect extension is recognized by isTarballPath", () => {
    const allExtensions = [...TAR_MULTI_EXTENSIONS, ...TAR_SHORT_EXTENSIONS, ".tar"];
    for (const ext of allExtensions) {
      expect(isTarballPath(`/packages/pkg${ext}`)).toBe(true);
    }
  });
});
// =============================================================================
// 19.9 — Registry CDN style detection
// =============================================================================

describe("19.9 — Registry CDN style detection", () => {
  test("npm.registry scheme prefix", () => {
    expect(getCDNStyle("npm.registry:react@18")).toBe("registry");
  });

  test("npm scheme prefix (shorthand for npm.registry)", () => {
    expect(getCDNStyle("npm:react@18")).toBe("registry");
  });

  test("registry.npmjs.org URL", () => {
    expect(getCDNStyle("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz")).toBe("registry");
  });

  test("registry.npmjs.com URL", () => {
    expect(getCDNStyle("https://registry.npmjs.com/react")).toBe("registry");
  });

  test("jsr.registry scheme prefix maps to jsr style", () => {
    expect(getCDNStyle("jsr.registry:@std/path")).toBe("jsr");
  });

  test("jsr.registry does not conflict with jsr", () => {
    expect(getCDNStyle("jsr:@std/path")).toBe("jsr");
    expect(getCDNStyle("jsr.registry:@std/path")).toBe("jsr");
  });

  test("does not confuse npm CDN with registry", () => {
    expect(getCDNStyle("https://unpkg.com/react")).toBe("npm");
    expect(getCDNStyle("esm:react")).toBe("npm");
  });

  test("does not confuse pkg.pr.new with registry", () => {
    expect(getCDNStyle("https://pkg.pr.new/@tanstack/react-query@7988")).toBe("tarball");
  });
});

// =============================================================================
// 19.10 — getNpmTarballUrl construction
// =============================================================================

describe("19.10 — getNpmTarballUrl construction", () => {
  test("unscoped package", () => {
    expect(getNpmTarballUrl("lodash-es", "4.17.21")).toBe(
      "https://registry.npmjs.com/lodash-es/-/lodash-es-4.17.21.tgz"
    );
  });

  test("scoped package", () => {
    expect(getNpmTarballUrl("@tanstack/react-query", "5.0.0")).toBe(
      "https://registry.npmjs.com/@tanstack/react-query/-/react-query-5.0.0.tgz"
    );
  });

  test("custom registry", () => {
    expect(getNpmTarballUrl("react", "18.2.0", "https://registry.npmmirror.com")).toBe(
      "https://registry.npmmirror.com/react/-/react-18.2.0.tgz"
    );
  });

  test("strips trailing slashes from registry", () => {
    expect(getNpmTarballUrl("react", "18.2.0", "https://registry.npmjs.com///")).toBe(
      "https://registry.npmjs.com/react/-/react-18.2.0.tgz"
    );
  });
});

// =============================================================================
// 19.11 — getPackageTarballUrl (manifest vs fallback)
// =============================================================================

describe("19.11 — getPackageTarballUrl", () => {
  test("prefers manifest dist.tarball when available", () => {
    const manifest = {
      name: "react",
      version: "18.2.0",
      dist: {
        tarball: "https://registry.npmjs.org/react/-/react-18.2.0.tgz",
        integrity: "",
        shasum: "",
        fileCount: 0,
        unpackedSize: 0,
        "npm-signature": "",
        signatures: [],
      },
    };
    expect(getPackageTarballUrl(manifest as any, "react", "18.2.0")).toBe(
      "https://registry.npmjs.org/react/-/react-18.2.0.tgz"
    );
  });

  test("falls back to construction when manifest is null", () => {
    expect(getPackageTarballUrl(null, "react", "18.2.0")).toBe(
      "https://registry.npmjs.com/react/-/react-18.2.0.tgz"
    );
  });

  test("falls back to construction when dist.tarball is missing", () => {
    expect(getPackageTarballUrl({} as any, "lodash", "4.17.21")).toBe(
      "https://registry.npmjs.com/lodash/-/lodash-4.17.21.tgz"
    );
  });
});

// =============================================================================
// 19.12 — npm: and jsr.registry: scheme helpers
// =============================================================================

describe("19.12 — npm: and jsr.registry: scheme helpers", () => {
  describe("getCDNOrigin", () => {
    test("npm: resolves to npm registry origin", () => {
      expect(getCDNOrigin("npm:react")).toBe("https://registry.npmjs.org/");
    });

    test("npm.registry: resolves to npm registry origin", () => {
      expect(getCDNOrigin("npm.registry:react")).toBe("https://registry.npmjs.org/");
    });

    test("npm: and npm.registry: resolve to the same origin", () => {
      expect(getCDNOrigin("npm:lodash@4")).toBe(getCDNOrigin("npm.registry:lodash@4"));
    });

    test("jsr.registry: resolves to jsr.io origin", () => {
      expect(getCDNOrigin("jsr.registry:@std/path")).toBe("https://jsr.io/");
    });

    test("jsr: and jsr.registry: resolve to the same origin", () => {
      expect(getCDNOrigin("jsr:@std/path")).toBe(getCDNOrigin("jsr.registry:@std/path"));
    });

    test("does not affect plain bare imports", () => {
      expect(getCDNOrigin("react")).toBe("https://unpkg.com/");
    });
  });

  describe("getPureImportPath", () => {
    test("strips npm: prefix", () => {
      expect(getPureImportPath("npm:react@18")).toBe("react@18");
    });

    test("strips npm.registry: prefix", () => {
      expect(getPureImportPath("npm.registry:react@18")).toBe("react@18");
    });

    test("strips jsr.registry: prefix", () => {
      expect(getPureImportPath("jsr.registry:@std/path@1.0.0")).toBe("@std/path@1.0.0");
    });

    test("strips jsr: prefix", () => {
      expect(getPureImportPath("jsr:@std/path@1.0.0")).toBe("@std/path@1.0.0");
    });

    test("scoped package with npm: prefix", () => {
      expect(getPureImportPath("npm:@tanstack/react-query@5.0.0")).toBe("@tanstack/react-query@5.0.0");
    });

    test("does not double-strip (no false partial matches)", () => {
      // "npm.registry:" should not leave ".registry:" behind
      expect(getPureImportPath("npm.registry:lodash")).toBe("lodash");
      // "jsr.registry:" should not leave ".registry:" behind
      expect(getPureImportPath("jsr.registry:@std/fs")).toBe("@std/fs");
    });
  });

  describe("getCDNUrl", () => {
    test("npm: generates correct URL with registry origin", () => {
      const result = getCDNUrl("npm:react@18.2.0");
      expect(result.origin).toBe("https://registry.npmjs.org/");
      expect(result.path).toBe("react@18.2.0");
      expect(result.url.href).toBe("https://registry.npmjs.org/react@18.2.0");
    });

    test("npm.registry: generates correct URL with registry origin", () => {
      const result = getCDNUrl("npm.registry:lodash@4.17.21");
      expect(result.origin).toBe("https://registry.npmjs.org/");
      expect(result.path).toBe("lodash@4.17.21");
      expect(result.url.href).toBe("https://registry.npmjs.org/lodash@4.17.21");
    });

    test("jsr.registry: generates correct URL with jsr.io origin", () => {
      const result = getCDNUrl("jsr.registry:@std/path@1.0.0");
      expect(result.origin).toBe("https://jsr.io/");
      expect(result.path).toBe("@std/path@1.0.0");
      expect(result.url.href).toBe("https://jsr.io/@std/path@1.0.0");
    });

    test("npm: and npm.registry: produce equivalent URLs", () => {
      const a = getCDNUrl("npm:react@18");
      const b = getCDNUrl("npm.registry:react@18");
      expect(a.url.href).toBe(b.url.href);
      expect(a.origin).toBe(b.origin);
    });

    test("jsr: and jsr.registry: produce equivalent URLs", () => {
      const a = getCDNUrl("jsr:@std/path@1.0.0");
      const b = getCDNUrl("jsr.registry:@std/path@1.0.0");
      expect(a.url.href).toBe(b.url.href);
      expect(a.origin).toBe(b.origin);
    });
  });
});