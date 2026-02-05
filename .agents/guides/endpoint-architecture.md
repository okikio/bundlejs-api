# Endpoint Architecture Reference

Backend utilities for Supabase Edge Functions using Hono framework with RFC 7807 error handling, cursor/offset pagination, and Standard Schema validation.

## Quick Reference

| Task | Import From | Key Function |
|------|-------------|--------------|
| Create Hono app | `#shared/server/create-app.ts` | `createApp()` |
| Define endpoint | `#shared/server/types.ts` | `EndpointDefinition` |
| Success response | `#shared/response/success.ts` | `ok()`, `created()`, `paginate()` |
| Error response | `#shared/response/errors.ts` | `notFound()`, `validationFailed()` |
| Auth middleware | `#shared/middleware/auth.ts` | `authUserMiddleware` |
| Validation | `#shared/middleware/validation.ts` | `createValidator()` |
| Query schema | `#shared/query/query.ts` | `createEndpointQuerySchema()` |
| Execute query | `#shared/execution/supabase.ts` | `queryCollectionWithCount()` |

---

## 1. Endpoint Structure

Each endpoint lives in its own folder with two files:

```
endpoints/
  {resource}/           # Plural noun (follows, comics, users)
    {action}/           # Verb or noun (list, check, create)
      definition.ts     # Schema contract
      handler.ts        # Business logic
      _env.ts           # Optional: cursor secrets
```

**Naming conventions:**
- Folders: lowercase, hyphens for multi-word
- Actions: Short, user-intent focused verbs
- Max depth: 2 levels (resource/action)

---

## 2. Definition Contract

The definition establishes the route, HTTP methods, and input/output schemas:

```typescript
import { z } from 'zod'
import type { EndpointDefinition } from '#shared/server/types.ts'

const QuerySchema = z.object({
  target_type: z.enum(['comic', 'series', 'creator']),
  target_id: z.string().uuid(),
})

const OutputSchema = z.object({
  following: z.boolean(),
  followed_at: z.string().datetime().nullable(),
})

export default {
  Name: 'check-follow',
  Route: '/follows/check',
  Methods: ['GET'],
  Input: QuerySchema,
  Output: OutputSchema,
  Schemas: {
    Query: QuerySchema,
  },
} satisfies EndpointDefinition
```

**Definition fields:**

| Field | Purpose |
|-------|---------|
| `Name` | Unique identifier for registration |
| `Route` | Path with params (`:id` syntax) |
| `Methods` | HTTP methods array |
| `Input` | Combined input schema (for typing) |
| `Output` | Response schema (for typing) |
| `Schemas.Query` | Query params schema |
| `Schemas.Json` | Request body schema |
| `Schemas.Param` | Path params schema |
| `Schemas.Header` | Header schema |

---

## 3. Handler Contract

Handlers export middleware and a default handler function:

```typescript
import type { EndpointHandler, EndpointMiddlewareHandler } from '#shared/server/types.ts'
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { createValidator } from '#shared/middleware/validation.ts'
import { ok, notFound } from '#shared/response/index.ts'
import Definition from './definition.ts'

type AppEnv = FunctionAppEnv<AuthUserVariables>

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('query', Definition.Schemas.Query),
]

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const user = c.get('user')
  const supabase = c.get('supabase')
  const { target_type, target_id } = c.req.valid('query')

  const { data, error } = await supabase
    .schema('public')
    .from('user_follows')
    .select('created_at')
    .eq('user_id', user.id)
    .eq('target_type', target_type)
    .eq('target_id', target_id)
    .maybeSingle()

  if (error) {
    return c.json(...internalServerError(c.req.path))
  }

  return c.json(...ok({
    following: !!data,
    followed_at: data?.created_at ?? null,
  }))
}

export default Handler
```

---

## 4. Middleware

### Execution Order

1. **Global** (applied by `createApp`):
   - `secureHeaders` → `correlation` → `requestId` → `CORS` → `logger` → `timing` → `prettyJSON`

2. **Endpoint-specific** (from handler's `Middleware` export):
   - Auth → Validation → Custom

### Auth Middleware

```typescript
import { authUserMiddleware } from '#shared/middleware/auth.ts'
import { authAdminMiddleware } from '#shared/middleware/auth.ts'

// For authenticated users
export const Middleware = [authUserMiddleware, ...]

// For admin-only endpoints
export const Middleware = [authAdminMiddleware, ...]
```

Auth middleware:
- Validates JWT from `Authorization: Bearer <token>`
- Attaches `user` and `supabase` (authenticated client) to context
- Returns 401 if invalid/missing token

### Validation Middleware

```typescript
import { createValidator } from '#shared/middleware/validation.ts'

export const Middleware = [
  createValidator('query', Definition.Schemas.Query),
  createValidator('json', Definition.Schemas.Json),
  createValidator('param', Definition.Schemas.Param),
]
```

Validation middleware:
- Uses Standard Schema adapter for Zod
- Returns RFC 7807 422 response on failure
- Makes validated data available via `c.req.valid('query'|'json'|'param')`

---

## 5. Response Utilities

### Success Responses

```typescript
import { ok, created, accepted, noContent, paginate } from '#shared/response/success.ts'

// 200 OK with data
return c.json(...ok({ id: '123', name: 'Alice' }))

// 201 Created with location header
return c.json(...created({ id: '123' }, '/users/123'))

// 202 Accepted for async operations
return c.json(...accepted({ jobId: 'abc' }))

// 204 No Content
return c.json(...noContent())

// Paginated response with Link headers
return c.json(...paginate(c.req.url, items, paginationMeta))
```

**Response envelope structure:**

```json
{
  "data": { "id": "123", "name": "Alice" },
  "meta": {
    "timestamp": "2025-02-03T12:00:00Z",
    "pagination": { ... },
    "query": { ... }
  }
}
```

### Error Responses

```typescript
import {
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  gone,
  validationFailed,
  internalServerError,
  exception,
} from '#shared/response/errors.ts'

// 400 Bad Request
return c.json(...badRequest(c.req.path, 'Invalid format'))

// 401 Unauthorized
return c.json(...unauthorized(c.req.path))

// 403 Forbidden
return c.json(...forbidden(c.req.path, 'Insufficient permissions'))

// 404 Not Found
return c.json(...notFound(c.req.path, 'User not found'))

// 409 Conflict
return c.json(...conflict(c.req.path, 'Already exists'))

// 410 Gone
return c.json(...gone(c.req.path, 'Resource deleted'))

// 422 Validation Failed (with field errors)
return c.json(...validationFailed(c.req.path, [
  { field: 'email', message: 'Invalid email format' },
  { field: 'age', message: 'Must be positive' },
]))

// 500 Internal Server Error
return c.json(...internalServerError(c.req.path))

// Throw HTTPException with RFC 7807 body
throw exception(notFound(c.req.path, 'Not found'))
```

**RFC 7807 error structure:**

```json
{
  "type": "https://errors.example.com/not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "User not found",
  "instance": "/users/123"
}
```

---

## 6. Query Processing

### Creating Query Schemas

For list endpoints with filtering, sorting, pagination, and field selection:

```typescript
import { createEndpointQuerySchema } from '#shared/query/query.ts'
import { CURSOR_SECRET } from './_env.ts'

const QuerySchema = createEndpointQuerySchema({
  filters: {
    registry: {
      status: {
        operators: ['eq', 'in'],
        type: 'enum',
        values: ['active', 'archived'],
        arrayOperators: ['in'],
      },
      created_at: {
        operators: ['gt', 'gte', 'lt', 'lte'],
        type: 'date',
      },
      price: {
        operators: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
        type: 'number',
      },
    },
    limits: { maxFilters: 10 },
  },
  sorts: {
    tiebreaker: 'id',
    allowedFields: ['created_at', 'name', 'id'],
    defaults: [{ field: 'created_at', direction: 'desc' }],
  },
  fields: {
    allowedFields: ['id', 'name', 'status', 'created_at'],
    disabled: false,
  },
  pagination: {
    cursorSecret: CURSOR_SECRET,
    limits: { defaultLimit: 50, maxLimit: 100 },
  },
})
```

### Filter Syntax (URL)

```
?filter[status]=active                           # eq (implicit)
?filter[price][gte]=50&filter[price][lte]=200    # range
?filter[status][in]=active,archived              # array
?filter[deleted_at]=null                         # is_null
```

### Sort Syntax

```
?sort=created_at:desc,name:asc
```

### Field Selection Syntax

```
?fields=id,name,status
?fields=*                                        # all allowed
```

### Pagination Syntax

```
?limit=20                                        # page size
?cursor=eyJzb3J0RmllbGQiOi...                    # cursor-based
?offset=40                                       # offset-based
```

---

## 7. Query Execution

### Basic Collection Query

```typescript
import { queryCollectionWithCount, isErrorResponse } from '#shared/execution/supabase.ts'
import { buildPaginationMeta } from '#shared/query/pagination.ts'

const result = await queryCollectionWithCount({
  supabase: supabase.schema('public'),
  table: 'user_follows',
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
```

### Count Strategies

| Strategy | Use When |
|----------|----------|
| `'exact'` | Need precise total, small tables |
| `'planned'` | Large tables, acceptable approximation |
| `'estimated'` | Very large tables, rough estimate OK |

---

## 8. Endpoint Registration

### Definition Registry (mod.ts)

```typescript
import CheckFollowDef from './endpoints/follows/check/definition.ts'
import ListFollowsDef from './endpoints/follows/list/definition.ts'
import CreateFollowDef from './endpoints/follows/follow/definition.ts'
import DeleteFollowDef from './endpoints/follows/unfollow/definition.ts'

export const EndpointDefinitions = {
  CheckFollow: CheckFollowDef,
  ListFollows: ListFollowsDef,
  CreateFollow: CreateFollowDef,
  DeleteFollow: DeleteFollowDef,
}
```

### Handler Registration (index.ts)

```typescript
import { createApp } from '#shared/server/create-app.ts'
import { EndpointDefinitions } from './mod.ts'

import * as CheckFollowHandler from './endpoints/follows/check/handler.ts'
import * as ListFollowsHandler from './endpoints/follows/list/handler.ts'
import * as CreateFollowHandler from './endpoints/follows/follow/handler.ts'
import * as DeleteFollowHandler from './endpoints/follows/unfollow/handler.ts'

const app = createApp({ serviceName: 'social' })

const EndpointHandlers = {
  [EndpointDefinitions.CheckFollow.Name]: CheckFollowHandler,
  [EndpointDefinitions.ListFollows.Name]: ListFollowsHandler,
  [EndpointDefinitions.CreateFollow.Name]: CreateFollowHandler,
  [EndpointDefinitions.DeleteFollow.Name]: DeleteFollowHandler,
}

Object.values(EndpointDefinitions).forEach((endpoint) => {
  const handlerModule = EndpointHandlers[endpoint.Name]
  const middleware = handlerModule.Middleware ?? []
  const handler = handlerModule.default
  app.on(endpoint.Methods, endpoint.Route, ...middleware, handler)
})

Deno.serve(app.fetch)
```

---

## 9. Error Handling

### Handler-Level Error Handling

```typescript
export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  try {
    // Business logic
    const { data, error } = await supabase.from('users').select()
    
    if (error) {
      logger.error('Database error', { error })
      return c.json(...internalServerError(c.req.path))
    }
    
    return c.json(...ok(data))
  } catch (error) {
    logger.fatal('Unhandled error', {
      error_type: error?.constructor?.name,
      message: error instanceof Error ? error.message : String(error),
    })
    return c.json(...internalServerError(c.req.path))
  }
}
```

### Error Propagation

1. **Validation errors**: Caught by validation middleware → 422
2. **HTTPException**: Caught by global error handler → RFC 7807 response
3. **Unexpected errors**: Caught by global error handler → 500

### Global Error Handler (in createApp)

```typescript
app.onError((_err, c) => {
  if (_err instanceof HTTPException && _err.res) {
    return _err.res
  }
  if (_err instanceof HTTPException) {
    return c.json(...err(_err.status, c.req.path, _err.message))
  }
  return c.json(...internalServerError(c.req.path))
})
```

---

## 10. Type System

### Environment Types

```typescript
import type { FunctionAppEnv, AuthUserVariables } from '#shared/server/create-app.ts'

// Standard authenticated endpoint
type AppEnv = FunctionAppEnv<AuthUserVariables>

// Context provides typed access
const user = c.get('user')           // User object
const supabase = c.get('supabase')   // Authenticated Supabase client
```

### Handler Type

```typescript
import type { EndpointHandler } from '#shared/server/types.ts'

export const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  // c.req.valid('query') returns z.infer<typeof Definition.Schemas.Query>
  const query = c.req.valid('query')
  
  // c.req.valid('json') returns z.infer<typeof Definition.Schemas.Json>
  const body = c.req.valid('json')
  
  // ...
}
```

### Middleware Type

```typescript
import type { EndpointMiddlewareHandler } from '#shared/server/types.ts'

export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  authUserMiddleware,
  createValidator('query', Definition.Schemas.Query),
]
```

---

## 11. Pagination Deep Dive

### Cursor-Based (Preferred)

Uses HMAC-signed tokens encoding position. Guarantees:
- Constant performance regardless of page depth
- No duplicates or skips when data changes
- Tamper-proof cursors

```typescript
// Cursor encodes:
{
  sortField: 'created_at',
  sortValue: '2025-01-15T10:00:00Z',
  tiebreaker: 'id',
  tiebreakerValue: 'abc-123',
  direction: 'desc'
}
```

### Offset-Based (When Needed)

Traditional page/offset approach. Use when:
- User needs to jump to specific page
- Total count display required
- Performance on deep pages acceptable

```typescript
?offset=100&limit=20
```

### Pagination Metadata

```typescript
{
  hasMore: true,
  limit: 20,
  count: 20,
  nextCursor: 'eyJzb3J0...',
  prevCursor: 'eyJzb3J0...',
  total: 1547,              // if requested
  approxTotal: 1500,        // if estimated
  expiresAt: '2025-02-03T13:00:00Z'
}
```

### Link Headers (RFC 8288)

Cursor pagination:
```
Link: </follows?cursor=abc>; rel="next", </follows?cursor=xyz>; rel="prev"
```

Offset pagination:
```
Link: </follows?offset=0>; rel="first", </follows?offset=20>; rel="next", </follows?offset=100>; rel="last"
```

---

## 12. Common Patterns

### Check Endpoint (Boolean Response)

```typescript
// GET /follows/check?target_type=comic&target_id=123
export const Handler = async (c) => {
  const { target_type, target_id } = c.req.valid('query')
  
  const { data } = await supabase
    .from('user_follows')
    .select('id')
    .eq('target_type', target_type)
    .eq('target_id', target_id)
    .maybeSingle()
  
  return c.json(...ok({ exists: !!data }))
}
```

### Create Endpoint (POST with Body)

```typescript
// POST /follows with JSON body
export const Handler = async (c) => {
  const { target_type, target_id } = c.req.valid('json')
  
  const { data, error } = await supabase
    .from('user_follows')
    .insert({ user_id: user.id, target_type, target_id })
    .select()
    .single()
  
  if (error?.code === '23505') {
    return c.json(...conflict(c.req.path, 'Already following'))
  }
  
  return c.json(...created(data, `/follows/${data.id}`))
}
```

### Delete Endpoint (Path Param)

```typescript
// DELETE /follows/:id
export const Handler = async (c) => {
  const { id } = c.req.valid('param')
  
  const { error } = await supabase
    .from('user_follows')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
  
  if (error) {
    return c.json(...notFound(c.req.path))
  }
  
  return c.json(...noContent())
}
```

### List Endpoint (Paginated)

```typescript
// GET /follows?filter[target_type]=comic&sort=created_at:desc&limit=20
export const Handler = async (c) => {
  const query = c.req.valid('query')
  
  const result = await queryCollectionWithCount({
    supabase: supabase.schema('public'),
    table: 'user_follows',
    spec: query,
    baseFilters: [{ field: 'user_id', operator: 'eq', value: user.id }],
  })
  
  if (isErrorResponse(result)) return c.json(...result)
  
  const [{ data: rows, meta: { total } }] = result
  const pagination = buildPaginationMeta({ rows, query, sortField: 'created_at', ... })
  
  return c.json(...paginate(c.req.url, pagination.items, pagination.pagination))
}
```

---

## 13. File Locations

```
supabase/functions/
  _shared/
    server/
      create-app.ts       # Hono app factory
      types.ts            # EndpointDefinition, EndpointHandler types
      schemas.ts          # Base schemas (BaseQuerySchema, etc.)
    middleware/
      auth.ts             # authUserMiddleware, authAdminMiddleware
      validation.ts       # createValidator()
      correlation.ts      # W3C Trace Context + LogTape
    response/
      success.ts          # ok(), created(), paginate()
      errors.ts           # notFound(), validationFailed(), etc.
      index.ts            # Re-exports
    query/
      query.ts            # createEndpointQuerySchema()
      filters.ts          # Filter parsing and validation
      sorts.ts            # Sort parsing and validation
      fields.ts           # Field selection
      pagination.ts       # Cursor/offset pagination
    execution/
      supabase.ts         # queryCollection(), queryCollectionWithCount()
      sparql.ts           # SPARQL execution (Neptune)
  {function-name}/
    index.ts              # Entry point, registration
    mod.ts                # Definition exports
    endpoints/
      {resource}/
        {action}/
          definition.ts
          handler.ts
          _env.ts         # Optional secrets
```

---

## 14. Checklist: New Endpoint

1. **Create folder**: `endpoints/{resource}/{action}/`
2. **Write definition.ts**: Route, methods, schemas
3. **Write handler.ts**: Middleware array + default handler
4. **Add to mod.ts**: Export definition
5. **Add to index.ts**: Import handler, register route
6. **Test**: Validation errors, success cases, edge cases