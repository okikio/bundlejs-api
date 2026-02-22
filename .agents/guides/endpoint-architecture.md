# Endpoint Architecture Reference

> **Staleness warning:** This guide describes architectural patterns and
> conventions. Concrete import paths, type names, and function signatures may
> drift as the codebase evolves. When in doubt, verify against the source files
> in `edge/_shared/` and existing endpoint implementations in
> `edge/endpoints/`. The patterns (structure, middleware order, response
> envelope shape) are the stable part; the exact spellings are not.

Backend utilities for Supabase Edge Functions using Hono framework with RFC
7807 error handling, cursor/offset pagination, and Standard Schema validation.

See also: `endpoints.instructions.md` for prescriptive rules that apply to
every endpoint file.

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
- Actions: short, user-intent focused verbs
- Max depth: 2 levels (resource/action)

---

## 2. Definition Contract

The definition establishes the route, HTTP methods, and input/output schemas.
Export a default object that satisfies `EndpointDefinition`:

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

Use `satisfies EndpointDefinition` for type-checking without widening. Zod
pipes and transforms are allowed in `Input`. See existing definitions in
`edge/endpoints/` for current import paths and patterns.

---

## 3. Handler Contract

Handlers export two things:

- `Middleware` — an array of endpoint-specific middleware handlers
- `Handler` (default export) — the async handler function

The handler receives a typed Hono context. Use `c.req.valid('query')` for GET
inputs, `c.req.valid('json')` for POST bodies. Return responses using the
spread-tuple pattern: `return c.json(...ok(data))`.

---

## 4. Middleware

### Execution Order

```
Request
   │
   ▼
┌──────────────────────────────────────────────┐
│  Global (applied by createApp)               │
│  secureHeaders → correlation → requestId     │
│  → CORS → logger → timing → prettyJSON       │
└──────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────┐
│  Endpoint-specific (from Middleware export)   │
│  Auth → Validation → Custom → Handler        │
└──────────────────────────────────────────────┘
```

**Auth middleware** validates JWTs, attaches `user` and an authenticated
Supabase client to context, and returns 401 on invalid/missing tokens.

**Validation middleware** uses the Standard Schema adapter for Zod, returns RFC
7807 422 responses on failure, and makes validated data available via
`c.req.valid(...)`.

---

## 5. Response Patterns

### Success envelope

```json
{
  "data": { ... },
  "meta": {
    "timestamp": "...",
    "pagination": { ... },
    "query": { ... }
  }
}
```

Helpers: `ok()`, `created()`, `accepted()`, `noContent()`, `paginate()`. All
return tuples meant to be spread into `c.json(...)`.

### Error envelope (RFC 7807)

```json
{
  "type": "https://errors.example.com/not-found",
  "title": "Not Found",
  "status": 404,
  "detail": "User not found",
  "instance": "/users/123"
}
```

Helpers: `badRequest()`, `unauthorized()`, `forbidden()`, `notFound()`,
`conflict()`, `gone()`, `validationFailed()`, `internalServerError()`,
`exception()`. Check `edge/_shared/response/` for the current list and
signatures.

---

## 6. Query Processing

List endpoints support filtering, sorting, field selection, and pagination
through `createEndpointQuerySchema()`.

### URL syntax

| Feature | Syntax |
|---------|--------|
| Filter (eq) | `?filter[status]=active` |
| Filter (range) | `?filter[price][gte]=50&filter[price][lte]=200` |
| Filter (array) | `?filter[status][in]=active,archived` |
| Filter (null) | `?filter[deleted_at]=null` |
| Sort | `?sort=created_at:desc,name:asc` |
| Fields | `?fields=id,name,status` |
| Pagination (cursor) | `?cursor=eyJzb3J0...&limit=20` |
| Pagination (offset) | `?offset=40&limit=20` |

### Count strategies

| Strategy | Use when |
|----------|----------|
| `'exact'` | Need precise total, small tables |
| `'planned'` | Large tables, acceptable approximation |
| `'estimated'` | Very large tables, rough estimate OK |

---

## 7. Pagination

### Cursor-based (preferred)

Uses HMAC-signed tokens encoding sort position + tiebreaker. Guarantees:
- Constant performance regardless of page depth
- No duplicates or skips when data changes
- Tamper-proof cursors

### Offset-based (when needed)

Use when the caller needs to jump to a specific page or display a total count
and performance on deep pages is acceptable.

### Link headers (RFC 8288)

Both modes emit standard Link headers with `rel="next"`, `rel="prev"`,
`rel="first"`, `rel="last"` as applicable.

---

## 8. Error Handling

```
Validation error     → middleware catches → 422 (RFC 7807)
HTTPException        → global handler    → status from exception
Unexpected throw     → global handler    → 500
Handler-level error  → handler returns   → appropriate status
```

Log at the handler level with enough context to diagnose without leaking
secrets. Catch Supabase errors explicitly and map to appropriate response
helpers.

---

## 9. Registration

1. Export the definition from the function's `mod.ts`
2. Import the handler module in the function's `index.ts`
3. Register with `app.on(endpoint.Methods, [endpoint.Route], ...middleware, handler)`

---

## 10. Checklist: New Endpoint

1. **Create folder**: `endpoints/{resource}/{action}/`
2. **Write definition.ts**: route, methods, schemas
3. **Write handler.ts**: middleware array + default handler
4. **Add to mod.ts**: export definition
5. **Add to index.ts**: import handler, register route
6. **Test**: validation errors, success cases, edge cases

For current type signatures (`EndpointHandler`, `EndpointMiddlewareHandler`,
`FunctionAppEnv`, etc.), check `edge/_shared/server/types.ts` and
`edge/_shared/server/create-app.ts` directly rather than relying on this
guide.