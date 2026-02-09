/**
 * Cache Clear Handler
 *
 * GET /v1/cache/clear
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '#shared/server/types.ts'

import { createValidator } from '#shared/middleware/validation.ts'

import { ok, internalServerError } from '#shared/response/mod.ts'
import { flushCacheAsync } from '#shared/cache/operations.ts'

import Definition from './definition.ts'

export type AppEnv = FunctionAppEnv

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
	createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async function (c) {
	try {
		await flushCacheAsync()

		if (!c.req.path.includes('/v1/')) {
			return new Response('Started clearing cache!', {
				status: 200,
				headers: {
					'Content-Type': 'text/plain',
					'x-content-type-options': 'nosniff',
				},
			})
		}

		return c.json(...ok({ cleared: true }))
	} catch (error) {
		if (!c.req.path.includes('/v1/')) {
			return new Response('Redis is unavailable, try again at a later date!', {
				status: 500,
				headers: {
					'Content-Type': 'text/plain',
					'x-content-type-options': 'nosniff',
				},
			})
		}

		return c.json(...internalServerError(
			c.req.path,
			error instanceof Error ? error.message : 'Cache clear failed'
		))
	}
}

export default Handler
