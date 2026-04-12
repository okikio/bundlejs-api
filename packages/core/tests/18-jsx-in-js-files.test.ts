/**
 * Scenario 18 — JSX in `.js` Files (React Native / Expo Ecosystem)
 *
 * Tests that `.js` files containing JSX syntax are correctly parsed by
 * upgrading the esbuild loader from `ts` to `tsx` based on content detection.
 *
 * React Native / Expo packages commonly ship `.js` files with JSX because
 * Metro bundler treats all `.js` as JSX-capable. Without content-aware
 * loader selection, esbuild fails with parse errors on these files.
 *
 * @see docs/scenarios/18-jsx-in-js-files.md
 * @module
 */

import { describe, test } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { inferLoader, containsJSX } from "../utils/loader.ts";

// =============================================================================
// Helper: encode a string to Uint8Array (simulates fetched binary content)
// =============================================================================

const encoder = new TextEncoder();
const toBytes = (str: string): Uint8Array => encoder.encode(str);

// =============================================================================
// containsJSX — detection heuristic
// =============================================================================

describe("18 · JSX in .js Files", () => {

  // ---------------------------------------------------------------------------
  // 18.1–18.3 — containsJSX: string input
  // ---------------------------------------------------------------------------
  describe("containsJSX: string input", () => {
    test("detects closing JSX component tag", () => {
      const source = `
        import React from 'react';
        export const App = () => <div><Child /></div>;
      `;
      expect(containsJSX(source)).toBe(true);
    });

    test("detects closing HTML tag", () => {
      const source = `const el = <span>hello</span>;`;
      expect(containsJSX(source)).toBe(true);
    });

    test("detects JSX fragment closing </>", () => {
      const source = `const el = <><span>a</span></>;`;
      expect(containsJSX(source)).toBe(true);
    });

    test("detects uppercase component closing tag", () => {
      const source = `return <SQLiteProvider>{children}</SQLiteProvider>;`;
      expect(containsJSX(source)).toBe(true);
    });

    test("returns false for plain JS without JSX", () => {
      const source = `
        export const add = (a, b) => a + b;
        export const sub = (a, b) => a - b;
      `;
      expect(containsJSX(source)).toBe(false);
    });

    test("returns false for comparison operators", () => {
      // `a < b / c` has `</` but not followed by a letter or >
      const source = `const x = a < b / c;`;
      expect(containsJSX(source)).toBe(false);
    });

    test("returns false for empty string", () => {
      expect(containsJSX("")).toBe(false);
    });

    test("returns false for regex-like patterns without letters", () => {
      // `</` followed by a space — doesn't match
      const source = `const re = /</ ;`;
      expect(containsJSX(source)).toBe(false);
    });

    test("detects </tag> inside a line comment (harmless false positive)", () => {
      // `// renders </div>` has `</d` which matches — this is a false positive
      // but harmless because the tsx loader is a safe superset of ts for .js files
      const source = `// renders </div> at the end\nexport const x = 42;`;
      expect(containsJSX(source)).toBe(true);
    });

    test("detects </tag> inside a block comment (harmless false positive)", () => {
      const source = `/* TODO: fix </Component> rendering */\nexport default 42;`;
      expect(containsJSX(source)).toBe(true);
    });

    test("returns false for comment without JSX-like content", () => {
      const source = `// this is a normal comment\n/* nothing special here */\nexport const y = 1;`;
      expect(containsJSX(source)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 18.9 — containsJSX: Uint8Array input (byte-level scan)
  // ---------------------------------------------------------------------------
  describe("containsJSX: Uint8Array input", () => {
    test("detects closing tag in bytes", () => {
      const bytes = toBytes(`<div></div>`);
      expect(containsJSX(bytes)).toBe(true);
    });

    test("detects fragment closing in bytes", () => {
      const bytes = toBytes(`<></>`);
      expect(containsJSX(bytes)).toBe(true);
    });

    test("returns false for plain JS bytes", () => {
      const bytes = toBytes(`export const x = 42;`);
      expect(containsJSX(bytes)).toBe(false);
    });

    test("matches string detection results", () => {
      const jsxSource = `return <Component>{children}</Component>;`;
      const plainSource = `export const pi = 3.14;`;

      // String and byte results must agree
      expect(containsJSX(jsxSource)).toBe(containsJSX(toBytes(jsxSource)));
      expect(containsJSX(plainSource)).toBe(containsJSX(toBytes(plainSource)));
    });
  });

  // ---------------------------------------------------------------------------
  // 18.10 — containsJSX: ArrayBuffer input
  // ---------------------------------------------------------------------------
  describe("containsJSX: ArrayBuffer input", () => {
    test("detects closing tag in ArrayBuffer", () => {
      const buf = toBytes(`<div></div>`).buffer;
      expect(containsJSX(buf)).toBe(true);
    });

    test("returns false for plain JS ArrayBuffer", () => {
      const buf = toBytes(`const x = 1;`).buffer;
      expect(containsJSX(buf)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 18.1 — inferLoader: .js with JSX → tsx
  // ---------------------------------------------------------------------------
  describe("inferLoader: JSX content upgrade", () => {
    test(".js with JSX content → tsx", () => {
      const content = `
        import React from 'react';
        export const App = () => <div>Hello</div>;
      `;
      expect(inferLoader("hooks.js", null, content)).toBe("tsx");
    });

    test(".js without JSX content → ts (no upgrade)", () => {
      const content = `export const add = (a, b) => a + b;`;
      expect(inferLoader("utils.js", null, content)).toBe("ts");
    });

    // -------------------------------------------------------------------------
    // 18.2 — .mjs with JSX → tsx
    // -------------------------------------------------------------------------
    test(".mjs with JSX content → tsx", () => {
      const content = `export const Greeting = ({ name }) => <h1>Hello {name}</h1>;`;
      expect(inferLoader("component.mjs", null, content)).toBe("tsx");
    });

    test(".mjs without JSX → ts", () => {
      const content = `export default function() { return 42; }`;
      expect(inferLoader("util.mjs", null, content)).toBe("ts");
    });

    // -------------------------------------------------------------------------
    // 18.3 — .cjs with JSX → tsx
    // -------------------------------------------------------------------------
    test(".cjs with JSX content → tsx", () => {
      const content = `module.exports = () => <span>CJS JSX</span>;`;
      expect(inferLoader("widget.cjs", null, content)).toBe("tsx");
    });

    test(".cjs without JSX → ts", () => {
      const content = `module.exports = { key: "value" };`;
      expect(inferLoader("config.cjs", null, content)).toBe("ts");
    });

    // -------------------------------------------------------------------------
    // 18.5 — .jsx stays tsx regardless of content
    // -------------------------------------------------------------------------
    test(".jsx → tsx even without content", () => {
      expect(inferLoader("file.jsx")).toBe("tsx");
    });

    test(".jsx → tsx with content", () => {
      expect(inferLoader("file.jsx", null, `export default 42;`)).toBe("tsx");
    });

    // -------------------------------------------------------------------------
    // 18.6 — .ts stays ts even with JSX-like content
    // -------------------------------------------------------------------------
    test(".ts → ts even with JSX-like content", () => {
      // This content has </T> which looks like a closing tag,
      // but .ts files must NEVER be upgraded to tsx
      const content = `const fn = <T>(x: T): Array<T> => [x];`;
      expect(inferLoader("generic.ts", null, content)).toBe("ts");
    });

    test(".tsx stays tsx", () => {
      expect(inferLoader("component.tsx")).toBe("tsx");
    });

    // -------------------------------------------------------------------------
    // 18.10 — No content preserves original behavior
    // -------------------------------------------------------------------------
    test(".js without content → ts (original behavior)", () => {
      expect(inferLoader("file.js")).toBe("ts");
    });

    test(".mjs without content → ts (original behavior)", () => {
      expect(inferLoader("file.mjs")).toBe("ts");
    });

    test(".cjs without content → ts (original behavior)", () => {
      expect(inferLoader("file.cjs")).toBe("ts");
    });

    // -------------------------------------------------------------------------
    // Other loaders remain unchanged
    // -------------------------------------------------------------------------
    test(".css → css (unaffected by content)", () => {
      expect(inferLoader("style.css", null, `div { color: red; }`)).toBe("css");
    });

    test(".json → json (unaffected by content)", () => {
      expect(inferLoader("data.json", null, `{"key": "value"}`)).toBe("json");
    });

    test(".svg → text (unaffected by content)", () => {
      expect(inferLoader("icon.svg", null, `<svg></svg>`)).toBe("text");
    });

    test(".wasm → file (unaffected by content)", () => {
      expect(inferLoader("module.wasm")).toBe("file");
    });

    // -------------------------------------------------------------------------
    // Comments containing JSX-like patterns (harmless false positives)
    // -------------------------------------------------------------------------
    test(".js with </tag> only in comment → tsx (harmless upgrade)", () => {
      // The file has no real JSX, only a comment mentioning </div>.
      // containsJSX triggers, but tsx loader parses the file correctly
      // since esbuild ignores comment contents.
      const content = `// See </div> for layout info\nexport const layout = "flex";`;
      expect(inferLoader("layout.js", null, content)).toBe("tsx");
    });

    test(".js with block comment mentioning JSX → tsx (harmless upgrade)", () => {
      const content = `/* Renders </Component> internally */\nmodule.exports = {};`;
      expect(inferLoader("mod.js", null, content)).toBe("tsx");
    });
  });

  // ---------------------------------------------------------------------------
  // inferLoader: Uint8Array content (end-to-end with binary input)
  // ---------------------------------------------------------------------------
  describe("inferLoader: binary content", () => {
    test(".js with JSX bytes → tsx", () => {
      const content = toBytes(`export const App = () => <div>Hello</div>;`);
      expect(inferLoader("app.js", null, content)).toBe("tsx");
    });

    test(".js with plain bytes → ts", () => {
      const content = toBytes(`export const x = 42;`);
      expect(inferLoader("util.js", null, content)).toBe("ts");
    });

    test(".mjs with JSX bytes → tsx", () => {
      const content = toBytes(`export const Foo = () => <span>Bar</span>;`);
      expect(inferLoader("foo.mjs", null, content)).toBe("tsx");
    });
  });

  // ---------------------------------------------------------------------------
  // Real-world content: expo-sqlite hooks.js excerpt
  // ---------------------------------------------------------------------------
  describe("real-world: expo-sqlite hooks.js", () => {
    const expoSqliteHooksExcerpt = `
import React, { createContext, memo, useContext, useEffect, useRef, useState } from 'react';
const SQLiteContext = createContext(null);
export const SQLiteProvider = memo(function SQLiteProvider({ children, onError, useSuspense = false, ...props }) {
    if (useSuspense) {
        return <SQLiteProviderSuspense {...props}>{children}</SQLiteProviderSuspense>;
    }
    return (<SQLiteProviderNonSuspense {...props} onError={onError}>
        {children}
      </SQLiteProviderNonSuspense>);
});
export function useSQLiteContext() {
    const context = useContext(SQLiteContext);
    if (context == null) {
        throw new Error('useSQLiteContext must be used within a <SQLiteProvider>');
    }
    return context;
}
function SQLiteProviderSuspense({ databaseName, children }) {
    return <SQLiteContext.Provider value={null}>{children}</SQLiteContext.Provider>;
}
`;

    test("containsJSX detects JSX in expo-sqlite hooks.js", () => {
      expect(containsJSX(expoSqliteHooksExcerpt)).toBe(true);
    });

    test("inferLoader returns tsx for hooks.js with JSX content", () => {
      expect(inferLoader("hooks.js", null, expoSqliteHooksExcerpt)).toBe("tsx");
    });

    test("inferLoader returns tsx for URL path with JSX content", () => {
      expect(
        inferLoader(
          "https://unpkg.com/expo-sqlite@16.0.10/build/hooks.js",
          "application/javascript",
          expoSqliteHooksExcerpt,
        ),
      ).toBe("tsx");
    });

    test("inferLoader returns tsx for binary hooks.js content", () => {
      const bytes = toBytes(expoSqliteHooksExcerpt);
      expect(inferLoader("hooks.js", null, bytes)).toBe("tsx");
    });
  });
});
