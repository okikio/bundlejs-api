/**
 * Cache Purge Endpoint Definition
 *
 * GET/POST /v1/cache/purge
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BundleQuerySchema } from '#shared/bundle/schema.ts'

export const QuerySchema = BundleQuerySchema

export default {
	Name: 'cache-purge',
	Route: '/v1/cache/purge',
	Methods: ['GET', 'POST'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
