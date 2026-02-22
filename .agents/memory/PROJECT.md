# Project Summary

## Outcome

bundlejs-api is a Deno v2 + TypeScript service for bundle size analysis,
backed by esbuild (WASM) and Hono on Supabase Edge Functions.

## Context

- Runtime: Deno v2, TypeScript (strict), ESM
- API: Hono on Supabase Edge Functions
- Build engine: esbuild (WASM)
- Compression: gzip, brotli, zstd, lz4

## Key modules

- **core/** — bundle execution engine (esbuild wrapper + plugins)
- **edge/** — API endpoints (Hono/Supabase)
- **utils/** — shared utilities (often re-exports from `@std`)
- **compress/** — compression algorithms

## Constraints

- Edge runtime constraints apply to API endpoints.
- Avoid hidden global state and top-level side effects.
- Keep public APIs well-documented and verifiable.

## Non-goals

This file is not a full architecture spec or onboarding guide.
