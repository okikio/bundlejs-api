/**
 * OpenAPI Static Handler
 *
 * GET /.well-known/openapi.yaml
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '#shared/server/types.ts'

import { createValidator } from '#shared/middleware/validation.ts'

import Definition from './definition.ts'

export type AppEnv = FunctionAppEnv

const OPENAPI_PATH = new URL('../../../static/.well-known/openapi.yaml', import.meta.url)

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
	createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async function () {
	const contents = await Deno.readFile(OPENAPI_PATH)
	return new Response(contents, {
		status: 200,
		headers: {
			'Content-Type': 'text/yaml',
			'Cache-Control': 'max-age=180, public',
		},
	})
}

export default Handler
