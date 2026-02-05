# Endpoint Architecture Deep Dives

Advanced patterns, edge cases, and detailed explanations for areas that benefit from deeper coverage.

---

## 1. Complex Filter Combinations

### Multiple Operators on Same Field

When a field supports multiple operators, they combine with AND logic:

```
?filter[price][gte]=50&filter[price][lte]=200
```

Produces:
```sql
WHERE price >= 50 AND price <= 200
```

### Between Operator

For range queries, use the `between` operator with comma-separated values:

```
?filter[price][between]=50,200
```

**Filter registry setup:**
```typescript
price: {
  operators: ['eq', 'gt', 'gte', 'lt', 'lte', 'between'],
  type: 'number',
}
```

### Null Handling

Two ways to filter by null:

```
?filter[deleted_at]=null           # is_null (implicit)
?filter[deleted_at][is_null]=true  # explicit
?filter[email][is_not_null]=true   # not null
```

### Array Operators (IN / NOT IN)

```
?filter[status][in]=draft,review,published
?filter[category][nin]=archived,deleted
```

**Registry configuration:**
```typescript
status: {
  operators: ['eq', 'in', 'nin'],
  type: 'enum',
  values: ['draft', 'review', 'published', 'archived'],
  arrayOperators: ['in', 'nin'],  // Mark which operators accept arrays
}
```

### String Pattern Matching

```
?filter[name][contains]=smith
?filter[name][icontains]=Smith     # case-insensitive
?filter[email][startswith]=admin@
?filter[slug][endswith]=-draft
```

### Custom Filter Application

For complex filters that don't map directly to PostgREST:

```typescript
import { applyFilters } from '#shared/execution/supabase.ts'

// Standard application
const query = applyFilters(supabaseQuery, spec.filters)

// Custom handling for specific fields
const customApply = (query, filters) => {
  let q = query
  
  for (const filter of filters.normalized) {
    if (filter.field === 'full_text_search') {
      // Use PostgREST full-text search
      q = q.textSearch('search_vector', filter.value)
    } else if (filter.field === 'distance_km') {
      // Geographic filter via RPC
      q = q.rpc('nearby_items', { 
        lat: filter.value.lat, 
        lng: filter.value.lng, 
        radius_km: filter.value.radius 
      })
    } else {
      // Standard filter
      q = applyFilter(q, filter)
    }
  }
  
  return q
}
```

---

## 2. Correlation and Logging

### W3C Trace Context

The `correlationMiddleware` implements W3C Trace Context for distributed tracing:

```typescript
import { correlationMiddleware } from '#shared/middleware/correlation.ts'

// In createApp or endpoint middleware
app.use(correlationMiddleware('social-service'))
```

**Incoming headers:**
```
traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
tracestate: congo=t61rcWkgMzE
```

**Context available:**
```typescript
const traceId = c.get('traceId')      // Full trace context
const requestId = c.get('requestId')  // Request-specific ID
```

### LogTape Integration

Logs automatically include correlation IDs:

```typescript
import { getLogger } from '@logtape/logtape'

const logger = getLogger(['social', 'follows'])

// In handler
logger.info('Creating follow', {
  user_id: user.id,
  target_type,
  target_id,
  // traceId and requestId added automatically
})
```

**Log output:**
```json
{
  "level": "info",
  "message": "Creating follow",
  "category": ["social", "follows"],
  "properties": {
    "user_id": "abc-123",
    "target_type": "comic",
    "target_id": "xyz-789",
    "traceId": "0af7651916cd43dd8448eb211c80319c",
    "requestId": "req-456"
  }
}
```

### Structured Error Logging

```typescript
try {
  // operation
} catch (error) {
  logger.error('Operation failed', {
    error_type: error?.constructor?.name,
    error_message: error instanceof Error ? error.message : String(error),
    error_stack: error instanceof Error ? error.stack : undefined,
    operation: 'create_follow',
    input: { target_type, target_id },
  })
  
  return c.json(...internalServerError(c.req.path))
}
```

---

## 3. SPARQL Execution (Neptune)

For graph database queries using Amazon Neptune:

### Basic Query

```typescript
import { executeCollectionQuery } from '#shared/execution/sparql.ts'

const result = await executeCollectionQuery({
  endpoint: NEPTUNE_ENDPOINT,
  prefixes: {
    pop: 'http://popmodern.com/ontology#',
    schema: 'http://schema.org/',
  },
  select: ['?comic', '?title', '?releaseDate'],
  where: `
    ?comic a pop:Comic ;
           schema:name ?title ;
           schema:datePublished ?releaseDate .
    FILTER(?releaseDate >= "2024-01-01"^^xsd:date)
  `,
  spec: querySpec,
})
```

### Mapping QuerySpec to SPARQL

The execution layer translates QuerySpec to SPARQL:

**Filters:**
```typescript
// filter[status]=published
// Becomes:
FILTER(?status = "published")

// filter[price][gte]=50
// Becomes:
FILTER(?price >= 50)
```

**Sorts:**
```typescript
// sort=releaseDate:desc,title:asc
// Becomes:
ORDER BY DESC(?releaseDate) ASC(?title)
```

**Pagination:**
```typescript
// limit=20&offset=40
// Becomes:
LIMIT 20 OFFSET 40
```

### Error Mapping

SPARQL errors map to RFC 7807:

```typescript
// SPARQL timeout → 504 Gateway Timeout
// Malformed query → 400 Bad Request
// Neptune unavailable → 503 Service Unavailable
```

---

## 4. Update vs Replace Semantics

### PATCH (Partial Update)

Updates only provided fields, preserves others:

```typescript
// PATCH /users/:id
// Body: { "name": "New Name" }
// Only updates name, keeps email, avatar, etc.

const PatchSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  avatar_url: z.string().url().optional(),
}).refine(obj => Object.keys(obj).length > 0, {
  message: 'At least one field required',
})

export const Handler = async (c) => {
  const { id } = c.req.valid('param')
  const updates = c.req.valid('json')
  
  const { data, error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)  // ownership check
    .select()
    .single()
  
  if (error?.code === 'PGRST116') {
    return c.json(...notFound(c.req.path))
  }
  
  return c.json(...ok(data))
}
```

### PUT (Full Replace)

Replaces entire resource, unspecified fields become null/default:

```typescript
// PUT /users/:id
// Body: { "name": "New Name", "email": "new@example.com" }
// Replaces ALL fields

const PutSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  avatar_url: z.string().url().nullable(),
  bio: z.string().nullable(),
})

export const Handler = async (c) => {
  const { id } = c.req.valid('param')
  const replacement = c.req.valid('json')
  
  // First verify existence and ownership
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()
  
  if (!existing) {
    return c.json(...notFound(c.req.path))
  }
  
  // Full replace
  const { data, error } = await supabase
    .from('users')
    .update({
      name: replacement.name,
      email: replacement.email,
      avatar_url: replacement.avatar_url,
      bio: replacement.bio,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()
  
  return c.json(...ok(data))
}
```

### Decision Guide

| Use PATCH when | Use PUT when |
|----------------|--------------|
| Updating specific fields | Replacing entire resource |
| Client has partial data | Client has complete data |
| Preserving existing values | Resetting to provided state |
| Mobile/bandwidth constrained | Idempotency required |

---

## 5. Aggregation Endpoints

### Stats/Summary Endpoint

```typescript
// GET /comics/stats?filter[publisher]=marvel
// Returns: { total: 1547, by_status: {...}, avg_price: 4.99 }

const OutputSchema = z.object({
  total: z.number(),
  by_status: z.record(z.string(), z.number()),
  avg_price: z.number().nullable(),
  newest: z.string().datetime().nullable(),
  oldest: z.string().datetime().nullable(),
})

export const Handler = async (c) => {
  const { filters } = c.req.valid('query')
  
  // Build base query with filters
  let baseQuery = supabase.from('comics').select('*', { count: 'exact', head: true })
  if (filters) {
    baseQuery = applyFilters(baseQuery, filters)
  }
  
  // Get total count
  const { count: total } = await baseQuery
  
  // Get aggregations via RPC (more efficient)
  const { data: stats } = await supabase.rpc('comics_stats', {
    filter_publisher: filters?.find(f => f.field === 'publisher')?.value,
  })
  
  // Or compute in-app for simple cases
  const { data: allComics } = await supabase
    .from('comics')
    .select('status, price, created_at')
  
  const by_status = allComics.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1
    return acc
  }, {})
  
  const prices = allComics.map(c => c.price).filter(Boolean)
  const avg_price = prices.length 
    ? prices.reduce((a, b) => a + b, 0) / prices.length 
    : null
  
  const dates = allComics.map(c => new Date(c.created_at))
  
  return c.json(...ok({
    total,
    by_status,
    avg_price: avg_price ? Math.round(avg_price * 100) / 100 : null,
    newest: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    oldest: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
  }))
}
```

### Count-Only Endpoint

```typescript
// HEAD /comics or GET /comics/count
// Returns count without fetching data

export const Handler = async (c) => {
  const { filters } = c.req.valid('query')
  
  let query = supabase
    .from('comics')
    .select('*', { count: 'exact', head: true })
  
  if (filters) {
    query = applyFilters(query, filters)
  }
  
  const { count, error } = await query
  
  if (error) {
    return c.json(...internalServerError(c.req.path))
  }
  
  // Option 1: Return in body
  return c.json(...ok({ count }))
  
  // Option 2: Return in header only (for HEAD requests)
  return new Response(null, {
    status: 204,
    headers: { 'X-Total-Count': String(count) },
  })
}
```

---

## 6. Redirect Responses

### Temporary Redirect (302/307)

```typescript
import { redirect } from 'hono/utils/url'

// 302 Found (allows method change)
export const Handler = async (c) => {
  const { shortcode } = c.req.valid('param')
  
  const { data } = await supabase
    .from('short_urls')
    .select('target_url')
    .eq('shortcode', shortcode)
    .single()
  
  if (!data) {
    return c.json(...notFound(c.req.path))
  }
  
  // Track click
  await supabase.from('url_clicks').insert({ shortcode })
  
  return c.redirect(data.target_url, 302)
}

// 307 Temporary Redirect (preserves method)
return c.redirect(url, 307)
```

### Permanent Redirect (301/308)

```typescript
// 301 Moved Permanently (allows method change)
return c.redirect('/new/location', 301)

// 308 Permanent Redirect (preserves method)
return c.redirect('/new/location', 308)
```

### Custom Redirect with Headers

```typescript
return new Response(null, {
  status: 302,
  headers: {
    'Location': targetUrl,
    'Cache-Control': 'no-store',
    'X-Redirect-Reason': 'resource-moved',
  },
})
```

---

## 7. File Responses

### Return File Download

```typescript
// GET /exports/:id/download

export const Handler = async (c) => {
  const { id } = c.req.valid('param')
  
  // Get file metadata
  const { data: exportJob } = await supabase
    .from('export_jobs')
    .select('filename, storage_path, mime_type')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()
  
  if (!exportJob) {
    return c.json(...notFound(c.req.path))
  }
  
  // Get signed URL or stream from storage
  const { data: signedUrl } = await supabase.storage
    .from('exports')
    .createSignedUrl(exportJob.storage_path, 60)
  
  // Option 1: Redirect to signed URL
  return c.redirect(signedUrl.signedUrl, 302)
  
  // Option 2: Proxy the file
  const response = await fetch(signedUrl.signedUrl)
  
  return new Response(response.body, {
    headers: {
      'Content-Type': exportJob.mime_type,
      'Content-Disposition': `attachment; filename="${exportJob.filename}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  })
}
```

### Stream Large Files

```typescript
export const Handler = async (c) => {
  const { id } = c.req.valid('param')
  
  // Get file from storage
  const { data: blob, error } = await supabase.storage
    .from('exports')
    .download(`exports/${id}.csv`)
  
  if (error) {
    return c.json(...notFound(c.req.path))
  }
  
  // Stream response
  return new Response(blob.stream(), {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="export-${id}.csv"`,
      'Transfer-Encoding': 'chunked',
    },
  })
}
```

---

## 8. Mixed Input Sources

### Path + Query + Body

```typescript
// POST /collections/:collectionId/items?notify=true
// Body: { itemId: "abc", position: 5 }

const ParamSchema = z.object({
  collectionId: z.string().uuid(),
})

const QuerySchema = z.object({
  notify: z.coerce.boolean().default(false),
})

const JsonSchema = z.object({
  itemId: z.string().uuid(),
  position: z.number().int().positive().optional(),
})

export const Middleware = [
  authUserMiddleware,
  createValidator('param', ParamSchema),
  createValidator('query', QuerySchema),
  createValidator('json', JsonSchema),
]

export const Handler = async (c) => {
  const { collectionId } = c.req.valid('param')
  const { notify } = c.req.valid('query')
  const { itemId, position } = c.req.valid('json')
  
  // Verify collection ownership
  const { data: collection } = await supabase
    .from('collections')
    .select('id')
    .eq('id', collectionId)
    .eq('user_id', user.id)
    .single()
  
  if (!collection) {
    return c.json(...notFound(c.req.path, 'Collection not found'))
  }
  
  // Add item
  const { data, error } = await supabase
    .from('collection_items')
    .insert({
      collection_id: collectionId,
      item_id: itemId,
      position: position ?? 0,
    })
    .select()
    .single()
  
  if (error?.code === '23505') {
    return c.json(...conflict(c.req.path, 'Item already in collection'))
  }
  
  // Optional notification
  if (notify) {
    await queueNotification({
      type: 'collection_item_added',
      userId: user.id,
      collectionId,
      itemId,
    })
  }
  
  return c.json(...created(data, `/collections/${collectionId}/items/${data.id}`))
}
```

---

## 9. Optimistic Locking

### Using ETags

```typescript
// GET returns ETag
export const GetHandler = async (c) => {
  const { id } = c.req.valid('param')
  
  const { data } = await supabase
    .from('documents')
    .select('*, updated_at')
    .eq('id', id)
    .single()
  
  if (!data) {
    return c.json(...notFound(c.req.path))
  }
  
  const etag = createETag(data.id, data.updated_at)
  
  return new Response(JSON.stringify({ data }), {
    headers: {
      'Content-Type': 'application/json',
      'ETag': `"${etag}"`,
    },
  })
}

// PATCH requires If-Match
export const PatchHandler = async (c) => {
  const { id } = c.req.valid('param')
  const updates = c.req.valid('json')
  const ifMatch = c.req.header('If-Match')?.replace(/"/g, '')
  
  if (!ifMatch) {
    return c.json(...badRequest(c.req.path, 'If-Match header required'))
  }
  
  // Get current version
  const { data: current } = await supabase
    .from('documents')
    .select('updated_at')
    .eq('id', id)
    .single()
  
  if (!current) {
    return c.json(...notFound(c.req.path))
  }
  
  const currentEtag = createETag(id, current.updated_at)
  
  if (ifMatch !== currentEtag) {
    return c.json(...conflict(c.req.path, 'Resource modified since last read', {
      currentEtag,
      providedEtag: ifMatch,
    }))
  }
  
  // Proceed with update
  const { data, error } = await supabase
    .from('documents')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  
  const newEtag = createETag(id, data.updated_at)
  
  return new Response(JSON.stringify({ data }), {
    headers: {
      'Content-Type': 'application/json',
      'ETag': `"${newEtag}"`,
    },
  })
}

function createETag(id: string, updatedAt: string): string {
  return Buffer.from(`${id}:${updatedAt}`).toString('base64url')
}
```

---

## 10. Rate Limiting

### Per-User Rate Limits

```typescript
import { rateLimiter } from '#shared/middleware/rate-limit.ts'

export const Middleware = [
  authUserMiddleware,
  rateLimiter({
    windowMs: 60 * 1000,        // 1 minute window
    max: 100,                    // 100 requests per window
    keyGenerator: (c) => c.get('user').id,
    handler: (c) => c.json(...tooManyRequests(c.req.path, 'Rate limit exceeded')),
  }),
  createValidator('json', Definition.Schemas.Json),
]
```

### Per-Endpoint Rate Limits

```typescript
// Stricter limits for expensive operations
export const Middleware = [
  authUserMiddleware,
  rateLimiter({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 10,                    // 10 exports per hour
    keyGenerator: (c) => `export:${c.get('user').id}`,
  }),
]
```

### Response Headers

```typescript
// Headers added by rate limiter
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1706961234
Retry-After: 58  // Only when limited
```

---

## 11. Caching Strategies

### Cache-Control Headers

```typescript
// Immutable content (versioned resources)
return new Response(JSON.stringify({ data }), {
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=31536000, immutable',
  },
})

// User-specific, short cache
return new Response(JSON.stringify({ data }), {
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, max-age=60',
  },
})

// No caching (sensitive data)
return new Response(JSON.stringify({ data }), {
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  },
})
```

### Conditional Requests

```typescript
export const Handler = async (c) => {
  const ifNoneMatch = c.req.header('If-None-Match')
  const ifModifiedSince = c.req.header('If-Modified-Since')
  
  const { data } = await supabase
    .from('resources')
    .select('*, updated_at')
    .eq('id', id)
    .single()
  
  const etag = createETag(data)
  const lastModified = data.updated_at
  
  // Check If-None-Match
  if (ifNoneMatch === `"${etag}"`) {
    return new Response(null, { status: 304 })
  }
  
  // Check If-Modified-Since
  if (ifModifiedSince) {
    const since = new Date(ifModifiedSince)
    const modified = new Date(lastModified)
    if (modified <= since) {
      return new Response(null, { status: 304 })
    }
  }
  
  return new Response(JSON.stringify({ data }), {
    headers: {
      'Content-Type': 'application/json',
      'ETag': `"${etag}"`,
      'Last-Modified': new Date(lastModified).toUTCString(),
      'Cache-Control': 'private, must-revalidate',
    },
  })
}
```