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
- [ ] Key flows are verified in the target environment.

## Rollback

- [ ] Rollback plan is clear if a regression is found post-deploy.
