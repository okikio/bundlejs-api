# Review Checklist

## Correctness

- [ ] Behavior matches the stated intent.
- [ ] Edge cases and error paths are handled explicitly.

## Safety

- [ ] No unsafe patterns (eval, silent fallbacks, implicit coercions).
- [ ] Secrets are not logged or stored.
- [ ] Trust boundaries are clear.

## Maintainability

- [ ] Naming is clear, intent-revealing, and consistent with the existing API.
- [ ] Complex logic is explained with comments or ASCII diagrams.

## Verification

- [ ] `deno task test` passes.
- [ ] `deno lint` passes.
- [ ] `deno doc --lint mod.ts` passes for affected modules.
- [ ] Verification steps are adequate for the stated change.
