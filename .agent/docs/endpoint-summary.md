# Endpoint Examples

Complete, production-ready implementations for common endpoint patterns. Each example includes definition, handler, and usage notes.

---

# Complete Utilities Reference - Summary

This repository contains two comprehensive utility libraries:

## 1. Backend Utilities (`supabase/functions/_shared`)

**Purpose:** Server-side utilities for Supabase Edge Functions with Hono.js

**Key Modules:**
- **Execution** - Query execution (Supabase & SPARQL)
- **Middleware** - Auth, correlation, validation
- **Query** - Filtering, sorting, pagination, field selection
- **Response** - RFC 7807 problem details, success envelopes, status codes
- **Server** - App creation, endpoint types, schemas
- **Utils** - Client creation, config, environment

**Total Utilities:** ~200 functions, types, and schemas

**Documentation:** See `utility-signatures.md`

---

## 2. BundleJS Utilities (`core/`, `utils/`, `compress/`)

**Purpose:** Client-side bundling, transformation, and module resolution for modern JavaScript

**Key Modules:**

### Core (`core/`)
- **Build & Transform** - esbuild wrappers with enhanced features
- **Context System** - Global state management across plugins
- **Configuration** - Events, logging, platform detection
- **Plugins** - Alias, CDN, external, HTTP, filesystem
- **Utils** - CDN formatting, side effects, loaders

### Utils (`utils/`)
- **ANSI** - Terminal color rendering
- **Encoding** - Base64, hex, varint, etc.
- **JSR** - JSR registry integration
- **NPM** - Package spec parsing and search
- **Import Maps** - Generation and resolution
- **Builtins** - Node.js polyfills and externals
- **Media Types** - Content-Type parsing
- **LZ-String** - String compression

### Compress (`compress/`)
- Gzip, Brotli, Zstd, LZ4 compression
- Web Streams API integration

**Total Utilities:** 600+ exports across all modules

**Documentation:** See `bundlejs-utilities.md`

---

## Usage Patterns

### Backend (Server-Side)

```typescript
import {
  createApp,
  authUserMiddleware,
  createEndpointQuerySchema,
  queryCollectionWithCount,
  paginate,
  ok,
  badRequest,
} from '../_shared/mod.ts'

// Create Hono app with middleware
const app = createApp({
  serviceName: 'my-api',
  cors: true
})

// Define endpoint with query params
const QuerySchema = createEndpointQuerySchema({
  pagination: {
    strategy: 'cursor',
    defaultLimit: 20,
    maxLimit: 100,
    sortFields: ['created_at', 'id']
  },
  filters: {
    allowedFields: ['status', 'user_id'],
    registry: { /* ... */ }
  }
})

// Handle request
app.get('/items', authUserMiddleware, async (c) => {
  const spec = c.req.valid('query')
  const { data, error, count } = await queryCollectionWithCount(
    c.var.adminClient,
    'items',
    spec,
    'exact'
  )
  
  if (error) return badRequest(error.message)
  
  return paginate(data, spec.pagination!, {
    count,
    baseUrl: c.req.url,
    sortFields: ['created_at'],
    idField: 'id',
    secret: 'cursor-secret',
    ttl: 3600
  })
})
```

### BundleJS (Client-Side)

```typescript
import {
  build,
  transform,
  createConfig,
  Context,
  AliasPlugin,
  HttpPlugin,
  compress,
  getCDNUrl,
  parseJSRSpec,
  resolveImportMap,
  createLogger,
} from '@bundle/core'

// Create context
const ctx = new Context({
  aliases: {
    'react': 'https://esm.sh/react@18'
  }
})

// Create logger
const logger = createLogger({ name: 'bundler' })

// Build with plugins
const result = await build(createConfig('build', {
  entryPoints: ['./src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  plugins: [
    AliasPlugin(ctx),
    HttpPlugin()
  ]
}))

// Compress output
const compressed = await compress(
  result.outputFiles.map(f => f.contents),
  'brotli'
)

logger.info('Build complete:', {
  size: compressed.compressedSize
})
```

---

## File Organization

```
docs/
├── utility-signatures.md     # Backend utilities (Supabase/Hono)
└── bundlejs-utilities.md     # BundleJS utilities (bundler/tooling)
```

---

## Key Differences

| Feature | Backend Utils | BundleJS Utils |
|---------|--------------|----------------|
| Runtime | Deno (server) | Browser/Node/Deno |
| Purpose | API development | Module bundling |
| Main Use | HTTP endpoints | JavaScript transformation |
| Key Tech | Supabase, Hono, Zod | esbuild, CDN resolution |
| Architecture | Middleware + handlers | Plugins + context |

---

## Common Patterns

### Both use:
- **Context systems** - Shared state management
- **Type safety** - Heavy TypeScript usage with Zod schemas
- **Modularity** - Plugin/middleware architecture
- **Compression** - Data compression utilities
- **Event systems** - EventTarget-based pub/sub

### Backend-specific:
- **Query building** - SQL query construction
- **RFC 7807** - Problem details for errors
- **Cursor pagination** - Scalable pagination
- **RLS integration** - Row-level security

### BundleJS-specific:
- **CDN resolution** - Multi-CDN URL parsing
- **Import maps** - Module resolution
- **Node polyfills** - Runtime compatibility
- **Package parsing** - NPM/JSR spec handling

---

## Type Signatures Convention

All signatures follow Zod v4 patterns where applicable:

```typescript
// Schema definition
const Schema = z.object({
  field: z.string()
})

// Type inference
type Type = z.infer<typeof Schema>

// Input vs Output
type Input = z.input<typeof Schema>
type Output = z.output<typeof Schema>
```

---

## Next Steps

1. **Backend Development** → See `utility-signatures.md` for API endpoint utilities
2. **Frontend Tooling** → See `bundlejs-utilities.md` for bundling and CDN utilities
3. **Integration** → Combine both for full-stack TypeScript applications

---

**Total Coverage:** 800+ utilities across both libraries

---

## 1. Get Single Resource

Fetches a single resource by ID with ownership validation.

### Definition

```typescript
// endpoints/comics/get/definition.ts
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'

const ParamSchema = z.object({
  id: z.string().uuid(),
})

const QuerySchema = z.object({
  include: z.enum(['creator', 'series', 'all']).optional(),
})

const OutputSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  issue_number: z.number().nullable(),
  cover_url: z.string().url().nullable(),
  price: z.number().nullable(),
  status: z.enum(['draft', 'published', 'archived']),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  // Optional expansions
  creator: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }).nullable().optional(),
  series: z.object({
    id: z.string().uuid(),
    title: z.string(),
  }).nullable().optional(),
})

export default {
  Name: 'get-comic',
  Route: '/comics/:id',
  Methods: ['GET'],
  Input: ParamSchema.merge(QuerySchema),
  Output: OutputSchema,
  Schemas: {
    Param: ParamSchema,
    Query: QuerySchema,
  },
} satisfies EndpointDefinition
```

### Handler

```typescript
// endpoints/comics/get/handler.ts
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { ok, notFound, internalServerError } from '#shared/response/index.ts'
import { getLogger } from '@logtape/logtape'
import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>
const logger = getLogger(['comics', 'get'])

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('param', Definition.Schemas.Param),
  createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const { id } = c.req.valid('param')
  const { include } = c.req.valid('query')

  try {
    // Build select based on include param
    let select = 'id, title, issue_number, cover_url, price, status, created_at, updated_at'
    
    if (include === 'creator' || include === 'all') {
      select += ', creator:creators(id, name)'
    }
    if (include === 'series' || include === 'all') {
      select += ', series:comic_series(id, title)'
    }

    const { data, error } = await supabase
      .schema('public')
      .from('comics')
      .select(select)
      .eq('id', id)
      .eq('user_id', user.id)  // ownership check
      .single()

    if (error?.code === 'PGRST116') {
      return c.json(...notFound(c.req.path, 'Comic not found'))
    }

    if (error) {
      logger.error('Failed to fetch comic', { id, error: error.message })
      return c.json(...internalServerError(c.req.path))
    }

    return c.json(...ok(data))
  } catch (error) {
    logger.fatal('Unhandled error in get-comic', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}

export default Handler
```

### Usage

```bash
# Basic fetch
GET /comics/550e8400-e29b-41d4-a716-446655440000

# With creator expansion
GET /comics/550e8400-e29b-41d4-a716-446655440000?include=creator

# With all expansions
GET /comics/550e8400-e29b-41d4-a716-446655440000?include=all
```

---

## 2. Update Resource (PATCH)

Partial update with ownership validation and optimistic locking.

### Definition

```typescript
// endpoints/comics/update/definition.ts
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'

const ParamSchema = z.object({
  id: z.string().uuid(),
})

const JsonSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  issue_number: z.number().int().positive().nullable().optional(),
  cover_url: z.string().url().nullable().optional(),
  price: z.number().positive().nullable().optional(),
  status: z.enum(['draft', 'published', 'archived']).optional(),
}).refine(
  obj => Object.values(obj).some(v => v !== undefined),
  { message: 'At least one field must be provided' }
)

const OutputSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  issue_number: z.number().nullable(),
  cover_url: z.string().url().nullable(),
  price: z.number().nullable(),
  status: z.enum(['draft', 'published', 'archived']),
  updated_at: z.string().datetime(),
})

export default {
  Name: 'update-comic',
  Route: '/comics/:id',
  Methods: ['PATCH'],
  Input: ParamSchema.merge(JsonSchema),
  Output: OutputSchema,
  Schemas: {
    Param: ParamSchema,
    Json: JsonSchema,
  },
} satisfies EndpointDefinition
```

### Handler

```typescript
// endpoints/comics/update/handler.ts
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { ok, notFound, conflict, internalServerError } from '#shared/response/index.ts'
import { getLogger } from '@logtape/logtape'
import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>
const logger = getLogger(['comics', 'update'])

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('param', Definition.Schemas.Param),
  createValidator('json', Definition.Schemas.Json),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const { id } = c.req.valid('param')
  const updates = c.req.valid('json')

  try {
    // Remove undefined values (keep explicit nulls)
    const cleanUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    )

    const { data, error } = await supabase
      .schema('public')
      .from('comics')
      .update({
        ...cleanUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, title, issue_number, cover_url, price, status, updated_at')
      .single()

    if (error?.code === 'PGRST116') {
      return c.json(...notFound(c.req.path, 'Comic not found'))
    }

    if (error?.code === '23505') {
      return c.json(...conflict(c.req.path, 'Title already exists'))
    }

    if (error) {
      logger.error('Failed to update comic', { id, error: error.message })
      return c.json(...internalServerError(c.req.path))
    }

    logger.info('Comic updated', { id, fields: Object.keys(cleanUpdates) })
    return c.json(...ok(data))
  } catch (error) {
    logger.fatal('Unhandled error in update-comic', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}

export default Handler
```

### Usage

```bash
# Update title only
PATCH /comics/550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "title": "Updated Title"
}

# Update multiple fields
PATCH /comics/550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "title": "New Title",
  "price": 4.99,
  "status": "published"
}

# Set field to null
PATCH /comics/550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{
  "cover_url": null
}
```

---

## 3. Aggregate/Stats Endpoint

Returns aggregated statistics with optional filtering.

### Definition

```typescript
// endpoints/comics/stats/definition.ts
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'
import { createFiltersSchema } from '#shared/query/filters.ts'

const FiltersSchema = createFiltersSchema({
  registry: {
    status: {
      operators: ['eq', 'in'],
      type: 'enum',
      values: ['draft', 'published', 'archived'],
      arrayOperators: ['in'],
    },
    created_at: {
      operators: ['gt', 'gte', 'lt', 'lte'],
      type: 'date',
    },
  },
  limits: { maxFilters: 5 },
})

const QuerySchema = z.object({
  filters: FiltersSchema.optional(),
})

const OutputSchema = z.object({
  total: z.number(),
  by_status: z.record(z.string(), z.number()),
  price_stats: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
    avg: z.number().nullable(),
    sum: z.number().nullable(),
  }),
  date_range: z.object({
    oldest: z.string().datetime().nullable(),
    newest: z.string().datetime().nullable(),
  }),
})

export default {
  Name: 'comics-stats',
  Route: '/comics/stats',
  Methods: ['GET'],
  Input: QuerySchema,
  Output: OutputSchema,
  Schemas: {
    Query: QuerySchema,
  },
} satisfies EndpointDefinition
```

### Handler

```typescript
// endpoints/comics/stats/handler.ts
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { applyFilters } from '#shared/execution/supabase.ts'
import { ok, internalServerError } from '#shared/response/index.ts'
import { getLogger } from '@logtape/logtape'
import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>
const logger = getLogger(['comics', 'stats'])

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const { filters } = c.req.valid('query')

  try {
    // Base query scoped to user
    let query = supabase
      .schema('public')
      .from('comics')
      .select('status, price, created_at')
      .eq('user_id', user.id)

    // Apply optional filters
    if (filters) {
      query = applyFilters(query, filters)
    }

    const { data: comics, error } = await query

    if (error) {
      logger.error('Failed to fetch comics for stats', { error: error.message })
      return c.json(...internalServerError(c.req.path))
    }

    // Calculate aggregations
    const by_status: Record<string, number> = {}
    const prices: number[] = []
    const dates: Date[] = []

    for (const comic of comics) {
      // Count by status
      by_status[comic.status] = (by_status[comic.status] || 0) + 1

      // Collect prices (filter nulls)
      if (comic.price != null) {
        prices.push(comic.price)
      }

      // Collect dates
      dates.push(new Date(comic.created_at))
    }

    // Price stats
    const price_stats = {
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      avg: prices.length 
        ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 
        : null,
      sum: prices.length 
        ? Math.round(prices.reduce((a, b) => a + b, 0) * 100) / 100 
        : null,
    }

    // Date range
    const date_range = {
      oldest: dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))).toISOString() : null,
      newest: dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))).toISOString() : null,
    }

    return c.json(...ok({
      total: comics.length,
      by_status,
      price_stats,
      date_range,
    }))
  } catch (error) {
    logger.fatal('Unhandled error in comics-stats', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}

export default Handler
```

### Usage

```bash
# All comics stats
GET /comics/stats

# Stats for published comics only
GET /comics/stats?filter[status]=published

# Stats for comics created this year
GET /comics/stats?filter[created_at][gte]=2025-01-01
```

---

## 4. Batch Operations

Create or modify multiple resources in a single request.

### Definition

```typescript
// endpoints/comics/batch/definition.ts
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'

const ComicInput = z.object({
  title: z.string().min(1).max(200),
  issue_number: z.number().int().positive().nullable().optional(),
  price: z.number().positive().nullable().optional(),
  status: z.enum(['draft', 'published']).default('draft'),
})

const JsonSchema = z.object({
  comics: z.array(ComicInput).min(1).max(100),
})

const OutputSchema = z.object({
  created: z.number(),
  failed: z.number(),
  results: z.array(z.object({
    index: z.number(),
    success: z.boolean(),
    id: z.string().uuid().optional(),
    error: z.string().optional(),
  })),
})

export default {
  Name: 'batch-create-comics',
  Route: '/comics/batch',
  Methods: ['POST'],
  Input: JsonSchema,
  Output: OutputSchema,
  Schemas: {
    Json: JsonSchema,
  },
} satisfies EndpointDefinition
```

### Handler

```typescript
// endpoints/comics/batch/handler.ts
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { ok, internalServerError } from '#shared/response/index.ts'
import { getLogger } from '@logtape/logtape'
import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>
const logger = getLogger(['comics', 'batch'])

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('json', Definition.Schemas.Json),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const { comics } = c.req.valid('json')

  try {
    const results: Array<{
      index: number
      success: boolean
      id?: string
      error?: string
    }> = []

    // Process in batches of 10 for performance
    const batchSize = 10
    for (let i = 0; i < comics.length; i += batchSize) {
      const batch = comics.slice(i, i + batchSize)
      
      const rows = batch.map(comic => ({
        user_id: user.id,
        title: comic.title,
        issue_number: comic.issue_number ?? null,
        price: comic.price ?? null,
        status: comic.status,
      }))

      const { data, error } = await supabase
        .schema('public')
        .from('comics')
        .insert(rows)
        .select('id')

      if (error) {
        // Batch failed - mark all as failed
        for (let j = 0; j < batch.length; j++) {
          results.push({
            index: i + j,
            success: false,
            error: error.message,
          })
        }
      } else {
        // Batch succeeded
        for (let j = 0; j < data.length; j++) {
          results.push({
            index: i + j,
            success: true,
            id: data[j].id,
          })
        }
      }
    }

    const created = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length

    logger.info('Batch create completed', { created, failed, total: comics.length })

    return c.json(...ok({
      created,
      failed,
      results,
    }))
  } catch (error) {
    logger.fatal('Unhandled error in batch-create-comics', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}

export default Handler
```

### Usage

```bash
POST /comics/batch
Content-Type: application/json

{
  "comics": [
    { "title": "Amazing Spider-Man #1", "price": 3.99 },
    { "title": "Batman #1", "price": 4.99, "status": "published" },
    { "title": "X-Men #1", "issue_number": 1 }
  ]
}
```

**Response:**
```json
{
  "data": {
    "created": 3,
    "failed": 0,
    "results": [
      { "index": 0, "success": true, "id": "abc-123" },
      { "index": 1, "success": true, "id": "def-456" },
      { "index": 2, "success": true, "id": "ghi-789" }
    ]
  },
  "meta": { "timestamp": "2025-02-03T12:00:00Z" }
}
```

---

## 5. Collection with Nested Resource

Add item to a collection (path param + body).

### Definition

```typescript
// endpoints/collections/add-item/definition.ts
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'

const ParamSchema = z.object({
  collectionId: z.string().uuid(),
})

const JsonSchema = z.object({
  comicId: z.string().uuid(),
  position: z.number().int().min(0).optional(),
  notes: z.string().max(500).optional(),
})

const OutputSchema = z.object({
  id: z.string().uuid(),
  collection_id: z.string().uuid(),
  comic_id: z.string().uuid(),
  position: z.number(),
  notes: z.string().nullable(),
  added_at: z.string().datetime(),
})

export default {
  Name: 'add-collection-item',
  Route: '/collections/:collectionId/items',
  Methods: ['POST'],
  Input: ParamSchema.merge(JsonSchema),
  Output: OutputSchema,
  Schemas: {
    Param: ParamSchema,
    Json: JsonSchema,
  },
} satisfies EndpointDefinition
```

### Handler

```typescript
// endpoints/collections/add-item/handler.ts
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { created, notFound, conflict, forbidden, internalServerError } from '#shared/response/index.ts'
import { getLogger } from '@logtape/logtape'
import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>
const logger = getLogger(['collections', 'add-item'])

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('param', Definition.Schemas.Param),
  createValidator('json', Definition.Schemas.Json),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const { collectionId } = c.req.valid('param')
  const { comicId, position, notes } = c.req.valid('json')

  try {
    // Verify collection exists and user owns it
    const { data: collection, error: collectionError } = await supabase
      .schema('public')
      .from('collections')
      .select('id, user_id')
      .eq('id', collectionId)
      .single()

    if (collectionError?.code === 'PGRST116' || !collection) {
      return c.json(...notFound(c.req.path, 'Collection not found'))
    }

    if (collection.user_id !== user.id) {
      return c.json(...forbidden(c.req.path, 'Not your collection'))
    }

    // Verify comic exists
    const { data: comic } = await supabase
      .schema('public')
      .from('comics')
      .select('id')
      .eq('id', comicId)
      .single()

    if (!comic) {
      return c.json(...notFound(c.req.path, 'Comic not found'))
    }

    // Get next position if not provided
    let finalPosition = position
    if (finalPosition === undefined) {
      const { data: maxPos } = await supabase
        .schema('public')
        .from('collection_items')
        .select('position')
        .eq('collection_id', collectionId)
        .order('position', { ascending: false })
        .limit(1)
        .single()

      finalPosition = (maxPos?.position ?? -1) + 1
    }

    // Add item
    const { data, error } = await supabase
      .schema('public')
      .from('collection_items')
      .insert({
        collection_id: collectionId,
        comic_id: comicId,
        position: finalPosition,
        notes: notes ?? null,
      })
      .select('id, collection_id, comic_id, position, notes, created_at')
      .single()

    if (error?.code === '23505') {
      return c.json(...conflict(c.req.path, 'Comic already in collection'))
    }

    if (error) {
      logger.error('Failed to add collection item', { error: error.message })
      return c.json(...internalServerError(c.req.path))
    }

    logger.info('Added item to collection', { collectionId, comicId })

    return c.json(...created(
      { ...data, added_at: data.created_at },
      `/collections/${collectionId}/items/${data.id}`
    ))
  } catch (error) {
    logger.fatal('Unhandled error in add-collection-item', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}

export default Handler
```

### Usage

```bash
POST /collections/550e8400-e29b-41d4-a716-446655440000/items
Content-Type: application/json

{
  "comicId": "660e8400-e29b-41d4-a716-446655440001",
  "position": 0,
  "notes": "First appearance of Spider-Man"
}
```

---

## 6. List with Full Query Support

Complete paginated list with filtering, sorting, and field selection.

### Definition

```typescript
// endpoints/comics/list/definition.ts
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'
import { createEndpointQuerySchema } from '#shared/query/query.ts'
import { CURSOR_SECRET } from './_env.ts'

const QuerySchema = createEndpointQuerySchema({
  filters: {
    registry: {
      status: {
        operators: ['eq', 'ne', 'in'],
        type: 'enum',
        values: ['draft', 'published', 'archived'],
        arrayOperators: ['in'],
      },
      title: {
        operators: ['eq', 'contains', 'icontains', 'startswith'],
        type: 'string',
      },
      price: {
        operators: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
        type: 'number',
      },
      issue_number: {
        operators: ['eq', 'gt', 'gte', 'lt', 'lte'],
        type: 'number',
      },
      created_at: {
        operators: ['gt', 'gte', 'lt', 'lte'],
        type: 'date',
      },
      series_id: {
        operators: ['eq', 'in', 'is_null'],
        type: 'uuid',
        arrayOperators: ['in'],
      },
    },
    limits: { maxFilters: 10 },
  },
  sorts: {
    tiebreaker: 'id',
    allowedFields: ['created_at', 'updated_at', 'title', 'price', 'issue_number', 'id'],
    defaults: [{ field: 'created_at', direction: 'desc' }],
    limits: { maxSorts: 3 },
  },
  fields: {
    allowedFields: ['id', 'title', 'issue_number', 'cover_url', 'price', 'status', 'created_at', 'updated_at'],
    disabled: false,
  },
  pagination: {
    cursorSecret: CURSOR_SECRET,
    limits: { defaultLimit: 20, maxLimit: 100 },
  },
})

const ComicSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  issue_number: z.number().nullable(),
  cover_url: z.string().url().nullable(),
  price: z.number().nullable(),
  status: z.enum(['draft', 'published', 'archived']),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

const OutputSchema = z.array(ComicSchema)

export default {
  Name: 'list-comics',
  Route: '/comics',
  Methods: ['GET'],
  Input: QuerySchema,
  Output: OutputSchema,
  Schemas: {
    Query: QuerySchema,
  },
} satisfies EndpointDefinition
```

### Environment

```typescript
// endpoints/comics/list/_env.ts
export const CURSOR_SECRET = Deno.env.get('CURSOR_SECRET') ?? 'development-secret-change-me'
```

### Handler

```typescript
// endpoints/comics/list/handler.ts
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { queryCollectionWithCount, isErrorResponse } from '#shared/execution/supabase.ts'
import { buildPaginationMeta } from '#shared/query/pagination.ts'
import { paginate, withMeta } from '#shared/response/index.ts'
import { getLogger } from '@logtape/logtape'
import Definition from './definition.ts'
import { CURSOR_SECRET } from './_env.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>
const logger = getLogger(['comics', 'list'])

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const querySpec = c.req.valid('query')

  try {
    const result = await queryCollectionWithCount({
      supabase: supabase.schema('public'),
      table: 'comics',
      spec: querySpec,
      countStrategy: 'exact',
      baseFilters: [
        { field: 'user_id', operator: 'eq', value: user.id },
      ],
    })

    if (isErrorResponse(result)) {
      return c.json(...result)
    }

    const [{ data: rows, meta: { total } }] = result

    const paginationMeta = buildPaginationMeta({
      rows,
      query: querySpec,
      sortField: 'created_at',
      tiebreaker: 'id',
      direction: 'desc',
      secret: CURSOR_SECRET,
      total,
    })

    return c.json(...withMeta(
      paginate(c.req.url, paginationMeta.items, paginationMeta.pagination),
      { query: paginationMeta.query }
    ))
  } catch (error) {
    logger.fatal('Unhandled error in list-comics', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}

export default Handler
```

### Usage

```bash
# Basic list
GET /comics

# With pagination
GET /comics?limit=10

# With filtering
GET /comics?filter[status]=published&filter[price][lte]=5

# With sorting
GET /comics?sort=price:asc,title:asc

# With field selection
GET /comics?fields=id,title,price,status

# Complex query
GET /comics?filter[status][in]=draft,published&filter[price][gte]=2&sort=created_at:desc&limit=20&fields=id,title,price
```

---

## 7. Delete with Soft Delete Support

Delete with optional soft/hard delete modes.

### Definition

```typescript
// endpoints/comics/delete/definition.ts
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'

const ParamSchema = z.object({
  id: z.string().uuid(),
})

const QuerySchema = z.object({
  hard: z.coerce.boolean().default(false),
})

export default {
  Name: 'delete-comic',
  Route: '/comics/:id',
  Methods: ['DELETE'],
  Input: ParamSchema.merge(QuerySchema),
  Output: z.void(),
  Schemas: {
    Param: ParamSchema,
    Query: QuerySchema,
  },
} satisfies EndpointDefinition
```

### Handler

```typescript
// endpoints/comics/delete/handler.ts
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { noContent, notFound, internalServerError } from '#shared/response/index.ts'
import { getLogger } from '@logtape/logtape'
import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>
const logger = getLogger(['comics', 'delete'])

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('param', Definition.Schemas.Param),
  createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const { id } = c.req.valid('param')
  const { hard } = c.req.valid('query')

  try {
    if (hard) {
      // Hard delete - permanently remove
      const { error } = await supabase
        .schema('public')
        .from('comics')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id)

      if (error?.code === 'PGRST116') {
        return c.json(...notFound(c.req.path))
      }

      if (error) {
        logger.error('Failed to hard delete comic', { id, error: error.message })
        return c.json(...internalServerError(c.req.path))
      }

      logger.info('Comic hard deleted', { id })
    } else {
      // Soft delete - set deleted_at
      const { data, error } = await supabase
        .schema('public')
        .from('comics')
        .update({
          deleted_at: new Date().toISOString(),
          status: 'archived',
        })
        .eq('id', id)
        .eq('user_id', user.id)
        .is('deleted_at', null)  // Only delete if not already deleted
        .select('id')
        .single()

      if (error?.code === 'PGRST116' || !data) {
        return c.json(...notFound(c.req.path))
      }

      if (error) {
        logger.error('Failed to soft delete comic', { id, error: error.message })
        return c.json(...internalServerError(c.req.path))
      }

      logger.info('Comic soft deleted', { id })
    }

    return c.json(...noContent())
  } catch (error) {
    logger.fatal('Unhandled error in delete-comic', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}

export default Handler
```

### Usage

```bash
# Soft delete (default)
DELETE /comics/550e8400-e29b-41d4-a716-446655440000

# Hard delete (permanent)
DELETE /comics/550e8400-e29b-41d4-a716-446655440000?hard=true
```

---

## Registration Example

Complete registration for all example endpoints:

### mod.ts

```typescript
// functions/comics/mod.ts
import GetComicDef from './endpoints/comics/get/definition.ts'
import ListComicsDef from './endpoints/comics/list/definition.ts'
import UpdateComicDef from './endpoints/comics/update/definition.ts'
import DeleteComicDef from './endpoints/comics/delete/definition.ts'
import ComicsStatsDef from './endpoints/comics/stats/definition.ts'
import BatchCreateComicsDef from './endpoints/comics/batch/definition.ts'
import AddCollectionItemDef from './endpoints/collections/add-item/definition.ts'

export const EndpointDefinitions = {
  GetComic: GetComicDef,
  ListComics: ListComicsDef,
  UpdateComic: UpdateComicDef,
  DeleteComic: DeleteComicDef,
  ComicsStats: ComicsStatsDef,
  BatchCreateComics: BatchCreateComicsDef,
  AddCollectionItem: AddCollectionItemDef,
}
```

### index.ts

```typescript
// functions/comics/index.ts
import { createApp } from '#shared/server/create-app.ts'
import { EndpointDefinitions } from './mod.ts'

import * as GetComicHandler from './endpoints/comics/get/handler.ts'
import * as ListComicsHandler from './endpoints/comics/list/handler.ts'
import * as UpdateComicHandler from './endpoints/comics/update/handler.ts'
import * as DeleteComicHandler from './endpoints/comics/delete/handler.ts'
import * as ComicsStatsHandler from './endpoints/comics/stats/handler.ts'
import * as BatchCreateComicsHandler from './endpoints/comics/batch/handler.ts'
import * as AddCollectionItemHandler from './endpoints/collections/add-item/handler.ts'

const app = createApp({ serviceName: 'comics' })

const EndpointHandlers = {
  [EndpointDefinitions.GetComic.Name]: GetComicHandler,
  [EndpointDefinitions.ListComics.Name]: ListComicsHandler,
  [EndpointDefinitions.UpdateComic.Name]: UpdateComicHandler,
  [EndpointDefinitions.DeleteComic.Name]: DeleteComicHandler,
  [EndpointDefinitions.ComicsStats.Name]: ComicsStatsHandler,
  [EndpointDefinitions.BatchCreateComics.Name]: BatchCreateComicsHandler,
  [EndpointDefinitions.AddCollectionItem.Name]: AddCollectionItemHandler,
}

Object.values(EndpointDefinitions).forEach((endpoint) => {
  const handlerModule = EndpointHandlers[endpoint.Name]
  const middleware = handlerModule.Middleware ?? []
  const handler = handlerModule.default
  app.on(endpoint.Methods, endpoint.Route, ...middleware, handler)
})

Deno.serve(app.fetch)
```

