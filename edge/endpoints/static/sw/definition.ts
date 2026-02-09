/**
 * Service Worker Static Endpoint Definition
 *
 * GET /sw.js
 */

import type { EndpointDefinition } from '#shared/server/types.ts'
import { z } from 'zod'
import { BaseQuerySchema } from '#shared/server/schemas.ts'

export const QuerySchema = BaseQuerySchema

export default {
  Name: 'sw',
  Route: '/sw.js',
  Methods: ['GET'] as const,
  Input: QuerySchema,
  Output: z.any(),
  Schemas: {
    Query: QuerySchema,
  },
} as const satisfies EndpointDefinition
