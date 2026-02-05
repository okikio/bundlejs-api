# ASCII Diagram Patterns

## Sequence

Client
  |
  |  GET /v1/bundle?q=...
  v
Edge Handler
  | validate(query)
  | cache lookup
  | (miss) execute bundle
  | cache write
  v
Response (ok envelope)

## Data transform pipeline

raw input
  -> decode/normalize
  -> validate (zod)
  -> transform to internal config
  -> execute
  -> format output envelope
