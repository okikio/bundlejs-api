# Commit Message Generation Instructions
Conventional Commits + plain English that reads like a purposeful change log entry.

## Subject line (required)
Format:
`type(scope)!: summary`

Rules:
- `type` ∈ `feat|fix|refactor|perf|docs|test|build|ci|chore|revert`
- Prefer scopes: `edge`, `endpoints`, `core`, `compress`, `utils`, `shared`, `deps`, `ci`, `docs`
- Summary:
  - imperative mood (“add”, “fix”, “remove”, “prevent”, “document”)
  - concrete (name the thing that changed)
  - no period
  - keep it short

Breaking changes:
- Use `!` and/or add footer `BREAKING CHANGE: ...` (plain English).

## Body (optional but strongly preferred unless trivial)
Write as 2–5 short sentences OR 1–4 bullets.
No labeled headers.

### Narrative constraints (this is the important part)
The body must:
- Start with a concrete motivation (a real pain/failure/need), not a generic “improve quality/process”.
- Use active voice.
- Mention the area touched (endpoint/core/plugin/docs/etc.) and what changed at a high level.
- Include impact in plain terms (“prevents X”, “makes Y consistent”, “reduces Z confusion”).
- If verification is non-obvious, add a final sentence with a verification step.
  - If you can’t confirm, say “Should verify by …” (don’t claim tests ran).

### Avoid memo-speak (hard rules)
Do NOT write bodies like:
- “To enhance the development process…”
- “A set of guidelines has been introduced…”
- “Various aspects…”
- “High-quality code…”
- “Improve maintainability…” (unless you say what specifically became easier/safer)

If the change is docs/guidelines, be specific about what was added and why:
- name the documents/areas (commit/PR/review instructions, endpoint patterns, core plugin rules)
- state what inconsistency/confusion it solves

## Examples

### Docs / guidelines change (good)
docs(repo): add Copilot guidance for commits, PRs, and reviews

Make git history and PRs easier to read by standardizing how we explain changes.
Add Copilot instruction files for commit messages, PR descriptions, and code review comments.
This reduces “mystery meat” changes by pushing authors to name the problem, the change, and the expected impact.

Should verify by generating a commit/PR message once and checking for Conventional Commit format.

### Bug fix (good)
fix(core): clean up resolver state when builds abort

Aborted builds were leaving per-build resolver state reachable longer than needed.
Ensure cleanup runs on abort/error paths so memory doesn’t grow under bursty traffic.

Manually checked by aborting a bundle mid-flight and confirming cleanup triggers.

### Too abstract (bad)
docs(repo): add guidelines

To enhance the development process and ensure high-quality code, a set of guidelines has been introduced.
These documents cover various aspects of coding standards, documentation practices, and error handling.
