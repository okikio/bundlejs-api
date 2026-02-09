/**
 * Favicon Static Handler
 *
 * GET /favicon.ico
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '#shared/server/types.ts'

import { createValidator } from '#shared/middleware/validation.ts'

import Definition from './definition.ts'

export type AppEnv = FunctionAppEnv

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
	createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = function () {
	return Response.redirect('https://bundlejs.com/favicon/favicon-api.ico')
}

export default Handler
