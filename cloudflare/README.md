# Cloudflare Workspace

This workspace is the root-level home for the Cloudflare runtime target.

What exists today:

- A Worker entrypoint in [src/index.ts](./src/index.ts)
- A per-bundle-key Durable Object scaffold in [src/durable-objects/bundle-coordinator.ts](./src/durable-objects/bundle-coordinator.ts)
- Static asset binding support through [wrangler.jsonc](./wrangler.jsonc)
- KV-backed bundle metadata and badge caching through [src/storage.ts](./src/storage.ts)
- Optional R2-backed bundled artifact storage through [src/storage.ts](./src/storage.ts)
- Bundle request preparation shared with the existing Deno edge target through [../edge/request.ts](../edge/request.ts)
- Shared bundle execution through [../edge/execute.ts](../edge/execute.ts) and [../edge/bundle.ts](../edge/bundle.ts)
- Coordinator state transitions for queued, running, complete, and errored bundle requests on `GET /` and `GET /bundle`
- Local package metadata so this workspace can participate in the new `pnpm` monorepo

What is intentionally not wired yet:

- Cache API response caching in front of KV and optional R2
- Workflow-backed async build jobs
- Full route parity with [edge/mod.ts](../edge/mod.ts)

Initial commands:

```sh
pnpm install
pnpm dev:cloudflare
```

Bindings you still need to provision before deploy:

- Replace the placeholder `BUNDLE_CACHE` namespace IDs in [wrangler.jsonc](./wrangler.jsonc)
- R2 is currently commented out in [wrangler.jsonc](./wrangler.jsonc); re-enable that block and create `bundlejs-api-artifacts` if you want persisted bundle artifacts later

Cloudflare Git deployment settings:

- Path: `/cloudflare`
- Build command: leave blank
- Deploy command: `npx wrangler deploy`
- Non-production branch deploy command: `npx wrangler versions upload`

Implementation notes:

- The current scaffold keeps the Deno deploy target intact while creating a clean place for Cloudflare-specific runtime adapters.
- Durable Objects are modeled per bundle key, not as one global singleton.
- The Worker now runs the shared bundle pipeline directly and persists finished metadata in KV. R2 artifact storage is optional and currently disabled in config.
- With R2 disabled, cached `?file` requests rebuild the bundle on demand instead of serving a persisted artifact.
- Manual Cache API caching is still deferred. The current Worker relies on normal response caching semantics first, and Durable Objects plus KV remain the canonical app-state layers unless R2 is re-enabled.