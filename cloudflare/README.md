# Cloudflare Workspace

This workspace is the root-level home for the Cloudflare runtime target.

What exists today:

- A Worker entrypoint in [src/index.ts](./src/index.ts)
- A per-bundle-key Durable Object scaffold in [src/durable-objects/bundle-coordinator.ts](./src/durable-objects/bundle-coordinator.ts)
- Static asset binding support through [wrangler.jsonc](./wrangler.jsonc)
- KV-backed bundle metadata and badge caching through [src/storage.ts](./src/storage.ts)
- R2-backed bundled artifact storage through [src/storage.ts](./src/storage.ts)
- Bundle request preparation shared with the existing Deno edge target through [../edge/request.ts](../edge/request.ts)
- Shared bundle execution through [../edge/execute.ts](../edge/execute.ts) and [../edge/bundle.ts](../edge/bundle.ts)
- Coordinator state transitions for queued, running, complete, and errored bundle requests on `GET /` and `GET /bundle`
- Local package metadata so this workspace can participate in the new `pnpm` monorepo

What is intentionally not wired yet:

- Cache API response caching in front of KV and R2
- Workflow-backed async build jobs
- Full route parity with [edge/mod.ts](../edge/mod.ts)

Initial commands:

```sh
pnpm install
pnpm dev:cloudflare
```

Bindings you still need to provision before deploy:

- Replace the placeholder `BUNDLE_CACHE` namespace IDs in [wrangler.jsonc](./wrangler.jsonc)
- Create the `bundlejs-api-artifacts` R2 bucket or rename the binding to match your actual bucket names in [wrangler.jsonc](./wrangler.jsonc)

Implementation notes:

- The current scaffold keeps the Deno deploy target intact while creating a clean place for Cloudflare-specific runtime adapters.
- Durable Objects are modeled per bundle key, not as one global singleton.
- The Worker now runs the shared bundle pipeline directly and persists finished metadata in KV plus bundle artifacts in R2.
- Manual Cache API caching is still deferred. The current Worker relies on normal response caching semantics first, and Durable Objects plus KV plus R2 remain the canonical app-state layers.