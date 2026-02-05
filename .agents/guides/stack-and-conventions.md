# Stack & Conventions (Quick Reference)

## Runtime / Language
- Deno v2, TypeScript (strict), ESM

## API
- Hono on Supabase Edge Functions
- Endpoint contract: definition.ts + handler.ts
- Responses: helpers from #shared/response/mod.ts

## Build
- esbuild via WASM
- Plugin chain: Alias → External → FS/VFS → Tarball → HTTP → CDN

## Formatting
- Tabs (width 2)
- Single quotes
- Explicit import extensions
