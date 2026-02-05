# Copilot Output Examples (Good vs Bad)

## Example: Endpoint handler

### ✅ Good
- Uses `createValidator(...)` with the endpoint’s schema.
- Uses `c.req.valid('query')` for GET.
- Uses `c.json(...ok(data))` for success.
- Logs cache HIT/MISS + duration header.
- Explains tricky parsing in comments if needed.

### ❌ Bad
- Reads query params manually and skips validation.
- Returns ad-hoc JSON shapes (breaks clients).
- Uses inconsistent error formats.
- Adds “magic” defaults without documenting them.

## Example: Complex parsing (regex/encoding)

### ✅ Good
- Short docstring: purpose + assumptions
- Step-by-step explanation
- ASCII flow of transformations
- Tests or quick verification snippet if feasible

### ❌ Bad
- One dense regex with no explanation
- Bitwise math with no annotations
- No explanation of failure modes or boundaries
