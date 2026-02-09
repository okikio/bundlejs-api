/**
 * Apple Touch Icon Precomposed Endpoint Definition
 *
 * GET /apple-touch-icon-precomposed.png
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BaseQuerySchema } from '#shared/server/schemas.ts'

export const QuerySchema = BaseQuerySchema

export default {
  Name: 'apple-touch-icon-precomposed',
  Route: '/apple-touch-icon-precomposed.png',
  Methods: ['GET'] as const,
  Input: QuerySchema,
  Output: z.any(),
  Schemas: {
    Query: QuerySchema,
  },
} as const satisfies EndpointDefinition
