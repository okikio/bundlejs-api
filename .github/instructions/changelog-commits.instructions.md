---
description: Commit message and changelog standards for this repo
applyTo: "**"
---

# Commit Messages and Changelogs

## Commit messages

### Format (conventional commits)

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Syntax rules — every commit must satisfy all of these:**

| Rule                                | Correct             | Wrong                          |
| ----------------------------------- | ------------------- | ------------------------------ |
| Type is lowercase                   | `fix:`              | `Fix:`, `FIX:`                 |
| Single space after colon            | `fix: avoid`        | `fix:avoid`, `fix:  avoid`     |
| No period at end of subject         | `fix: avoid crash`  | `fix: avoid crash.`            |
| Subject capitalised                 | `feat: Add align()` | `feat: add align()`            |
| Blank line between subject and body | _(blank line)_      | body immediately after subject |
| No trailing whitespace              | —                   | lines ending with spaces       |
| No emoji in subject                 | `feat: add embed()` | `✨ feat: add embed()`         |

**Preferred scopes for this repo:** `core`, `edge`, `endpoints`, `shared`,
`compress`, `utils`, `deps`, `ci`, `docs`

Use a `!` after the type/scope to mark breaking changes:
`feat(core)!: remove legacy CDN fallback`

### Anti-patterns — never write these

**Typeless / formatless subjects** — no `type:` prefix means tooling cannot
categorise the commit:

```
# Bad — no type, nothing actionable
update
fix stuff
typo
changes

# Good
docs: Fix typo in dedentString example
fix(core): Handle empty string in columnOffset
```

**WIP commits on main** — squash before merging:

```
# Bad — never let these reach main
WIP
WIP: almost working
temp fix
```

**Vague descriptions** — watch for weasel verbs: **enhance**, **improve**,
**update**, **refactor**, **tweak**, **clean up**, **address**, **various**.
None of them say what changed:

```
# Bad — describes nothing
docs: Enhance commit message and changelog standards
fix: Improve splitLines
chore: Update deps
refactor: Clean up mod.ts
fix: Address review comments

# Good — names what was added, fixed, or removed
docs: Add anti-patterns and syntax rules to commit instructions
fix(core): Handle bare \r as a line separator in splitLines
chore(deps): Bump @std/assert to 1.0.19
refactor(core): Extract rejoinLines into a standalone helper
```

**Scope as file path** — the scope names a logical area, not a file:

```
# Bad
feat(core/build.ts): Add streaming output

# Good
feat(core): Add streaming build output
```

**More than one logical change per commit** — if you need "and" to describe the
subject, it is two commits.

**`build` for infrastructure additions** — `feat` means a user-visible API
change. Build scripts, CI workflows, and developer tooling are infrastructure:

```
# Bad — no user-visible API changed
feat(build): Add npm package build script

# Good — infrastructure type
build(npm): Add package build script using @deno/dnt
ci: Add publish job to deploy workflow
```

### Choosing the right type

1. **Does it change what a _consumer_ of the API can do?** → `feat`
2. **Does it fix something broken?** → `fix`
3. **Does it only change docs or comments?** → `docs`
4. **Does it only change whitespace, formatting, or naming?** → `style`
5. **Does it restructure code without changing behavior?** → `refactor`
6. **Does it make something measurably faster or smaller?** → `perf`
7. **Does it add or fix tests?** → `test`
8. **Does it touch CI, build scripts, or dependencies?** → `chore` / `ci` /
   `build`

**Hard rule:** if the change would make a user's code behave differently at
runtime, it is `feat` or `fix` — never `refactor` or `chore`.

### Subject line rules

1. Target 50 characters; never exceed 72.
2. Lowercase the first word of the description.
3. No period at the end.
4. Use the imperative mood: "Add", "Fix", "Remove", not "Added", "Fixed".
5. Separate from the body with a blank line.

### Body rules

- Wrap at 72 characters.
- **Start with a concrete motivation** (a real pain/failure/need), not a generic
  "improve quality/process".
- Explain **why** the change exists, not what the diff contains.
- Mention the area touched (endpoint/core/plugin/docs/etc.) and what changed at
  a high level.
- Include impact in plain terms ("prevents X", "makes Y consistent", "reduces Z
  confusion").
- If verification is non-obvious, add a final sentence with a verification step.
  If you can't confirm, say "Should verify by …" — don't claim tests ran.
- Reference related issues with `Closes #123` or `Refs #123`.

### Breaking changes

Footer format:

```
BREAKING CHANGE: <what breaks>

<migration path — what callers must do instead>
```

Both the `!` in the subject and the `BREAKING CHANGE` footer are required so
tooling reliably detects the change.

### Atomic commits

One logical change per commit. If you are fixing a bug and refactoring unrelated
code, split them. A commit that cannot be summarized in 50 characters is
probably doing too much.

---

## Changelogs

The changelog is a communication contract with users. Write for human impact,
not technical accuracy.

### Writing changelog entries

Reference the user-visible symptom and the result of the fix, not the
implementation mechanism:

```md
<!-- Bad — implementation detail -->
- Fix async loop timing in build pipeline

<!-- Good — user-visible impact -->
- Fix builds hanging when the input package has circular subpath exports
```

### Calling out breaking changes

Prefix every breaking change entry with **Breaking:** and explain both what
breaks and what the migration path is:

```md
### Changed

- **Breaking:** The `/size` response no longer includes the `rawSize` field.
  Clients that read `rawSize` should use `uncompressedSize` instead.
```

### Subject line as changelog entry

The commit subject often feeds changelog generation verbatim. Write it as if it
describes **user-visible impact**, not implementation detail:

```
# Bad — implementation detail as subject
fix(core): Correct WeakMap lookup for cached build configs

# Good — user-visible symptom as subject
fix(core): Prevent stale results when rebuilding the same package
```

### Yanked releases

If a deployed version is reverted or rolled back, mark it explicitly rather
than deleting the entry:

```md
## [0.8.1] — 2025-01-15 [YANKED]

Rolled back due to a regression in tarball extraction. Use 0.8.2 instead.
```

---

## Release workflow

This section describes the deploy process at a high level. For current CI
details, check `.github/workflows/deploy.yml`.

1. Verify all checks pass: `deno task test`, `deno lint`
2. Review pending changelog entries
3. Merge to the deploy branch (triggers CI)
4. Verify the deployment in the target environment
