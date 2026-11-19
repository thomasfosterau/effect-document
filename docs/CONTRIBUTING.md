# Contributing

## Workflow

The main branch is `trunk`. Branch off `trunk`, open a pull request into `trunk`, and squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`).

- **Open a draft PR early**, so others can see the work is taken.
- **One PR per change**, even a large one spanning many commits.
- **Rebase, don't merge.** Rebase onto `origin/trunk`; never merge `trunk` into your branch.
- **File issues** for problems you spot outside your change rather than fixing them in passing or leaving a TODO. Keep issue bodies evergreen: edit them in place as findings and decisions change.
- **Dependabot** keeps dependencies current; update one by hand only when your work needs it or Dependabot can't (see [Dependencies](#dependencies)).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node and pnpm; use it rather than calling them directly (`vp exec <bin>`, not `npx`). `vp install` installs dependencies, the git hooks and the Effect-patched `tsc` / `oxlint` (`prepare`). The pre-commit hook ([.vite-hooks/pre-commit](../.vite-hooks/pre-commit)) runs `vp staged` (format with fixes, then lint) and `vp run fallow:audit`.

| Command | What it does |
| --- | --- |
| `vp check` | Format and lint, type-aware |
| `vp run check` | The type gate (`src`, tests, examples, bench) |
| `vp run -r test:unit` | Unit tests; `vp test run test/csv/csv.test.ts` runs one file from `packages/core` |
| `vp run test:integration` | Cross-format suite (`test/integration`) |
| `vp run corpora:fetch` | Fetch the public corpora pinned in `corpora.json` into `.corpora/` (network) |
| `vp run test:corpus` | Every reader over every fetched corpus file |
| `vp run test:validate` | Writer output against the ECMA-376 schemas (needs the corpora and `xmllint`) |
| `vp run test:interop` | Writer output opened by LibreOffice, qpdf, pdftotext and pandoc; a missing tool skips unless `INTEROP=1` |
| `vp run -r build` | `vp pack` → `packages/core/dist/` |
| `vp run check:dist` | The built entries reach only the dependencies they may |
| `vp run check:pack` | Pack, lint (publint, attw) and type-check the tarball as a consumer (network) |
| `vp run examples` | Run `examples/` against the build |
| `vp run bench` | Benchmarks against other libraries (`bench:<format>` for one) |
| `vp run ci` | Everything CI runs, in the same order |

[Fallow](https://docs.fallow.tools) checks dead code, module boundaries, complexity and duplication; use it to polish your work (`vp run fallow`), as guidance rather than dogma. The pre-commit hook runs `vp run fallow:audit`, which first refreshes the coverage map (`vp run test:coverage`) and fails only on findings the change introduces against `origin/trunk`; its zones enforce the format boundaries. Before deleting "unused" code, trace it: `vp exec fallow dead-code --trace <file>:<export>`.

## Coding guidelines

- **Effect.** Use Effect (v4) idioms throughout and prefer Effect's own modules (`Option`, `Array`, `Match`, `Schema`, …) to hand-rolled equivalents; convert existing code where practical. Exceptions: non-Effect APIs (adapt them at the edge) and hot paths where measurement shows plain code is needed (readers and writers run per cell, glyph or XML element; benchmark with `vp run bench:<format>` before and after). Read `node_modules/effect` rather than guessing an API. Lint findings are fixed, not suppressed; a justified exception takes `oxlint-disable-next-line <rule> -- <reason>`.
- **Optional members** are `?: T | undefined` (`exactOptionalPropertyTypes` is on). Relative imports carry `.ts`.
- **Comments.** A file-level comment only when it adds real context, in under 50 words. Doc comments where they help someone reading IntelliSense, adding to the signature rather than restating it. Inline comments only for what the code can't say. Don't reference issues, PRs or CI runs in comments.
- **Tests** check logic: edge cases, regressions, differential checks of fast paths against the general path. Don't test what the type system or a lint can enforce. Tests import from `vite-plus/test` (never `vitest`), and Effect tests use `@effect/vitest` (`it.effect`, `layer`).
- **The package's boundaries and invariants** are in [packages/core/AGENTS.md](../packages/core/AGENTS.md).

## Before pushing

Run `vp run ci`, or the gates one at a time:

1. `vp check`
2. `vp run check`
3. `vp run -r test:unit` and `vp run test:integration`
4. `vp run corpora:fetch && vp run test:validate && vp run test:corpus` (network; `xmllint`)
5. `vp run -r build && vp run check:dist && vp run examples`
6. `vp run check:pack` and `pnpm audit --audit-level high` (network)

Say in the PR body which gates couldn't run. CI ([ci.yml](../.github/workflows/ci.yml)) runs `vp run ci` on Node `lts` and `latest`; the `lts` leg also runs the interop suite. Workflows pin actions by exact tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. `uvx zizmor --offline .github` audits the workflows.

## Changesets

Every change to the published package's behaviour or its emitted `.d.ts` (doc comments included, as a `patch`) needs a changeset: `vp exec changeset`. Docs, CI and tooling changes need none. Never version or publish by hand: the Release workflow opens the "chore: version packages" PR and publishes once the owner merges it ([PUBLISHING.md](PUBLISHING.md)).

## Dependencies

Every external version is in the `pnpm-workspace.yaml` catalog; package.json files use `catalog:`, `catalog:peers` or `workspace:*`. After editing the catalog, run `vp install` and commit `pnpm-lock.yaml`.

Dependabot groups the sets that must move together. On those PRs, by hand:

- **Toolchain** (`vite-plus`): run `vp dlx --package=vite-plus@<v> vp migrate --no-interactive` to re-pin `vite` and `vitest` (and `@vitest/coverage-istanbul` to the same version), then drop the `minimumReleaseAgeExclude` entries it adds. `typescript` / `@typescript/native` move only with an `@effect/tsgo` that supports them.
- **Peer range** (`catalogs.peers.effect`): raise it only when a dependency requires it; it's a breaking change.
- **Security overrides** are raised or dropped as their advisories move.
