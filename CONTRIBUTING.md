# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Conventions are in [AGENTS.md](AGENTS.md).

## Branches

Branch off `trunk`, rebase rather than merge, squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Setup

Node 22 or later and pnpm 11 (the version is pinned by `packageManager`; Corepack or `pnpm self-update` picks it up). `pnpm install` installs the workspace, the Vite+ git hooks and the Effect-patched `tsc` / `oxlint`.

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one required job, `ci`, whose steps are the gate list in [AGENTS.md](AGENTS.md#verification). Until the default branch is renamed from `main` to `trunk`, neither workflow triggers. [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one.
3. `git fetch origin main && git rebase origin/trunk`
4. Docs: the package `README.md` (its API table and examples) for any exported change; the package `CLAUDE.md` for a new term or invariant.

## Running individual checks

```sh
vp lint                                  # oxlint (the Effect presets)
vp fmt                                   # oxfmt
vp run check                             # the whole type gate
vp run --filter ./packages/pdf check     # one package's type gate
vp run -r test:unit                      # every package's unit suite
vp test run test/pdf.test.ts             # one file (from inside the package)
vp run test:integration                  # the cross-format suite
vp run corpora:fetch                     # fetch the pinned public corpora into .corpora/ (network)
vp run test:corpus                       # every reader over every fetched corpus file
vp run test:validate                     # OOXML writer output against the ECMA-376 schemas (needs xmllint)
vp run -r build                          # emit dist/
vp run examples                          # run examples/ against dist/
vp run check:pack                        # pack, lint and import the tarballs
vp run test:coverage                     # one Istanbul map for fallow
vp run fallow:audit                      # change-set review (not a CI gate)
```
