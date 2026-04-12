/**
 * Cache Purge Handler
 *
 * GET/POST /v1/cache/purge
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '@utils/endpoint/types'

import { createValidator } from '@utils/middleware/validation'

import { ok, internalServerError } from '@utils/response'

import { parseInputToConfig } from '#shared/bundle/parse.ts'
import { generateCacheKey, getBadgeKey, getPackageResultKey } from '#shared/bundle/key.ts'
import { deleteCachedBadges, deleteCachedResult } from '#shared/cache/operations.ts'

import Definition from './definition.ts'

export type AppEnv = FunctionAppEnv

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
	createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async function (c) {
	try {
		const input = c.req.method === 'POST' ? await c.req.json() : c.req.valid('query')
		const { inputCode, config, versions, modules } = await parseInputToConfig(input, c.req.url)

		const jsonKey = await generateCacheKey(config, modules, versions, inputCode)
		const badgeKey = getBadgeKey(jsonKey)
		const moduleName = modules[0]?.[0]
		const packageKey = moduleName ? getPackageResultKey(moduleName, jsonKey) : null

		await deleteCachedResult(jsonKey)
		await deleteCachedBadges(badgeKey)

		if (packageKey) {
			await deleteCachedResult(packageKey)
		}

		if (!c.req.path.includes('/v1/')) {
			return new Response('Deleted from cache!', {
				status: 200,
				headers: {
					'Content-Type': 'text/plain',
					'x-content-type-options': 'nosniff',
				},
			})
		}

		return c.json(...ok({ deleted: true, jsonKey, badgeKey, packageKey }))
	} catch (error) {
		if (!c.req.path.includes('/v1/')) {
			return new Response('Error, deleting from cache', {
				status: 500,
				headers: {
					'Content-Type': 'text/plain',
					'x-content-type-options': 'nosniff',
				},
			})
		}

		return c.json(...internalServerError(
			c.req.path,
			error instanceof Error ? error.message : 'Cache purge failed'
		))
	}
}

export default Handler
