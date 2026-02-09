/**
 * AI Plugin Static Endpoint Definition
 *
 * GET /.well-known/ai-plugin.json
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BaseQuerySchema } from '#shared/server/schemas.ts'

export const QuerySchema = BaseQuerySchema

export default {
	Name: 'plugin',
	Route: '/.well-known/ai-plugin.json',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
