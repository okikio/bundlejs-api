---
description: Endpoint development rules
applyTo: "edge/endpoints/**"
---

# Endpoint Development (edge/endpoints)

Each endpoint lives in:

endpoints/{resource}/{action}/
- definition.ts  (contract: route/methods/schemas)
- handler.ts     (middleware + handler)

## Definition contract

- Export a default object that satisfies `EndpointDefinition`.
- Use `Methods: [...] as const`.
- Model both GET query and POST JSON when relevant.
- `Input` should accept the raw source and may transform (Zod pipes/transforms allowed).
- `Output` should be the final response envelope schema.

Example shape:

- Name: string
- Route: string
- Methods: readonly HTTP methods
- Input: zod schema (often `QuerySchema.or(JsonSchema)`)
- Output: zod schema
- Schemas: { Query?, Json?, Param?, Header?, Cookie?, Form? }

## Handler pattern

- Export `Middleware` as an array of `EndpointMiddlewareHandler<AppEnv>[]`.
- Export `Handler` as `EndpointHandler<AppEnv, typeof Definition>` using `async function (c)`.
- Default-export `Handler`.

### Middleware order

1) Auth / correlation / request context (if applicable)
2) Rate limiting / cache control (if applicable)
3) Validation via `createValidator(target, schema)`
4) Custom middleware
5) Handler

## Input handling

- For GET, use validated input: `c.req.valid('query')`
- For POST, read JSON and then parse/transform into internal config as needed.

## Responses

- Use response helpers from `@utils/response`.
- Helpers return tuples intended to be spread into `c.json(...)`:
  - `return c.json(...ok(data))`
  - `return c.json(...badRequest(path, message))`
- It’s fine to add extra headers via `c.header(...)` before returning.

## Logging

- Prefer request-correlated logging (use the correlation middleware helpers if present).
- Log both:
  - operator/debug signals (cache hit/miss, durations)
  - actionable failure context (safe error message, not secrets)

## Educational clarity

- If you implement non-trivial request parsing (encoding, compression, regex), explain it step-by-step with a small ASCII flow.

## Related instructions

- `edge-shared.instructions.md` — rules for shared modules used by endpoints
- `testing.instructions.md` — test conventions and edge cases
- `typescript.instructions.md` — type and style conventions

## Related guides

- `.agents/guides/endpoint-architecture.md` — architectural reference for
  endpoint patterns, middleware, response envelopes, and query processing
