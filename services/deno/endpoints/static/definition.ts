/**
 * Public Static Asset Endpoint Definition
 *
 * GET /*
 */

import type { EndpointDefinition } from '@utils/endpoint/types'
import { z } from 'zod'
import { BaseQuerySchema } from '@utils/endpoint/schemas'

export const QuerySchema = BaseQuerySchema

export default {
	Name: 'static',
	Route: '/*',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
