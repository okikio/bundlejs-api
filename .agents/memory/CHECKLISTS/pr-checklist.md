# PR Checklist

## Intent

- [ ] The PR title and description explain outcome, problem, and motivation.
- [ ] The title follows Conventional Commit format (see
      `pull-requests.instructions.md`).

## Changes

- [ ] Changes are scoped to the stated intent.
- [ ] Risky or breaking behavior changes are called out explicitly.

## Verification

- [ ] `deno task test` passes.
- [ ] `deno task bench` passes (if benchmarks exist for the changed area).
- [ ] `deno lint` passes.
- [ ] `deno doc --lint mod.ts` passes for affected modules.
- [ ] Failure modes and error paths were considered.

## Documentation

- [ ] TSDoc is updated for any changed public API.
- [ ] Architecture or endpoint docs updated if user-facing behavior changed.
- [ ] Decisions that affect contracts are captured in an ADR.
