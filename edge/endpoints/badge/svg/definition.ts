/**
 * Badge SVG Endpoint Definition
 *
 * GET /v1/badge
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BundleQuerySchema } from '#shared/bundle/schema.ts'

export const QuerySchema = BundleQuerySchema

export default {
	Name: 'badge-svg',
	Route: '/v1/badge',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
