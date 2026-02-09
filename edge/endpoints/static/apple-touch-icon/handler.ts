/**
 * Apple Touch Icon Static Handler
 *
 * GET /apple-touch-icon.png
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '#shared/server/types.ts'

import { createValidator } from '#shared/middleware/validation.ts'

import Definition from './definition.ts'

export type AppEnv = FunctionAppEnv

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
	createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = function () {
	return Response.redirect('https://bundlejs.com/favicon/apple-touch-icon.png')
}

export default Handler
