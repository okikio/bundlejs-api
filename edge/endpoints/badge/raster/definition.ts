/**
 * Badge Raster Endpoint Definition
 *
 * GET /v1/badge/raster
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BundleQuerySchema } from '#shared/bundle/schema.ts'

export const QuerySchema = BundleQuerySchema

export default {
  Name: 'badge-raster',
  Route: '/v1/badge/raster',
  Methods: ['GET'] as const,
  Input: QuerySchema,
  Output: z.any(),
  Schemas: {
    Query: QuerySchema,
  },
} as const satisfies EndpointDefinition
