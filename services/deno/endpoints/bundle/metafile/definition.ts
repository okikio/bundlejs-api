/**
 * Bundle Metafile Endpoint Definition
 *
 * GET /v1/bundle/metafile
 */

import type { EndpointDefinition } from '@utils/endpoint/types'
import { z } from 'zod'
import { BundleQuerySchema } from '#shared/bundle/schema.ts'

export const QuerySchema = BundleQuerySchema

export default {
	Name: 'bundle-metafile',
	Route: '/v1/bundle/metafile',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
