/**
 * LLMS Static Endpoint Definition
 *
 * GET /llms.txt
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BaseQuerySchema } from '#shared/server/schemas.ts'

export const QuerySchema = BaseQuerySchema

export default {
	Name: 'llms',
	Route: '/llms.txt',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
