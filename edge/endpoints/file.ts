/**
 * File endpoint - Return bundled JavaScript file.
 * 
 * GET /file - Returns the actual bundled code as JavaScript.
 * 
 * This allows direct import of bundled code:
 * ```ts
 * import { animate } from 'https://deno.bundlejs.com/file?q=@okikio/animate'
 * ```
 * 
 * Query parameters: Same as bundle endpoint.
 */

import type { Context } from 'hono'
import type { RedisVariables } from '../../_shared/middleware/redis.ts'

import { z } from 'zod'

import { BundleQuerySchema } from '../_schemas.ts'

// =============================================================================
// Definition
// =============================================================================

export const Definition = {
  Name: 'file',
  Route: '/file',
  Methods: ['GET'] as const,
  Input: BundleQuerySchema,
  Output: z.string(),
  Schemas: {
    Query: BundleQuerySchema,
  },
} as const

// =============================================================================
// Handler
// =============================================================================

type AppEnv = { Variables: RedisVariables }

export async function Handler(c: Context<AppEnv>): Promise<Response> {
  // For now, this is a placeholder that redirects to the bundle endpoint
  // The actual file serving requires gist storage integration
  // TODO: Implement full file serving with gist integration
  
  const url = new URL(c.req.url)
  
  return new Response('File endpoint not yet implemented. Use /?file query param on main endpoint.', {
    status: 501,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'text/plain',
    },
  })
}

export default Handler