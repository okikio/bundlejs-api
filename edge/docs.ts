/**
 * Help payload embedded into the default JSON response.
 *
 * Behavior note:
 * - `edge/generate-result.ts` (Deno) and `cloudflare/src/result.ts` (Workers)
 *   attach this object when the request has no query string (`url.search === ''`).
 * - Centralizing this keeps the docs output identical across runtimes.
 */
export const docs = {
  docs: `/?docs - Takes you to some docs for the API`,
  examples: [
    "(new) /?tsx or /?jsx",
    "(new) /?badge or /?badge=detailed or /?badge=minified",
    "(new) /?badge-style=for-the-badge",
    "(new) /?badge-raster",
    "(new) /?file",
    "(new) /?polyfill",
    `(new) /?analysis or /?analyze=verbose`,
    "(new) /?metafile",
    `(new) /?minify=false`,
    `(new) /?sourcemap=inline`,
    `(new) /?format=iife`,
    `(new) /?warnings`,
    `(new) /?raw`,
    "~~~",
    `/?q=spring-easing,(import)@okikio/emitter,(import)@okikio/animate,(import)@okikio/animate,(import)@okikio/animate,(import)@okikio/animate,(import)@okikio/animate,@okikio/animate,typescript@beta,vue,react`,
    `/?treeshake=[SpringEasing],[T],[{ animate }],[{ animate as B }],[* as TR],[{ type animate }],[*],[*],[*],[*]`,
    `/?text="export * as PR18 from \"@okikio/animate\";\nexport { animate as animate2 } from \"@okikio/animate\";"`,
    `/?share=MYewdgziA2CmB00QHMAUAiAwiG6CUQA`,
    `/?config={"cdn":"skypack","compression":"brotli","esbuild":{"format":"cjs","minify":false,"treeShaking":false}}`
  ],
  basics: [
    "(new) /?tsx or /?jsx - Support JSX and TSX. Used to be built-in but decided to make it optional, as it caused errors in non TSX packages",
    `(new) /?badge - Generates a badge (if you want more details, set \`?badge=detailed\` (to list the modules being bundled in the badge) or \`?badge=minified\` for the minified bundle size)`,
    `(new) /?badge-style - Various badge styles supported by http://shields.io (https://shields.io/#:~:text=PREFIX%3E%26suffix%3D%3CSUFFIX%3E-,Styles,-The%20following%20styles)`,
    `(new) /?badge-raster - The badge but as a png image`,
    `(new) /?file - Resulting bundled code(you can actually import this into your javascript file and start using it https://stackblitz.com/edit/vitejs-vite-iquaht?file=src%2Fmain.ts&terminal=dev)`,
    `(new) /?polyfill - Polyfill Node built-ins`,
    `(new) /?analysis or /?analyze - Esbuild generate visual analysis https://esbuild.github.io/api/#analyze`,
    `(new) /?metafile - Esbuild bundle metafile which can be used w / https://esbuild.github.io/analyze/ (hoping to have this built-in in the future)`,
    `(new) /?minify - Esbuild minify https://esbuild.github.io/api/#minify`,
    `(new) /?sourcemap - Esbuild sourcemap https://esbuild.github.io/api/#source-maps`,
    `(new) /?format - Esbuild format https://esbuild.github.io/api/#format`,
    `(new) /?warnings - Lists warning for a particular bundle`,
    `(new) /?raw - The raw result of the bundle (meant for experiments and/or testing)`,
    "~~~",
    `/?q or /?query - Represents the module, e.g. react, vue, etc... You can add (import) in-front of a specific module to make it an import instead of an export`,
    `/?treeshake - Represents the export/imports to treeshake. The treeshake syntax allows for specifying multiple exports per package (check the example above). The square brackets represent seperate packages, and everything inside the square brackets, are the exported methods, types, etc...`,
    `/?text - Represents the input code as a string (it's meant for short strings, we recommend using \`/?share\` for longer strings)`,
    `/?share - Represents \`compressed\` string version of the input code (it's used for large input code)`,
    `/?config - Represents the configurations to use when building the bundle (the docs cover the config in detail https://blog.okikio.dev/documenting-an-online-bundler-bundlejs#heading-configuration)`
  ]
} as const;
