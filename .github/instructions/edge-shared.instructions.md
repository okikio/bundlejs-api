---
description: Edge shared module rules
applyTo: "edge/_shared/**"
---

# Edge Shared Modules (edge/_shared)

These modules are reused across endpoints. Optimize for correctness, composability, and low coupling.

## Boundaries

- Avoid importing from `edge/endpoints/**` (prevent circular dependencies).
- Keep side-effects minimal; prefer explicit initialization points.

## Response helpers & schemas

- Keep responses consistent (Problem Details / success envelopes).
- Helpers should remain easy to use from handlers (`c.json(...helper())` style).

## Zod usage

- Prefer schema inference instead of re-declaring types.
- Transformations are allowed (pipes/transforms/encode/decode). Don’t force strictness globally.

## Docs

- Shared utilities are “teaching surfaces”: short docstrings + examples beat clever code.
- For tricky utilities (cache keys, parsing, encoding), include algorithm steps and ASCII.
