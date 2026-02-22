# Release Checklist

## Scope

- [ ] Release intent is documented.
- [ ] Backwards compatibility risks are identified and called out.

## Artifacts

- [ ] Versioning and changelog are updated when applicable.
- [ ] Release notes summarize user-visible changes.
- [ ] Breaking changes are prominently marked with migration paths.

## Validation

- [ ] `deno task test` passes on the release commit.
- [ ] `deno task bench` passes on the release commit.
- [ ] `deno lint` passes.
- [ ] `deno doc --lint mod.ts` passes for all public modules.
- [ ] Key flows are verified in the target environment (e.g.,
      `supabase functions serve` smoke test for edge functions).

## Rollback

- [ ] Rollback plan is clear if a regression is found post-deploy.
- [ ] Yanked/reverted releases are marked in release notes with an
      explanation and a pointer to the replacement version.
