# Code Review Instructions (Selection Review)

Prioritize correctness, clarity, maintainability, and standards alignment.
Avoid noise: fewer, higher-signal comments.

## Review rubric (in order)

### 1) Correctness & contracts
- Does the code do what it claims?
- Are edge cases handled (invalid input, nulls, empty, timeouts, abort)?
- Are contracts consistent (e.g., endpoint definition vs handler behavior)?

### 2) Failure modes & safety
- Are errors explicit at boundaries (network/storage/etc)?
- Any secret leakage risk in logs?
- Any unsafe patterns (eval, string-built SQL, unvalidated inputs, etc)?

### 3) Types & schema alignment
- Avoid `any`; prefer `unknown` + narrowing, generics, unions.
- If Zod is involved, don’t prescribe `.strict()` globally.
  - Evaluate whether encode/decode/transform behavior matches intent.
  - If proposing schema changes, describe behavioral impact.

### 4) Readability & educational clarity
- Naming should be approachable and intent-revealing.
- Comments should explain why; if logic is non-obvious (regex/bitwise/tricky boolean), also explain what/how plainly.
- If the change’s intent isn’t obvious from the diff, suggest improving:
  - naming and/or comments/docstrings
  - OR the PR description to clearly state motivation and impact

### 5) Consistency & style
Match repo formatting and import conventions.

## Output format
- Use tags: [BLOCKER], [IMPORTANT], [SUGGESTION], [NIT]
- Provide concrete fix suggestions for BLOCKER/IMPORTANT.
- Avoid generic feedback like “improve quality”; always tie comments to a specific behavior, risk, or readability issue.
