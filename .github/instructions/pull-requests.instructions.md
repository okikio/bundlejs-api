---
description: PR title, description, and design doc standards for this repo
applyTo: "**"
---

# Pull Requests

## Title

Use Conventional Commit style: `type(scope optional): outcome`

- Prefer outcome-focused summaries ("prevent double-build on aborted requests")
- Avoid vague titles ("update handler", "misc fixes")
- The title must describe an observable outcome (behavior, contract, or
  workflow), not "add guidelines / improve quality"
- See `changelog-commits.instructions.md` for type/scope/breaking-change rules

## Description

Write for reviewers and future archaeology. Be concrete.

**Summary** — 1–3 bullets: what changed and in which module/function.
No generic goals like "improve quality" unless tied to a specific behavior
change.

**Problem / Motivation** — the real issue. Anchor it: "Before, X happened…" /
"Clients couldn't…" / "Builds failed when…"

**Solution** — what changed at a high level and where (files/functions).

**Behavior changes** — if anything observable changes, list it plainly:

- API response shape changes
- error format changes
- caching behavior changes
- performance / limits changes
- breaking API changes (see `changelog-commits.instructions.md`)

**Verification** — list test commands and manual checks. If not verified, say
"Should verify by…" — don't claim you ran them.

**Risk & rollout** (when relevant) — what could break, edge cases, mitigations.

## Writing constraints

- Short bullets and concrete nouns.
- Avoid memo-speak ("enhance process", "ensure quality", "various aspects").
- Do not invent issue numbers, links, or test results.

## Design docs and specs

When a PR introduces a non-trivial behavioral change or a new public API,
include a design note using RFC structure:

1. **Problem** — what is broken or missing
2. **Goals / Non-goals** — scope and explicit exclusions
3. **Constraints** — runtime, compatibility, performance, security
4. **Proposal** — the approach, with ASCII diagrams if helpful
5. **Alternatives considered** — why not the other options
6. **Edge cases & failure modes**
7. **Observability** — logs, metrics, traces relevant to the change
8. **Open questions**

Prefer concrete examples over abstract statements. Call out trade-offs
explicitly. Keep decision points obvious so reviewers can challenge them.
