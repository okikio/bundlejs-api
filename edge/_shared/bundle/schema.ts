/**
 * Bundle Service Schemas
 *
 * Zod schemas for request validation and response typing.
 *
 * @module
 */
import { z } from 'zod'

// =============================================================================
// Query Parameter Schemas
// =============================================================================

/**
 * Schema for bundle query parameters.
 *
 * Validates the various query options supported by the bundle API.
 */
export const BundleQuerySchema = z.object({
	/** Module specifier(s) - comma-separated */
	q: z.string().optional(),
	query: z.string().optional(),

	/** Treeshake specification */
	treeshake: z.string().optional(),

	/** LZ-compressed code */
	share: z.string().optional(),

	/** Plain text code */
	text: z.string().optional(),

	/** JSON5 configuration */
	config: z.string().optional(),

	/** Enable JSX/TSX support */
	tsx: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),
	jsx: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),

	/** Enable polyfills */
	polyfill: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),

	/** Minify output */
	minify: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => (v === '' ? true : v === 'true' ? true : v === 'false' ? false : undefined)),

	/** Pretty (non-minified) output */
	pretty: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => (v === '' ? true : v === 'true' ? true : v === 'false' ? false : undefined)),

	/** Source map generation */
	sourcemap: z
		.union([z.literal(''), z.literal('true'), z.literal('false'), z.literal('inline'), z.literal('external'), z.literal('both')])
		.optional(),

	/** Output format */
	format: z.enum(['esm', 'cjs', 'iife']).optional(),

	/** Enable metafile output */
	metafile: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),

	/** Enable analysis output */
	analysis: z.string().optional(),
	analyze: z.string().optional(),

	/** Badge generation */
	badge: z.string().optional(),
	'badge-style': z.string().optional(),
	'badge-raster': z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),
	png: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),

	/** File output */
	file: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),

	/** Raw JSON output */
	raw: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),

	/** Cache control mode */
	cache: z.enum(['use', 'bypass', 'refresh']).optional(),

	/** Warnings output */
	warnings: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),
	warning: z
		.union([z.literal(''), z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === '' || v === 'true'),
})

export type BundleQuery = z.infer<typeof BundleQuerySchema>

// =============================================================================
// Response Schemas
// =============================================================================

/**
 * Schema for compression size information.
 */
export const CompressionSizeSchema = z.object({
	type: z.string(),
	uncompressedSize: z.string(),
	compressedSize: z.string(),
	rawUncompressedSize: z.number(),
	rawCompressedSize: z.number(),
})

/**
 * Schema for install size information.
 */
export const InstallSizeSchema = z.object({
	total: z.number().optional(),
	packages: z
		.array(
			z.object({
				name: z.string(),
				size: z.number(),
			})
		)
		.optional(),
})

/**
 * Schema for module specification.
 */
export const ModuleSpecSchema = z.tuple([
	z.string(), // specifier
	z.string(), // mode
])

/**
 * Schema for bundle result response.
 */
export const BundleResultSchema = z.object({
	query: z.string(),
	rawQuery: z.string(),
	config: z.record(z.string(), z.unknown()),
	input: z.string(),
	version: z.string().optional(),
	versions: z.array(z.string()).optional(),
	modules: z.array(ModuleSpecSchema).optional(),
	size: CompressionSizeSchema,
	installSize: InstallSizeSchema.optional(),
	time: z.string(),
	rawTime: z.number(),
	fileId: z.string().optional(),
	fileUrl: z.string().optional(),
	fileHTMLUrl: z.string().optional(),
	warnings: z.array(z.string()).optional(),
	metafile: z.record(z.string(), z.unknown()).optional(),
	cached: z.boolean().optional(),
})

export type BundleResultResponse = z.infer<typeof BundleResultSchema>

/**
 * Schema for error response.
 */
export const ErrorResponseSchema = z.object({
	error: z.string(),
})

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

// =============================================================================
// Documentation Schema
// =============================================================================

/**
 * Schema for API documentation (shown when no query provided).
 */
export const DocsSchema = z.object({
	docs: z.string(),
	examples: z.array(z.string()),
	basics: z.array(z.string()),
})

export type Docs = z.infer<typeof DocsSchema>

/**
 * API documentation content.
 */
export const API_DOCS: Docs = {
	docs: '/?docs - Takes you to some docs for the API',
	examples: [
		'(new) /?tsx or /?jsx',
		'(new) /?badge or /?badge=detailed or /?badge=minified',
		'(new) /?badge-style=for-the-badge',
		'(new) /?badge-raster',
		'(new) /?file',
		'(new) /?polyfill',
		'(new) /?analysis or /?analyze=verbose',
		'(new) /?metafile',
		'(new) /?minify=false',
		'(new) /?sourcemap=inline',
		'(new) /?format=iife',
		'(new) /?warnings',
		'(new) /?raw',
		'~~~',
		'/?q=spring-easing,(import)@okikio/emitter,(import)@okikio/animate,(import)@okikio/animate,(import)@okikio/animate,(import)@okikio/animate,@okikio/animate,typescript@beta,vue,react',
		'/?treeshake=[SpringEasing],[T],[{ animate }],[{ animate as B }],[* as TR],[{ type animate }],[*],[*],[*],[*]',
		'/?text="export * as PR18 from \\"@okikio/animate\\";\\nexport { animate as animate2 } from \\"@okikio/animate\\";"',
		'/?share=MYewdgziA2CmB00QHMAUAiAwiG6CUQA',
		'/?config={"cdn":"skypack","compression":"brotli","esbuild":{"format":"cjs","minify":false,"treeShaking":false}}',
	],
	basics: [
		'(new) /?tsx or /?jsx - Support JSX and TSX. Used to be built-in but decided to make it optional, as it caused errors in non TSX packages',
		'(new) /?badge - Generates a badge (if you want more details, set `?badge=detailed` (to list the modules being bundled in the badge) or `?badge=minified` for the minified bundle size)',
		'(new) /?badge-style - Various badge styles supported by http://shields.io (https://shields.io/#:~:text=PREFIX%3E%26suffix%3D%3CSUFFIX%3E-,Styles,-The%20following%20styles)',
		'(new) /?badge-raster - The badge but as a png image',
		'(new) /?file - Resulting bundled code(you can actually import this into your javascript file and start using it https://stackblitz.com/edit/vitejs-vite-iquaht?file=src%2Fmain.ts&terminal=dev)',
		'(new) /?polyfill - Polyfill Node built-ins',
		'(new) /?analysis or /?analyze - Esbuild generate visual analysis https://esbuild.github.io/api/#analyze',
		'(new) /?metafile - Esbuild bundle metafile which can be used w / https://esbuild.github.io/analyze/ (hoping to have this built-in in the future)',
		'(new) /?minify - Esbuild minify https://esbuild.github.io/api/#minify',
		'(new) /?sourcemap - Esbuild sourcemap https://esbuild.github.io/api/#source-maps',
		'(new) /?format - Esbuild format https://esbuild.github.io/api/#format',
		'(new) /?warnings - Lists warning for a particular bundle',
		'(new) /?raw - The raw result of the bundle (meant for experiments and/or testing)',
		'~~~',
		'/?q or /?query - Represents the module, e.g. react, vue, etc... You can add (import) in-front of a specific module to make it an import instead of an export',
		'/?treeshake - Represents the export/imports to treeshake. The treeshake syntax allows for specifying multiple exports per package (check the example above). The square brackets represent seperate packages, and everything inside the square brackets, are the exported methods, types, etc...',
		'/?text - Represents the input code as a string (it\'s meant for short strings, we recommend using `/?share` for longer strings)',
		'/?share - Represents `compressed` string version of the input code (it\'s used for large input code)',
		'/?config - Represents the configurations to use when building the bundle (the docs cover the config in detail https://blog.okikio.dev/documenting-an-online-bundler-bundlejs#heading-configuration)',
	],
}