# bundlejs-api Codebase Patterns - AI Coding Agent Guide

**Research Date:** February 5, 2026  
**Purpose:** Essential patterns for AI coding agents working on bundlejs-api

---

## 1. Code Style & Conventions

### 1.1 Import/Export Patterns

**Type-first imports:**
```typescript
// Always separate type imports from value imports
import type { BuildConfig, ESBUILD, LocalState } from "./types.ts";
import type { FullPackageVersion, PackageJson } from "@bundle/utils/types";

// Then value imports
import { VirtualFileSystemPlugin } from "./plugins/fs.ts";
import { ExternalPlugin } from "./plugins/external.ts";
```
See: [core/build.ts](core/build.ts#L1-L22)

**Barrel exports pattern:**
```typescript
// utils/mod.ts - explicit named exports
export * from "./ansi.ts";
export * from "./async.ts";

// Namespace exports for common utilities
export * as semver from "./semver.ts";
export * as path from "./path.ts";
export * as fmt from "./fmt.ts";
```
See: [utils/mod.ts](utils/mod.ts)

**Re-export standard library utilities:**
```typescript
// Don't re-implement - re-export from @std
export * as bytes from "@std/fmt/bytes";
export * from "@std/semver";
export * from "@std/async";
```
See: [utils/fmt.ts](utils/fmt.ts), [utils/semver.ts](utils/semver.ts)

### 1.2 Function Declaration Style

**Arrow functions for constants and exports:**
```typescript
export const isObject = (obj: unknown) => typeof obj === "object" && obj != null;
export const isPrimitive = (val: unknown) => (typeof val === "object" ? val === null : typeof val !== "function");
```
See: [utils/deep-object.ts](utils/deep-object.ts#L7-L8)

**Traditional async functions for larger operations:**
```typescript
export async function build(opts: BuildConfig = {}, filesystem: Promise<IFileSystem<unknown>> = TheFileSystem): Promise<BuildResult> {
  // Implementation
}

export async function executeBundle(options: BundleExecutionOptions): Promise<BundleResult> {
  // Implementation  
}
```
See: [core/build.ts](core/build.ts#L64), [edge/_shared/bundle/service.ts](edge/_shared/bundle/service.ts#L88)

### 1.3 Object Patterns

**Spread operator preferred over Object.assign:**
```typescript
// Preferred
const buildConfig: BundleConfig = {
  ...config,
  entryPoints: [entryPointPath],
  init: {
    ...config.init,
    wasmModule,
  },
}

// Object.assign used only for define fields (esbuild API requirement)
define: Object.assign({
  "__NODE__": "false",
  "process.env.NODE_ENV": "\"production\"",
}, esbuildOpts.define),
```
See: [edge/_shared/bundle/service.ts](edge/_shared/bundle/service.ts#L127-L133), [core/build.ts](core/build.ts#L117-L120)

### 1.4 Formatting Configuration

**Deno formatting settings (deno.jsonc):**
```jsonc
{
  "fmt": {
    "semiColons": false,    // NO semicolons
    "singleQuote": true     // Single quotes for strings
  }
}
```
See: [edge/deno.jsonc](edge/deno.jsonc#L50-L53)

**Key formatting rules:**
- No semicolons
- Single quotes for strings
- Tabs for indentation (implied by Deno defaults)
- Trailing commas in multi-line objects/arrays

---

## 2. Architecture & Module Organization

### 2.1 Workspace Structure

```
bundlejs-api/
├── core/          # Bundle execution engine (esbuild wrapper)
├── edge/          # API endpoints (Hono/Supabase Edge Functions)
├── utils/         # Shared utilities (re-exports from @std)
└── compress/      # Compression algorithms (gzip, brotli, zstd, lz4)
```

**Workspace declaration:**
```jsonc
{
  "workspace": [
    "./core",
    "./edge", 
    "./utils",
    "./compress"
  ]
}
```
See: [deno.jsonc](deno.jsonc)

### 2.2 Module Boundaries & Imports

**Import path aliases:**

In `edge/` modules:
```typescript
// #shared/ alias maps to ./_shared/
import { executeBundle } from '#shared/bundle/service.ts'
import { ok, badRequest } from '#shared/response/mod.ts'
import { rateLimitMiddleware } from '#middleware/rate-limit.ts'
```
See: [edge/deno.jsonc](edge/deno.jsonc#L27), [edge/endpoints/bundle/run/handler.ts](edge/endpoints/bundle/run/handler.ts)

**Barrel imports from workspace packages:**
```typescript
// Import from @bundle/* workspace packages
import { build, setFile, useFileSystem } from '@bundle/core'
import { compress } from '@bundle/compress'
import { deepMerge, parsePackageName, resolveVersion } from '@bundle/utils'
```
See: [edge/_shared/bundle/service.ts](edge/_shared/bundle/service.ts), [edge/_shared/bundle/parse.ts](edge/_shared/bundle/parse.ts)

### 2.3 Data Flow

```
User Request
    ↓
[Hono Router] → Middleware (auth, rate-limit, validation)
    ↓
[Handler] → parseQueryToConfig() 
    ↓
[Bundle Service] → executeBundle()
    ↓
[@bundle/core] → esbuild + plugins
    ↓
[@bundle/compress] → compression
    ↓
[Response] → RFC 7807 JSON
```

### 2.4 Plugin Architecture

**esbuild plugins follow factory pattern:**
```typescript
// Plugin factory receives Context
export function CdnPlugin<T>(StateContext: Context<CdnResolutionState<T>>) {
  // Setup phase
  const resolver = CdnResolution(StateContext);
  
  // Return esbuild plugin
  return {
    name: "cdn",
    setup(build: ESBUILD.PluginBuild) {
      build.onResolve({ filter: /.*/ }, resolver);
    }
  };
}
```
See: [core/plugins/cdn.ts](core/plugins/cdn.ts)

**Plugin chain in build:**
```typescript
plugins: [
  AliasPlugin(StateContext),      // 1. Resolve aliases
  ExternalPlugin(StateContext),   // 2. Mark externals
  VirtualFileSystemPlugin(StateContext), // 3. VFS resolution
  TarballPlugin(StateContext),    // 4. Tarball extraction
  HttpPlugin(StateContext),       // 5. HTTP fetching
  CdnPlugin(StateContext),        // 6. CDN resolution
]
```
See: [core/build.ts](core/build.ts#L115-L122)

---

## 3. Context System

### 3.1 Context Pattern

**Context provides reactive state sharing across plugins:**

```typescript
// Create context with typed state
const StateContext = new Context<LocalState>({
  filesystem: Context.opaque(await filesystem),
  assets: [],
  config: Context.opaque(createConfig("build", opts)),
  
  failedExtensionChecks: new Set(),
  failedManifestUrls: new Set(),
  host: DEFAULT_CDN_HOST,
  versions: new Map(),
  
  tarballInflight: new Map(),
  tarballMounts: new Map(),
  sideEffectsMatchersCache: new Map(),
  packageManifests: new Map(),
});

// Access context values
const config = fromContext("config", StateContext)!;
const host = fromContext("host", StateContext);

// Set context values
toContext("host", newHost, StateContext);

// Extend context with additional properties
const ExtendedContext = withContext({ origin: host }, StateContext);
```
See: [core/build.ts](core/build.ts#L71-L88), [core/context/context.ts](core/context/context.ts)

**Context.opaque() for non-reactive values:**
```typescript
// Use opaque() to prevent proxying of complex objects
filesystem: Context.opaque(await filesystem),
config: Context.opaque(createConfig("build", opts)),
```

### 3.2 LocalState Type

```typescript
export interface LocalState<T = unknown> extends TarballState, record {
  filesystem: IFileSystem<T>,
  versions: Map<string, string>,
  assets: ESBUILD.OutputFile[],
  
  failedExtensionChecks: Set<string>,
  failedManifestUrls: Set<string>,
  packageManifests: Map<string, PackageJson | FullPackageVersion>,
  sideEffectsMatchersCache: Map<string, SideEffectsMatchers>,
  
  host: string,
  config: BuildConfig,
}
```
See: [core/types.ts](core/types.ts#L18-L36)

---

## 4. Error Handling & Validation

### 4.1 RFC 7807 Problem Details

**All API errors use RFC 7807 format:**

```typescript
// Error response helpers
import { ok, badRequest, unauthorized, internalServerError } from '#shared/response/mod.ts'

// Usage in handlers
if (!inputCode && modules.length === 0) {
  return c.json(...badRequest(c.req.path, 'No modules or code provided'))
}

// Success responses
return c.json(...ok(result))
```
See: [edge/_shared/response/errors.ts](edge/_shared/response/errors.ts), [edge/endpoints/bundle/run/handler.ts](edge/endpoints/bundle/run/handler.ts)

**Canonical error types:**
```typescript
export const ERROR_TYPES = {
  BAD_REQUEST: `${BASE_ERROR_URL}/bad-request`,
  UNAUTHORIZED: `${BASE_ERROR_URL}/unauthorized`,
  VALIDATION_ERROR: `${BASE_ERROR_URL}/validation-error`,
  RATE_LIMIT_EXCEEDED: `${BASE_ERROR_URL}/rate-limit-exceeded`,
  // ...
} as const

export const ERROR_DOCS = {
  BAD_REQUEST: `${BASE_DOCS_URL}/bad-request`,
  // Links to documentation
}
```
See: [edge/_shared/response/errors.ts](edge/_shared/response/errors.ts#L9-L35)

### 4.2 Validation with Zod + Standard Schema

**Standard Schema validation middleware:**
```typescript
import { createValidator } from '#shared/middleware/validation.ts'
import { BundleQuerySchema } from './schema.ts'

// In endpoint middleware chain
export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  rateLimitMiddleware({ windowMs: 60_000, limit: 120 }),
  cacheControlMiddleware,
  createValidator('query', BundleQuerySchema),  // Validates query params
]
```
See: [edge/endpoints/bundle/run/handler.ts](edge/endpoints/bundle/run/handler.ts#L37-L48)

**Validation schemas use Zod:**
```typescript
export const BundleQuerySchema = z.object({
  q: z.string().optional(),
  query: z.string().optional(),
  
  // Boolean transforms
  tsx: z
    .union([z.literal(''), z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === '' || v === 'true'),
  
  minify: z
    .union([z.literal(''), z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === '' ? true : v === 'true')),
})
```
See: [edge/_shared/bundle/schema.ts](edge/_shared/bundle/schema.ts)

**Validation errors return 422 with details:**
```typescript
// Automatic conversion to RFC 7807 format
{
  "type": "https://api.bundlejs.com/error/validation-error",
  "title": "Validation Error",
  "status": 422,
  "detail": "Request validation failed",
  "instance": "/v1/bundle",
  "errors": [
    {
      "field": "minify",
      "message": "Expected boolean"
    }
  ]
}
```

---

## 5. Middleware Patterns

### 5.1 Hono Middleware Stack

**Standard middleware order:**
```typescript
export const Middleware: EndpointMiddlewareHandler<AppEnv>[] = [
  // 1. Rate limiting (protect resources)
  rateLimitMiddleware({ windowMs: 60_000, limit: 120 }),
  
  // 2. Cache control (parse cache directives)
  cacheControlMiddleware,
  
  // 3. Validation (ensure request is valid)
  createValidator('query', Schema),
]
```
See: [edge/endpoints/bundle/run/handler.ts](edge/endpoints/bundle/run/handler.ts#L37-L48)

### 5.2 Rate Limiting

**Redis-backed rate limiting with graceful degradation:**
```typescript
export function rateLimitMiddleware(options: RateLimitOptions) {
  const { windowMs, limit } = options
  
  const redis = getRedisClient()
  
  // If Redis unavailable, use in-memory fallback
  const store = redis 
    ? new RedisStore({ client: redis })
    : undefined
  
  return createMiddleware(
    rateLimiter({
      windowMs,
      limit,
      standardHeaders: 'draft-6',  // IETF standard headers
      keyGenerator: (c) => {
        // Rate limit by IP
        return c.req.header('x-forwarded-for') ?? 'unknown'
      },
      store,
      handler: (c) => {
        return c.json(...rateLimitExceeded(c.req.path, 60))
      },
    })
  )
}
```
See: [edge/_shared/middleware/rate-limit.ts](edge/_shared/middleware/rate-limit.ts)

### 5.3 Authentication

**JWT-based auth middleware:**
```typescript
export const authUserMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(...unauthorized(c.req.path, 'Missing authorization header'));
  }

  const supabase = createUserClient(authHeader);
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return c.json(...unauthorized(c.req.path, 'Authentication required'));
  }

  c.set('user', user);
  c.set('supabase', supabase);
  await next()
}
```
See: [edge/_shared/middleware/auth.ts](edge/_shared/middleware/auth.ts)

### 5.4 Logging with LogTape

**Correlation ID tracking:**
```typescript
import { getLogger } from '#shared/middleware/correlation.ts'

// In handler
const logger = getLogger(c)

logger.info('Cache HIT', { key: cacheKey.slice(0, 20) })
logger.warn('Validation failed', { errors })
logger.error('Bundle failed', { error: error.message })
```
See: [edge/endpoints/bundle/run/handler.ts](edge/endpoints/bundle/run/handler.ts)

---

## 6. External Integrations

### 6.1 CDN Resolution

**Supports multiple CDN hosts:**
```typescript
cdn?: 
  | "https://unpkg.com" 
  | "https://esm.run"
  | "https://esm.sh"
  | "https://esm.sh/jsr"
  | "https://cdn.skypack.dev"
  | "https://cdn.jsdelivr.net/npm"
  | "unpkg"
  | "esm"
  | "jsr"
  | (string & {})
```
See: [core/types.ts](core/types.ts#L77)

**CDN plugin resolves:**
- npm packages (bare imports)
- JSR packages (`jsr:@std/path`)
- npm aliases (`npm:package@version`)
- URL versions (pkg.pr.new)
- GitHub shorthand (`user/repo`)

See: [core/plugins/cdn.ts](core/plugins/cdn.ts)

### 6.2 Package Resolution

**npm registry resolution:**
```typescript
import { 
  parsePackageName,
  getPackageOfVersion,
  getRegistryURL,
  resolveVersion 
} from "@bundle/utils/npm-search"

// Parse package spec
const spec = parseNpmSpec("react@^18.0.0")

// Resolve version
const version = await resolveVersion(name, versionSpec)
```
See: [utils/npm-spec.ts](utils/npm-spec.ts), [utils/npm-search.ts](utils/npm-search.ts)

**JSR registry resolution:**
```typescript
import { 
  parseJSRSpec,
  looksLikeJSRSpec,
  getJSRModuleUrl,
  resolveJSRVersion 
} from "@bundle/utils/jsr-spec"

// Resolve JSR package
const meta = await getJSRVersionMeta(scope, name, version)
const url = getJSRModuleUrl(scope, name, version, path)
```
See: [utils/jsr-spec.ts](utils/jsr-spec.ts)

### 6.4 WASM Integration

**WASM modules loaded lazily:**
```typescript
// Compression WASM
switch (type) {
  case "brotli": {
    const { compress, getWASM } = await import("./deno/brotli/mod.ts");
    await getWASM();
    return async (code) => await compress(code, code.length, quality);
  }
  case "zstd": {
    const { compress, getWASM } = await import("./deno/zstd/mod.ts");
    await getWASM();
    return async (code) => await compress(code, quality);
  }
}
```
See: [compress/compress.ts](compress/compress.ts#L37-L56)

**esbuild WASM:**
```typescript
// WASM module cached after first load
const wasmModule = await getWasmModule()

const buildConfig: BundleConfig = {
  ...config,
  init: {
    ...config.init,
    wasmModule,
  },
}
```
See: [edge/_shared/bundle/service.ts](edge/_shared/bundle/service.ts#L100-L104)

---

## 7. Environment & Configuration

### 7.1 Environment Variables

**Cross-runtime env access:**
```typescript
// Use helper for Deno/Node compatibility
import { getEnv, requireEnv } from '#shared/utils/env.ts'

const url = getEnv('UPSTASH_URL')
const token = requireEnv('UPSTASH_TOKEN')  // Throws if missing
```
See: [edge/_shared/utils/env.ts](edge/_shared/utils/env.ts)

**Common environment variables:**
- `UPSTASH_URL` - Redis connection
- `UPSTASH_TOKEN` - Redis auth token
- `GITHUB_AUTH_TOKEN` - GitHub API access
- `CURSOR_SECRET` - Cursor pagination secret
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_KEY` - Supabase admin key

**Direct access pattern:**
```typescript
// Only use Deno.env.get() in edge functions (not in shared code)
const url = Deno.env.get('UPSTASH_URL')
const token = Deno.env.get('UPSTASH_TOKEN')
```
See: [edge/_shared/cache/client.ts](edge/_shared/cache/client.ts#L215-L216)

### 7.2 Build Configuration

**Default build config:**
```typescript
export const BUILD_CONFIG: BuildConfig = {
  "entryPoints": ["/index.tsx"],
  "cdn": DEFAULT_CDN_HOST,
  "polyfill": false,

  "esbuild": {
    "color": true,
    "globalName": "BundledCode",
    "logLevel": "info",
    "sourcemap": false,
    "target": ["esnext"],
    "format": "esm",
    "bundle": true,
    "minify": true,
    "treeShaking": true,
    "platform": "node",
    "jsx": "transform"
  },

  "ansi": "ansi",
  init: {
    platform: PLATFORM_AUTO
  }
}
```
See: [core/build.ts](core/build.ts#L27-L50)

---

## 8. Build & Deployment

### 8.1 Deno Tasks

**Core module:**
```bash
deno task dev           # Run REPL with watch mode
deno task build:wasm    # Build WASM modules
```
See: [core/deno.jsonc](core/deno.jsonc#L34-L36)

**Edge module:**
```bash
deno task dev           # Start dev server with watch
```
See: [edge/deno.jsonc](edge/deno.jsonc#L47-L48)

### 8.2 Deployment

**Deno Deploy configuration:**
```jsonc
{
  "deploy": {
    "project": "bundlejs",
    "exclude": ["**/node_modules"],
    "include": [],
    "entrypoint": "edge/mod.ts"
  }
}
```
See: [deno.jsonc](deno.jsonc#L8-L15)

### 8.3 No Traditional Tests

**No test files found** - Project appears to rely on:
- Manual testing via REPL (_repl.ts files)
- Production monitoring
- Type checking via TypeScript

---

## 9. Naming Conventions

### 9.1 File Naming

- **TypeScript files:** `kebab-case.ts`
- **Interfaces/Types:** `PascalCase` 
- **Constants:** `UPPER_SNAKE_CASE`
- **Functions:** `camelCase`

### 9.2 Special Files

- `mod.ts` - Module barrel exports
- `types.ts` - Type definitions
- `_repl.ts` - Development REPL
- `deno.jsonc` - Deno configuration
- `definition.ts` - Endpoint schema definition
- `handler.ts` - Endpoint handler implementation

### 9.3 Directory Patterns

```
feature/
├── mod.ts           # Public API barrel export
├── types.ts         # Type definitions
├── _repl.ts         # Development REPL
├── deno.jsonc       # Config & tasks
└── feature.ts       # Implementation
```

---

## 10. Unique Project Conventions

### 10.1 TypeScript Reference Comments

**Node types in Deno:**
```typescript
/// <reference types="npm:@types/node" />
```
See: [edge/_shared/utils/env.ts](edge/_shared/utils/env.ts#L1)

### 10.2 Package.json in Config

**Package manifests passed as config:**
```typescript
export interface BuildConfig {
  "package.json"?: PackageJson | FullPackageVersion,
  // ...
}
```
See: [core/types.ts](core/types.ts#L73-L75)

### 10.3 Virtual Filesystem

**VFS for bundling without disk I/O:**
```typescript
const FileSystem = useFileSystem()
const fs = await FileSystem

setFile(fs, '/index.ts', inputCode)

// Build uses VFS
const result = await build(config, FileSystem)

// Clear after use
await fs?.clear?.()
```
See: [core/build.ts](core/build.ts#L64), [edge/legacy/bundle.ts](edge/legacy/bundle.ts#L49-L55)

### 10.4 Event System

**Build events for logging:**
```typescript
import { 
  BUILD_ERROR, 
  INIT_LOADING, 
  LOGGER_ERROR, 
  LOGGER_WARN,
  dispatchEvent 
} from "./configs/events.ts"

dispatchEvent(INIT_LOADING)
dispatchEvent(LOGGER_ERROR, new Error(message))
```
See: [core/build.ts](core/build.ts#L13)

### 10.5 LZ-String Compression

**Share parameter uses LZ compression:**
```typescript
import { decompressFromURL } from '@bundle/utils/lz-string'

const share = searchParams.get('share')
if (share) {
  inputCode = decompressFromURL(share) || DEFAULT_INPUT_CODE
}
```
See: [edge/_shared/bundle/parse.ts](edge/_shared/bundle/parse.ts#L31)

---

## 11. Common Utility Patterns

### 11.1 Deep Object Operations

```typescript
import { deepMerge, deepEqual, deepDiff } from '@bundle/utils/deep-object'

// Merge configs
const merged = deepMerge(baseConfig, userConfig)

// Compare objects
if (deepEqual(obj1, obj2)) { /* ... */ }

// Find differences
const diff = deepDiff(oldConfig, newConfig)
```
See: [utils/deep-object.ts](utils/deep-object.ts)

### 11.2 Path Operations

```typescript
import { join, extname, basename, isBareImport } from '@bundle/utils/path'

const fullPath = join('/base', 'file.ts')
const ext = extname('/path/file.ts')  // '.ts'
const bare = isBareImport('react')    // true
```
See: [utils/path.ts](utils/path.ts)

### 11.3 Bytes Formatting

```typescript
import { bytes } from '@bundle/utils/fmt'

const formatted = bytes.format(12345)  // '12.35 kB'
```
See: [compress/compress.ts](compress/compress.ts#L4), [utils/fmt.ts](utils/fmt.ts)

### 11.4 Async Utilities

```typescript
import { debounce, delay } from '@bundle/utils/async'

const debouncedFn = debounce(fn, 300)
await delay(1000)  // Wait 1 second
```
See: [utils/async.ts](utils/async.ts)

---

## 12. Key Takeaways for AI Agents

### ✅ DO

1. **Use spread operator** for object copying/merging
2. **Separate type imports** from value imports
3. **Use arrow functions** for simple utilities
4. **Re-export from @std** instead of re-implementing
5. **Use RFC 7807 format** for all API errors
6. **Apply circuit breaker pattern** for external services
7. **Use Context system** for plugin state sharing
8. **Follow factory pattern** for esbuild plugins
9. **Use Zod schemas** for validation
10. **Log with LogTape** using correlation IDs

### ❌ DON'T

1. **Don't use semicolons** (per fmt config)
2. **Don't use double quotes** for strings
3. **Don't implement utilities** that exist in @std
4. **Don't hardcode env vars** - use getEnv()
5. **Don't throw raw errors** - use Problem Details
6. **Don't block on Redis** - degrade gracefully
7. **Don't proxy native classes** in Context (use Context.opaque())
8. **Don't create tests** - project doesn't use them
9. **Don't use Object.assign** except for esbuild define
10. **Don't import from barrel exports** in performance-critical paths

### 🎯 Critical Patterns

1. **Plugin Chain Order Matters:**
   ```
   Alias → External → VFS → Tarball → HTTP → CDN
   ```

2. **Middleware Order Matters:**
   ```
   Rate Limit → Cache Control → Validation → Handler
   ```

3. **Error Response Pattern:**
   ```typescript
   return c.json(...errorHelper(path, detail))
   ```

4. **Context Access Pattern:**
   ```typescript
   const value = fromContext("key", StateContext)
   toContext("key", newValue, StateContext)
   ```

5. **Async Handler Pattern:**
   ```typescript
   export const Handler: EndpointHandler = async (c) => {
     try {
       // ... operation
       return c.json(...ok(result))
     } catch (error) {
       logger.error('...')
       return c.json(...internalServerError(path, message))
     }
   }
   ```

---

## Commands Reference

```bash
# Development
deno task dev                    # Watch mode REPL/server

# Build WASM modules
deno task build:wasm             # In core/ or compress/

# Type checking
deno check edge/mod.ts           # Check types

# Running
deno serve -A edge/mod.ts        # Start server

# Formatting
deno fmt                         # Format with project rules

# Deploy
deployctl deploy edge/mod.ts     # Deploy to Deno Deploy
```

---

**End of Research Document**
