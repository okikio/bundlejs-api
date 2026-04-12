/**
 * Bundle File Endpoint Definition
 *
 * GET /v1/bundle/file
 */

import type { EndpointDefinition } from '@utils/endpoint/types'
import { z } from 'zod'
import { BundleQuerySchema } from '#shared/bundle/schema.ts'

export const QuerySchema = BundleQuerySchema

export default {
	Name: 'bundle-file',
	Route: '/v1/bundle/file',
	Methods: ['GET'] as const,
	Input: QuerySchema,
	Output: z.any(),
	Schemas: {
		Query: QuerySchema,
	},
} as const satisfies EndpointDefinition
