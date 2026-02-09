/**
 * Bundle Warnings Endpoint Definition
 *
 * GET /v1/bundle/warnings
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BundleQuerySchema } from '#shared/bundle/schema.ts'

export const QuerySchema = BundleQuerySchema

export default {
	Name: 'bundle-warnings',
	Route: '/v1/bundle/warnings',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
