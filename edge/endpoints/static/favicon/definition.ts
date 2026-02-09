/**
 * Favicon Static Endpoint Definition
 *
 * GET /favicon.ico
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BaseQuerySchema } from '#shared/server/schemas.ts'

export const QuerySchema = BaseQuerySchema

export default {
	Name: 'favicon',
	Route: '/favicon.ico',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
