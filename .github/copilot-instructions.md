# Copilot Instructions (Always-On)

## Purpose
Assist a senior engineer who values clarity, reproducibility, standards/specs, and architectural rigor.
Optimize for maintainability and future-proofing without drifting into “abstraction for abstraction’s sake”.

## Default operating mode
- Be high-signal and explicit.
- Prefer the smallest correct change first.
- If requirements are ambiguous, ask **one** focused question. If you can still move forward, propose **2–3** options with trade-offs and a recommendation.
- Don’t invent APIs/files/config. If you can’t see it, state assumptions and give a verification step.

## Project context: bundlejs-api
A bundle size analysis API built on Deno + TypeScript.
- Runtime: Deno v2 (ESM)
- API: Hono on Supabase Edge Functions
- Build engine: esbuild (WASM)
- Compression: gzip, brotli, zstd, lz4

Workspace:
- `core/`      — bundle execution engine (esbuild wrapper + plugins)
- `edge/`      — API endpoints (Hono/Supabase)
- `utils/`     — shared utilities (often re-exports from `@std`)
- `compress/`  — compression algorithms

## Philosophy (how to write code here)

### Standards, specs, conventions
- Prefer established standards/specs and common conventions.
- If multiple standards exist, call out differences and the practical trade-offs.
- Optimize for patterns that are easy to maintain, easy to follow, and easy to share.

### Naming
Names should be approachable and succinct, while still capturing:
- intent,
- the problem being solved,
- and the shape/nature of the solution.

Docs/comments should add nuance (and confidence), not compensate for unclear naming.

### Documentation & comments (educational codebase)
- Default: explain *why*.
- When the *what/how* is non-obvious (regex, bitwise/binary math, tricky boolean logic, performance hacks), also explain *what/how* in plain English so a junior dev can follow.

For complex logic, include:
- a short docstring (problem, reasoning & logic, purpose + assumptions),
- a step-by-step algorithm explanation,
- ASCII diagrams when they improve clarity.

### Error handling
- Fail loudly and explicitly; avoid silent fallbacks and implicit coercion.
- Use typed errors or discriminated unions when appropriate.
- At external boundaries (network/storage/queue/etc), make failure modes and retries/timeouts/cancellation explicit.

### Configuration
- Prefer explicit configuration when it materially changes behavior.
- Also choose good defaults so configuration stays minimal and unsurprising.

### Network & infrastructure: teach mode
When networking/infra is involved:
- define acronyms and key terms (WAN/LAN/SQM/bufferbloat/NAT/MTU/etc),
- explain slowly and methodically,
- use concrete examples and metaphors.

## Safety / Security / Privacy

- Default to least privilege.
- Avoid unsafe patterns (string-built SQL, unsafe eval, weak crypto).
- Don’t leak secrets in logs; call out trust boundaries for auth/permissions.

## Agent memory (file-based)
When acting as an agent on multi-step work:
- Read: `.agents/memory/ACTIVE/PLAN.md`, `TASKS.md`, `PROGRESS.md`
- Update `PROGRESS.md` after each meaningful step (what changed, what is next, what to verify)
- Mark tasks in `TASKS.md` as completed only when "Done when" checks are satisfied
- Do not store secrets, tokens, or private URLs in `.agents/memory/`
- Keep scratch notes in `.agents/memory/SESSIONS/` (gitignored)

## Where to look

### Instructions (always-on rules, auto-loaded by `applyTo`)

Targeted rules live under `.github/instructions/`. These are prescriptive —
follow them whenever you work on a matching file.

| File                              | Applies to                       |
| --------------------------------- | -------------------------------- |
| `typescript.instructions.md`      | `**/*.ts`, `**/*.tsx`            |
| `markdown-writing.instructions.md`| `**/*.md`, `**/*.ts`             |
| `ascii-diagrams.instructions.md`  | `**/*.ts`, `**/*.md`             |
| `core.instructions.md`            | `core/**`                        |
| `edge-shared.instructions.md`     | `edge/_shared/**`                |
| `endpoints.instructions.md`       | `edge/endpoints/**`              |

### Guides (situational reference, read on demand)

Reference material lives under `.agents/guides/`. These are descriptive —
read them when the task calls for it, not necessarily on every edit.

| File                        | When to read                                              |
| --------------------------- | --------------------------------------------------------- |
| `endpoint-architecture.md`  | Before adding or changing an endpoint                     |
| `stack-and-conventions.md`  | Quick runtime/formatting reference                        |
| `code-review.md`            | When reviewing a PR or diff                               |
| `pull-requests.md`          | When writing a PR title or description                    |
| `commit-messages.md`        | When crafting a commit message                            |
| `ascii-diagrams.md`         | When adding diagrams to docs or comments                  |
| `rfc-style-writing.md`      | When writing a design doc or spec for a non-trivial change|
