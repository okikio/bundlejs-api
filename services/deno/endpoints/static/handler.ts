/**
 * Public Static Asset Handler
 *
 * Serves files from the repo's `public/` directory.
 */

import type { EndpointHandler, EndpointMiddlewareHandler, FunctionAppEnv } from '@utils/endpoint/types'
import { fileURLToPath } from 'node:url'
import { serveStatic } from 'hono/deno'

import type Definition from './definition.ts'

export type AppEnv = FunctionAppEnv

const PUBLIC_ROOT = fileURLToPath(new URL("../../../../public/", import.meta.url))
const staticHandler = serveStatic({ root: PUBLIC_ROOT })

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = []
export const Handler: EndpointHandler<AppEnv, typeof Definition> = (c, next) => {
	return staticHandler(c, next)
}

export default Handler
