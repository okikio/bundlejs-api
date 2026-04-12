// endpoints/badge/svg/handler.ts
/**
 * Badge SVG Handler
 * 
 * GET /v1/badge
 * 
 * Generates shields.io badge from bundle size.
 * Handles:
 * - Bundle result lookup (cache or compute)
 * - Badge generation with timeout
 * - SVG response with caching headers
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '@utils/endpoint/types'
import type { CacheControlVariables } from '#shared/middleware/cache-control.ts'

import { createValidator } from '@utils/middleware/validation'
import { rateLimitMiddleware } from '#shared/middleware/rate-limit.ts'
import { cacheControlMiddleware } from '#shared/middleware/cache-control.ts'

import { badRequest } from '@utils/response'

import { resolveBundleRequest } from '#shared/bundle/request.ts'
import { generateLegacyResponse } from '#shared/bundle/legacy-response.ts'

import Definition from './definition.ts'

export type AppEnv = FunctionAppEnv<CacheControlVariables>

// ============================================================================
// MIDDLEWARE
// ============================================================================

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
	rateLimitMiddleware<AppEnv>({ windowMs: 60_000, limit: 300 }),
	cacheControlMiddleware,
	createValidator('query', Definition.Schemas.Query),
]

// ============================================================================
// HANDLER
// ============================================================================

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