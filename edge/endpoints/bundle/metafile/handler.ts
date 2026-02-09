/**
 * Bundle Metafile Handler
 *
 * GET /v1/bundle/metafile
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '#shared/server/types.ts'
import type { CacheControlVariables } from '#shared/middleware/cache-control.ts'

import { createValidator } from '#shared/middleware/validation.ts'
import { rateLimitMiddleware } from '#shared/middleware/rate-limit.ts'
import { cacheControlMiddleware } from '#shared/middleware/cache-control.ts'

import { badRequest } from '#shared/response/mod.ts'

import { resolveBundleRequest } from '#shared/bundle/request.ts'
import { generateLegacyResponse } from '#shared/bundle/legacy-response.ts'

import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<CacheControlVariables>

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
	rateLimitMiddleware<AppEnv>({ windowMs: 60_000, limit: 120 }),
	cacheControlMiddleware,
	createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async function (c) {
	const input = c.req.valid('query')
	const cacheMode = c.get('cacheMode') ?? 'use'

	const resolution = await resolveBundleRequest({
		input,
		baseUrl: c.req.url,
		cacheMode,
	})

	if (!resolution.inputCode && resolution.modules.length === 0) {
		return c.json(...badRequest(c.req.path, 'No modules or code provided'))
	}

	return await generateLegacyResponse({
		url: resolution.url,
		result: resolution.result,
		cached: resolution.cached,
		durationMs: resolution.durationMs,
		cacheKey: resolution.cacheKey,
	})
}

export default Handler
