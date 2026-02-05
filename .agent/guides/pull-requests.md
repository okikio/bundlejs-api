# Pull Request Title + Description Instructions

## PR Title
Use Conventional Commit style:
`type(scope optional): outcome`

- Prefer outcome-focused summaries (“return RFC7807 on validation failure”)
- Avoid vague titles (“update handler”, “misc fixes”)
- Scope is optional; only include it when it’s obvious.
- The title must describe an observable outcome (behavior, contract, or workflow), not “add guidelines / improve quality.”

## PR Description (structured, but narrative)
Write for reviewers and future archaeology. Be concrete.

### Summary
1–3 bullets describing the outcome and what changed (name the subsystem).
Avoid generic goals like “improve quality” unless tied to a specific behavior change.

### Problem / Motivation
Describe the real issue (bug, inconsistency, missing feature, confusing workflow).
Anchor it: “Before, X happened…” / “Clients couldn’t…” / “Reviewers had to…”

### Solution
What you changed, at a high level, and where (folders/modules).
If this introduces conventions/docs, say what confusion it eliminates.

### Behavior changes
If anything observable changes, list it plainly:
- API response shape changes
- error format changes
- caching behavior changes
- performance/limits changes

### Verification
- List commands or manual checks.
- If not verified, propose the best verification steps (don’t claim you ran them).

### Risk & rollout (when relevant)
- What could break?
- Edge cases / failure modes
- Mitigations

## Writing constraints
- Prefer short bullets and concrete nouns.
- Avoid memo-speak (“enhance process”, “ensure quality”, “various aspects”).
- Do not invent issue numbers, links, or test results.
