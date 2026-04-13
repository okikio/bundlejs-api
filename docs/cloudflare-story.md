# The Cloudflare Story

bundlejs-api is adding a Cloudflare runtime because Cloudflare gives the project a cleaner edge and storage story than the current mix of Deno Deploy, Upstash Redis, and GitHub Gists. The goal is not a blind platform migration. The goal is to modernize the Deno runtime first, stabilize the bundle service contract under `services/deno`, then build a Cloudflare-native runtime beside it and keep moving shared logic downward until the storage and runtime edges become thin adapters instead of places where bundle behavior is duplicated.

That distinction matters. A straight lift-and-shift would keep the old shape and just rename services. The Cloudflare plan is different: Workers handle request and response flow, Durable Objects handle per-bundle coordination, Workers KV stores finished metadata, R2 stores bundle artifacts, and the shared bundle engine stays independent of the runtime. What you get is a service that is easier to reason about, easier to operate, and much less dependent on third-party infrastructure for core request paths.

## Why This Migration Exists

The old runtime works, but it makes one request travel through too many unrelated systems:

- Deno handles the HTTP edge surface.
- Upstash Redis caches bundle metadata and badge variants.
- GitHub Gists hold file artifacts when bundle output needs to be fetched later.

That arrangement is functional, but it creates operational drag:

- cache state and artifact state live in different vendors
- invalidation is harder than it should be
- GitHub starts treating repeated artifact creation like spam
- request coordination and cache storage are mixed together in Redis-shaped code

Cloudflare gives the project a better-native split:

- one edge runtime for requests
- one consistent storage family for metadata, coordination, and artifacts
- first-party primitives close to the request path

The migration also started with a real platform constraint: bundlejs-api currently leans on inlined JavaScript that embeds esbuild WebAssembly (WASM). That is convenient for Deno-style runtime bootstrapping, but it is not a great long-term fit for Cloudflare Workers bundle limits. The Cloudflare path therefore needs a runtime design that can evolve away from a giant inlined blob and toward a cleaner Workers-compatible WASM loading story.

## The Core Bet

The project is betting on a simple principle:

> Keep the bundling algorithm shared. Make the runtime and storage layers replaceable.

That principle drives every major Cloudflare decision:

- the Deno runtime gets cleaned up before Cloudflare becomes the primary migration target
- the Deno runtime stays alive while Cloudflare grows beside it
- request parsing and bundle execution move into shared modules
- Cloudflare-specific code focuses on bindings, persistence, and response handling
- storage services are chosen by behavior, not by convenience

This is the intended split:

```text
                   bundlejs-api Runtime Shape

                    Shared bundling logic
                              │
          ┌───────────────────┴───────────────────┐
          │                                       │
          ▼                                       ▼
   services/deno                          services/cloudflare
   Deno adapter                           Worker adapter
   Existing production path               New edge target
          │                                       │
          ▼                                       ▼
   Redis + Gists                         KV + Durable Objects + R2
   Legacy cache/artifact stack           Cloudflare-native storage stack
```

The long-term direction is to reduce the amount of runtime-specific logic above the shared bundling engine until each runtime mostly answers three questions:

1. How does the request enter?
2. Where do cached results and artifacts live?
3. How are responses rendered for this environment?

## Why The Deno Modernization Comes First

The repository now makes the sequencing much clearer than the earlier edge prototype did. The current Deno runtime is being broken into explicit service modules:

- request parsing and cache orchestration in [services/deno/_shared/bundle/request.ts](../services/deno/_shared/bundle/request.ts)
- build execution in [services/deno/_shared/bundle/service.ts](../services/deno/_shared/bundle/service.ts)
- legacy response rendering in [services/deno/_shared/bundle/legacy-response.ts](../services/deno/_shared/bundle/legacy-response.ts)
- cache primitives in [services/deno/_shared/cache/operations.ts](../services/deno/_shared/cache/operations.ts)

That is the right order of operations. If the Deno runtime gets refactored into a stable internal bundle service first, then Cloudflare support becomes a thinner adapter exercise instead of a second place where old edge behavior gets reimplemented from scratch.

This is the intended sequencing:

```text
Phase 1: services/deno modernization
   │
   ├─ make request parsing explicit
   ├─ make build execution explicit
   ├─ make legacy response rendering explicit
   └─ make cache behavior explicit
   │
   ▼
Phase 2: services/cloudflare support
   │
   ├─ reuse the same bundle contract where possible
   ├─ swap storage roles to KV, Durable Objects, and R2
   └─ keep Cloudflare-specific code focused on bindings and response surfaces
```

That means the Cloudflare story is not “leave Deno behind.” It is “use the Deno modernization to expose the seams Cloudflare needs.”

## What Each Cloudflare Service Is For

The Cloudflare design only works if each service has one clear job.

| Service | Job in bundlejs-api | Why it fits |
| --- | --- | --- |
| Workers | Handle HTTP requests and responses | Workers are the front door. They are the right place for routing, CORS, static passthrough, cache lookup, and synchronous bundle execution. |
| Durable Objects | Coordinate one bundle key at a time | A Durable Object gives strong consistency per object. That makes it the right place for in-flight dedupe, build status, and per-key state transitions. |
| Workers KV | Store finished bundle metadata and badge cache entries | KV is a good fit for read-heavy, TTL-backed metadata lookups where eventual consistency is acceptable after a build completes. |
| R2 | Store bundle artifacts such as generated JavaScript files | R2 is the correct place for arbitrary bundle output bytes. It replaces the old GitHub Gist artifact role cleanly. |
| Static asset binding | Serve `.well-known` and other static files | This keeps non-bundle assets out of the bundling path. |
| Cache API | Deferred for now | Response caching headers already express the desired cacheability. Cache API adds complexity and is POP-local, so it is not the first tool to reach for. |
| Workflows | Deferred for future asynchronous jobs | Workflows only become useful if bundle requests need to leave the request-response path and become durable background jobs. |

The important line is between canonical state and acceleration layers:

- Durable Objects, KV, and R2 are canonical application-state layers in the Cloudflare plan.
- Cache API is only an accelerator if later measurements show a need.

That is why Cache API is intentionally not in the critical path today.

## Why We Are Not Starting With Cache API

The Worker already returns cacheable responses with explicit `Cache-Control` headers. That matters because Cloudflare can already do useful response caching from normal HTTP semantics. A manual Cache API layer is therefore not free value. It adds another storage surface, another invalidation surface, and another place where readers can confuse “edge-local response cache” with “canonical application state.”

For this service, that distinction matters a lot:

- KV is where a finished bundle result is looked up globally enough for application behavior.
- R2 is where bundle artifact bytes live.
- Durable Objects decide whether a build is queued, running, complete, or errored.

Cache API would be a performance optimization on top of that, not a correctness primitive.

The current stance is:

- rely on normal response cache headers first
- measure whether the remaining Worker-to-KV or Worker-to-R2 traffic is still too expensive or too slow
- only then decide whether an explicit Cache API layer is worth the added operational surface

That is a stricter design than “Cloudflare has a cache, so we should use it.” It keeps the architecture legible.

## How a Bundle Request Is Supposed to Flow

The Cloudflare request path is designed around deterministic keys and one coordinator per normalized bundle request.

```text
Client Request
   │
   ▼
services/cloudflare/src/index.ts
   │
   ├─ parse request and normalize bundle inputs
   │
   ├─ derive bundleKey, jsonKey, badgeID, and optional package cache key
   │
   ├─ check KV for finished metadata
   │      │
   │      ├─ hit: render cached response
   │      └─ miss: continue
   │
   ├─ ask Durable Object for per-key status
   │      │
   │      ├─ running: return in-flight status
   │      └─ not running: mark running
   │
   ├─ execute shared bundle pipeline
   │
   ├─ write artifact bytes to R2
   │
   ├─ write bundle metadata to KV
   │
   ├─ clear stale badge entry
   │
   ├─ mark Durable Object complete or errored
   │
   └─ render response
```

The key design decision is that the artifact key is deterministic. The Worker derives it from the bundle key instead of asking another service to invent one. That means R2 remains the real artifact namespace, not a subordinate store hidden behind Durable Object state.

## What the Repository Looks Like Today

The repository now has a runtime split under `services/`:

```text
services/
├── cloudflare/
│   ├── src/index.ts
│   ├── src/storage.ts
│   ├── src/result.ts
│   ├── src/durable-objects/bundle-coordinator.ts
│   └── wrangler.jsonc
├── deno/
│   ├── endpoints/
│   ├── _shared/bundle/
│   ├── _shared/cache/
│   └── _shared/external/
└── legacy/
```

This split is intentional:

- [services/deno](../services/deno) is the current Deno runtime.
- [services/cloudflare](../services/cloudflare) is the Cloudflare runtime target.
- The Deno runtime is being modernized into more explicit service modules before Cloudflare becomes the main follow-on runtime adapter.
- The shared bundling engine still lives lower in the repo and is reused by both runtimes.

There is still a transitional wrinkle: some Cloudflare code imports helpers from older shared locations, while the Deno runtime is actively being reorganized under `services/deno/_shared`. That is acceptable in the short term, but it is not the end state. The end state is a clearer shared layer that does not conceptually belong to only one runtime.

## What Exists Today Versus What Is Committed Direction

Two things are true at once:

- there is already meaningful Cloudflare prototype work in [services/cloudflare](../services/cloudflare)
- the immediate implementation priority is still the Deno modernization, after which Cloudflare support becomes the next runtime step

That distinction is important because this document is partly architecture and partly migration plan. It should not blur “there is code here today” with “this is already the main production path.”

## What Is Already Implemented

The Cloudflare runtime is no longer only a scaffold. The following pieces already exist:

- Worker entrypoint in [services/cloudflare/src/index.ts](../services/cloudflare/src/index.ts)
- KV-backed bundle metadata and badge storage in [services/cloudflare/src/storage.ts](../services/cloudflare/src/storage.ts)
- R2-backed artifact storage in [services/cloudflare/src/storage.ts](../services/cloudflare/src/storage.ts)
- per-bundle coordinator Durable Object in [services/cloudflare/src/durable-objects/bundle-coordinator.ts](../services/cloudflare/src/durable-objects/bundle-coordinator.ts)
- Worker-specific response rendering in [services/cloudflare/src/result.ts](../services/cloudflare/src/result.ts)
- Wrangler bindings for KV, R2, assets, and Durable Objects in [services/cloudflare/wrangler.jsonc](../services/cloudflare/wrangler.jsonc)

The Worker already handles these request shapes through the shared bundle path:

- `/`
- `/bundle`
- `/file`
- `/badge`
- `/badge/raster`
- `/badge-raster`
- `/analysis`
- `/analyze`
- `/metafile`
- `/raw`
- `/warnings`
- `/no-cache`
- `/delete-cache`
- `/jobs/:bundleKey`

That matters because the migration is not theoretical anymore. The Cloudflare runtime already proves the core service mapping, even if the Deno modernization still comes first in the rollout sequence:

- Workers can execute the shared bundle logic.
- Durable Objects can coordinate normalized bundle requests.
- KV can hold finished metadata and badge variants.
- R2 can replace GitHub Gists for artifact storage.

## What Cloudflare Replaces From the Old Stack

This is the old-to-new mapping the project is aiming for.

| Old role | Old implementation | Cloudflare replacement | Reason |
| --- | --- | --- | --- |
| Finished bundle metadata cache | Upstash Redis | Workers KV | The access pattern is mostly key-value reads with TTL. |
| Badge cache | Upstash Redis hash | Workers KV | Badge variants are small, read-heavy, and can be keyed deterministically. |
| In-flight build coordination | Redis-shaped request locking and status assumptions | Durable Objects | This needs strong per-key consistency, not eventual consistency. |
| Bundle artifact storage | GitHub Gists | R2 | Artifacts are real objects, not GitHub content. |
| Static edge serving | Deno edge route logic | Workers assets binding | Static file serving belongs in the runtime’s native asset path. |

The big philosophical change is that Redis is no longer treated like the answer to every storage question. Cloudflare services are being chosen by consistency model and storage shape instead.

## Why Durable Objects Are Narrowly Scoped

Durable Objects are powerful enough to tempt people into making them do everything. This project is intentionally resisting that temptation.

Durable Objects are not the main object store. They are not the global cache. They are not the place where finished JavaScript bundle bodies should live. They are the per-bundle coordinator.

That means their job is limited to things like:

- `queued`
- `running`
- `complete`
- `errored`
- normalized request identity
- future job metadata if asynchronous execution is introduced

This narrow scope keeps Durable Objects valuable instead of expensive. If all artifact bytes or all cache entries were pushed into Durable Objects, the architecture would get more complicated and less Cloudflare-native at the same time.

## Why KV Is Good Enough for Finished Metadata

KV is eventually consistent, which sounds scary until the actual requirement is stated clearly.

For bundlejs-api, the finished-result metadata cache does not need to be the place where “only one build may run” is decided. That is the coordinator’s job. Once a build is complete, KV is a good fit because the read pattern is much heavier than the write pattern, and the values are plain serialized result objects.

That lets the design split correctness from distribution:

- Durable Object for correctness during build coordination
- KV for distributed reads after a bundle result exists

That is a better fit than trying to use KV as a lock manager or trying to use Durable Objects as a global read cache.

## Why R2 Is the Right Gist Replacement

GitHub Gists were always a workaround. They gave the project a remotely retrievable file artifact, but they were not a storage system designed for bundle output. Once GitHub starts seeing the project as automated content churn, the mismatch becomes impossible to ignore.

R2 fixes that mismatch directly:

- bundle artifacts are binary or text objects, which is exactly what R2 stores
- artifact retrieval is part of the same platform as the Worker
- invalidation no longer requires external GitHub cleanup logic
- the artifact key can be deterministic and derived from `bundleKey`

This is one of the cleanest wins in the migration. It removes an entire category of awkward external dependency from the request lifecycle.

## The Hard Question: Synchronous Builds Or Async Jobs

The next major architecture question is not really about Cloudflare. It is about the bundle service model itself.

The thought experiment is straightforward:

- bundling inside an edge request feels great when caches are warm and graphs are small
- bundling inside an edge request becomes risky when traffic spikes, dependency fetches are slow, or a bundle graph is large

That tension is especially visible on Deno Deploy because the platform puts real pressure on CPU budgets, memory ceilings, and request lifetimes. A bundler that performs network fetches, module parsing, tree-shaking, compression, and response formatting inside one request handler can look stable until it suddenly is not.

This creates a real design fork for the service layer that both runtimes will eventually care about.

### Option 1: Stay synchronous

This is the current bias of the system.

It works best when:

- most requests are cache hits
- misses are small and fast
- users benefit from a simple request-response contract
- the runtime can complete the whole pipeline within strict time budgets

The upside is simplicity. The downside is that load spikes and long-tail bundle graphs can become runtime problems instead of just user-latency problems.

### Option 2: Go fully asynchronous

This would turn bundle execution into jobs:

- accept request
- return `202 Accepted`
- store status in a coordinator
- build in the background
- let clients poll or stream job progress

The upside is operational control. The downside is that the service contract becomes more complex, especially for the common case where the build would have finished quickly.

### Option 3: Use a hybrid fast path plus queued fallback

This is the most compelling long-term thought experiment so far.

The flow would look like this:

```text
Request
   │
   ├─ cache hit  ───────────────▶ 200 result
   │
   └─ cache miss
      │
      ├─ finishes inside strict budget ─▶ 200 result
      │
      └─ exceeds budget or looks heavy ─▶ 202 job accepted
                       │
                       ├─ poll status
                       ├─ fetch result later
                       └─ optionally stream progress
```

This keeps the common case fast without forcing the runtime to pretend every bundle should happen inline forever.

## Why Streaming Is A UX Tool, Not A Resource Fix

Streaming build logs is attractive because it makes a long-running build feel alive. That is real product value. It is not fake.

But streaming does not reduce CPU or memory cost. It changes user confidence, not resource consumption.

That is why streaming should be treated as a visibility feature layered on top of either:

- synchronous inline builds
- asynchronous job execution

It is not a substitute for cache strategy, concurrency control, or a queue fallback.

The Deno modernization makes this easier to reason about because the service is already being split into:

- parsing
- execution
- response formatting

Once those seams are stable, a future `ProgressSink` or job-state layer can attach to the service contract without forcing every runtime handler to invent its own progress model.

## What This Means For The Cloudflare Plan

Cloudflare does not remove the sync-versus-async question. It just changes which primitives are available when the project answers it.

If the project stays synchronous for the main path, the Cloudflare design already makes sense:

- Worker handles the request
- Durable Object coordinates one bundle key
- KV caches finished metadata
- R2 stores artifacts

If the project moves to a hybrid or async model later, the same service mapping still holds:

- Worker accepts request and returns status endpoints
- Durable Object tracks in-flight state and job status
- KV stores completed metadata
- R2 stores artifacts
- Workflows or another async mechanism can be introduced only when the service contract actually needs durable background execution

That is one reason Workflows remain explicitly deferred. The project should answer the bundle-service contract question first, then choose the async primitive that fits the answer.

## The WASM Constraint Still Shapes the Plan

Cloudflare is a better runtime target for the service shape, but it does not erase the esbuild WebAssembly constraint.

The project still needs to respect the fact that Workers are not a great home for a forever-growing inlined JavaScript blob that embeds WASM bytes directly. That is why the Cloudflare story is also a packaging story:

- keep the current shared bundling path working
- move toward a Workers-friendly WASM loading model
- avoid designing the Cloudflare runtime around a packaging trick that only felt natural in the Deno path

This is one reason the migration is staged. Storage migration and runtime migration can move ahead even while the WASM packaging story is still being refined.

## What Is Still Intentionally Unfinished

Several pieces are intentionally deferred because they are not necessary to prove the architecture.

### Manual Cache API caching

Deferred because normal response caching semantics are already in play, and the canonical storage story is more important right now than adding a POP-local response cache layer.

### Workflows

Deferred because bundle requests are still effectively synchronous today. Workflows only become compelling if the project chooses an explicit asynchronous build model, retries, or long-running background processing.

### Full route parity

The Deno runtime still has older admin and compatibility surfaces that are not fully mirrored in the Cloudflare runtime yet. The project is prioritizing the bundle-critical path first.

### Final shared module placement

Some modules reused by Cloudflare still come from places that conceptually belong to the older runtime layout. The migration story is still moving those boundaries downward.

## The Migration Phases

The work so far suggests a practical phase order.

1. Modernize `services/deno` into explicit bundle request, bundle execution, legacy response, and cache layers.
2. Create and refine a dedicated Cloudflare runtime workspace under `services/cloudflare`.
3. Share request preparation and bundle execution logic instead of duplicating it.
4. Replace external artifact storage with R2.
5. Replace Redis-shaped finished-result storage with KV.
6. Use Durable Objects only for per-key coordination.
7. Decide whether the bundle service stays synchronous or moves to a hybrid queue fallback model.
8. Remove remaining runtime-specific coupling from shared code.
9. Revisit Cache API and Workflows only after real traffic data and service-shape decisions say they are necessary.

This is the right order because it moves the correctness boundaries first and the optimizations second.

## Operational Notes for Future Readers

If you are picking this work up later, these are the main things to keep in your head.

- The Cloudflare runtime is not meant to imitate Redis or GitHub Gists. It is meant to replace those roles with Cloudflare-native primitives.
- Durable Objects are the coordinator, not the main cache and not the artifact store.
- KV is acceptable because it stores completed result metadata, not in-flight correctness state.
- R2 is the real place for bundle artifacts.
- Cache API is a performance optimization that should be added only if measurements justify it.
- The Deno bundle service refactor is not a detour from Cloudflare. It is the precondition for doing Cloudflare cleanly.
- The sync-versus-async question is still open. The current design should preserve the option to adopt a fast-path plus queued fallback model later.
- The Deno runtime still matters during migration. Do not break it just to make Cloudflare look cleaner sooner.
- The shared bundle engine is the real product. Runtime adapters should keep getting thinner.

## The Document in One Sentence

bundlejs-api is moving toward Cloudflare by first modernizing the Deno bundle service into explicit layers, then using Workers as the front door, Durable Objects as the coordinator, KV as the finished-result metadata cache, R2 as the artifact store, and shared bundle logic as the stable center of the system, while deliberately deferring extra layers such as Cache API and Workflows until they are justified by real behavior and by the eventual answer to the sync-versus-async service question rather than by platform enthusiasm.