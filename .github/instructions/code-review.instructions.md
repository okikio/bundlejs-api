---
description: Code review standards for this repo
applyTo: "**"
---

# Code Review

Prioritize correctness, clarity, maintainability, and standards alignment.
Avoid noise: fewer, higher-signal comments.

## Review rubric (in order)

### 1. Correctness & contracts

- Does the code do what it claims?
- Are edge cases handled (invalid input, nulls, empty, timeouts, abort)?
- Are contracts consistent (e.g., endpoint definition vs handler behavior)?

### 2. Failure modes & safety

- Are errors explicit at boundaries (network/storage/etc)?
- Any secret leakage risk in logs?
- Any unsafe patterns (eval, string-built SQL, unvalidated inputs, etc)?

### 3. Types & schema alignment

- Avoid `any`. Prefer `unknown` + narrowing, generics, unions.
- If Zod is involved, don't prescribe `.strict()` globally. Evaluate whether
  encode/decode/transform behavior matches intent.
- Return types at module boundaries should be explicit and narrow.

### 4. Readability & educational clarity

- Naming should be approachable and intent-revealing.
- Comments should explain _why_. For non-obvious logic (regex, bitwise, tricky
  boolean), also explain _what/how_ in plain English.
- If the change's intent isn't obvious from the diff, suggest improving:
  - naming and/or docstrings
  - OR the PR description to clearly state motivation and impact

### 5. Consistency & style

Match repo formatting and import conventions. See `typescript.instructions.md`.

## Output format

Use tags: `[BLOCKER]`, `[IMPORTANT]`, `[SUGGESTION]`, `[NIT]`

- Provide a concrete fix suggestion for every `[BLOCKER]` and `[IMPORTANT]`.
- Avoid generic feedback like "improve quality" — tie every comment to a
  specific behavior, risk, or readability issue.
