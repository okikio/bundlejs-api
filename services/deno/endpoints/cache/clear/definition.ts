/**
 * Cache Clear Endpoint Definition
 *
 * GET /v1/cache/clear
 */

import type { EndpointDefinition } from '@utils/endpoint/types'
import { BaseQuerySchema } from '@utils/endpoint/schemas'
import { z } from 'zod'

export const QuerySchema = BaseQuerySchema

export default {
	Name: 'cache-clear',
	Route: '/v1/cache/clear',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
