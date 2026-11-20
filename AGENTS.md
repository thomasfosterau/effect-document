# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; this file adds only what is specific to agents.

## Before changing code

- Read [packages/core/AGENTS.md](packages/core/AGENTS.md): the package's import boundaries and the invariants each format keeps.
- Read the issue you're working on in full, comments included, and re-check its claims against current `trunk`.

## Pitfalls

- `vp check` (format + lint) and `vp run check` (the type gate) are different commands.
- The pre-commit hook runs the full coverage suite before `fallow audit`; expect a commit to take a couple of minutes.
- Corpus, validate and interop suites need the network, `xmllint`, or LibreOffice / qpdf / poppler / pandoc; locally they skip without them. Say in the PR body which gates didn't run.
- Publish only through the Release workflow (`vp run release`: `vp pm publish -r`, then `changeset git-tag`). Release-path registry calls go through `vp pm`, never `npm` / `pnpm` directly; `check:pack`'s consumer install is a check, not a publish.
- The feature matrix in `packages/core/docs/formats.md` is generated: when a profile changes, `test/integration/feature-matrix.test.ts` prints the table to paste.
- Write idiomatic Effect v4 and read `node_modules/effect` rather than guessing an API. Hot-path lint allowances with measured reasons stay. Non-idiomatic code you find outside your change gets an issue listing the sites and the replacement, unless the fix is trivial.

## Process

- You may open PRs in this repository, and should watch them through CI and review.
- Out-of-scope work you notice: file an issue (search for duplicates first) and move on.
- Use the GitHub MCP tools or `gh`, whichever is available. Write only to `thomasfosterau/effect-document`; with `gh`, pass `-R thomasfosterau/effect-document` when the cwd might be another checkout.

## Fallow

The `fallow` agent skill is linked into `.claude/skills/` from the installed `fallow` package after `vp install`; repository-specific rules (the pre-commit audit, tracing before deleting) are in docs/CONTRIBUTING.md.
