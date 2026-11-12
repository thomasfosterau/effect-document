# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. The project overview is in [README.md](README.md); the conventions, pitfalls and the verification gates every change runs are in [AGENTS.md](AGENTS.md).

## Setup

Node 22 or later and pnpm 11 (the version is pinned by `packageManager`; Corepack or `pnpm self-update` picks it up). `pnpm install` installs the workspace, the Vite+ git hooks and the Effect-patched `tsc` / `oxlint`.

Open in a Codespace or Dev Container: `.devcontainer/` provisions it with the same hook as agent sessions. The `Dev Container` workflow (`.github/workflows/devcontainer.yml`) builds it in CI whenever its inputs change; to try a change locally, `pnpm dlx @devcontainers/cli@0.89.0 up --workspace-folder .` (needs Docker).

## Repository layout

The package is `packages/core` (the entries and formats are in [README.md](README.md#package)). `examples/` is a private workspace package (`vp run examples` runs it); `bench/` is another (`vp run bench`, the benchmarks against other libraries); `test/integration` holds the cross-format suite.

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (see [Git hooks](#git-hooks)) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. There is no pre-push hook: run the gates yourself.
- `vp check` — format + lint (Oxfmt + Oxlint with the Effect presets: `@enfect/oxlint`'s `recommended` and `@effect/tsgo`'s, plus oxlint's `correctness`, `suspicious` and `perf` categories over the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins, and `vite-plus/prefer-vite-plus-imports`; type-aware through oxlint-tsgolint, with `typeCheck` on). `vp run check` — the type gate: the package's `src` under `tsconfig.json` and its tests under `tsconfig.test.json`, plus the root `tsconfig.test.json` (the integration suite and `examples/`). They are different commands.
- `vp run -r test:unit` — the package's unit suite (node Vitest; nothing here needs a database or a credential).
- `vp run test:integration` — the cross-format suite under `test/integration`.
- `vp run corpora:fetch` — fetches the public corpora pinned in `corpora.json` into the git-ignored `.corpora/` (network; a corpus already at its pin is kept). `vp run test:corpus` then runs every reader over every corpus file (`test/corpus`): a defect or a hang fails it, and the read rates and each rejected file's reason go to `.corpora/report.json`. Without a fetch it skips. `vp run test:validate` checks writer output with independent tools (`test/validate`): every XML part the DOCX, XLSX and PPTX writers produce, for a sample of every feature they accept, against the ECMA-376 schemas (fetched as the `ecma-376-schemas` corpus) with `xmllint`; a schema error Office itself also produces is listed with its reason in `KNOWN_DIVERGENCES`, anything else fails. It skips locally without the schemas or `xmllint`, and fails under CI. `vp run test:interop` opens our writers' output in independent tools (`test/interop`): LibreOffice converts every DOCX, XLSX, PPTX and RTF feature sample to PDF, `qpdf --check` and `pdftotext` check the PDF samples, and pandoc reads the DOCX ones. It is CI's optional `interop` job, not a gate; a missing tool skips its tests unless `INTEROP=1`. Corpora are fetched, never committed; a new one is an entry in `corpora.json` (repository, pinned commit, path globs, licence, whether it is vendorable).
- `vp run -r build` — `vp pack` → `packages/core/dist/`.
- `vp run check:dist` — the import guard: the built `dist/` imports no `effect/unstable/*`, and the core entries reach neither `fflate` nor `@thomasfosterau/effect-parse` (`./pdf*` no effect-parse). Run after the build.
- `vp run examples` — runs every program under `examples/` against the built package.
- `vp run check:pack` — the consumer smoke test: packs the package as `pnpm publish` would, lints the tarball (publint, attw `esm-only`), installs it with `effect` and the optional effect-parse peer into a scratch project from npm, and imports and type-checks every entry (`nodenext`, `skipLibCheck: false`). Run after the build; needs the registry.
- `vp run bench` — every format's reader and writer against the leading JavaScript library for it (`bench/<format>.bench.ts`: uDSV, d3-dsv, Papa Parse and csv-parse for CSV; ExcelJS, read-excel-file and write-excel-file for XLSX; mammoth and `docx` for DOCX; PptxGenJS for PPTX; pdf.js and PDFKit for PDF; only actively maintained libraries, each with a release in the last two years; RTF and iWork on their own), over the built packages; `vp run bench:<format>` runs one, `BENCH_FILTER` narrows it to matching groups and `BENCH_TIME` sets the milliseconds per group, `BENCH_LARGE=1` adds the 100 MB CSV inputs, and a "result MB" column gives the memory each result holds; each case is timed in a block of its own (interleaved, a case is charged for the collections the previous one's garbage brings on). Not in CI yet (a non-blocking job is #136); the numbers depend on the machine.
- `vp run test:coverage` — every suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores. Without the map fallow scores every function as uncovered, and any function with cyclomatic complexity ≥ 5 fails the gate on its own.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). The sanctioned non-`vp` invocations: `pnpm install` (and `pnpm install --frozen-lockfile` in CI), `pnpm changeset` / `pnpm publish` on the release path. Single-check variants are in [Running individual checks](#running-individual-checks).

## Branches and pull requests

- The default branch is `trunk` (renamed from `main`; the workflows, Changesets and the fallow gate already target `trunk`). Branch off `trunk`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`). Changes to doc comments that reach the emitted `.d.ts` (TSDoc) take a `patch` changeset; other docs-only changes (READMEs, guidance), CI and tooling need none. Never publish or version by hand: the Release workflow opens the version PR (`chore: version packages`) and the owner merges it. Publishing is npm trusted publishing (OIDC) from the protected `release` environment; there is no `NPM_TOKEN` ([PUBLISHING.md](PUBLISHING.md)).

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one command, `vp run ci` (the gate list in [AGENTS.md](AGENTS.md#verification), as one task in `vite.config.ts`), on the current LTS and the latest Node (`ci (node lts)`, `ci (node latest)`), and its `ci` job, the one required check, passes only when both did. Run `vp run ci` locally for the same gate. The workflows are hardened for Dependabot PRs: `permissions: {}` at the top with read-only scopes per job, every action pinned to a commit SHA, `persist-credentials: false` on CI checkouts, no secrets or OIDC in anything a pull request can trigger (the release job alone holds `id-token: write`, and runs only on pushes to `trunk`), `pnpm install --frozen-lockfile`, and `concurrency` / `timeout-minutes` on every job. Dependabot assigns the owner to its own pull requests (`assignees` in `.github/dependabot.yml`); no workflow assigns anyone else's. `uvx zizmor .github` audits them (config in `.github/zizmor.yml`). [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [Branches and pull requests](#branches-and-pull-requests) requires one.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: the package `README.md` (its API table and examples) for any exported change; `packages/core/AGENTS.md` for a new term or invariant.

## Adding a format

**A format is a subpath of `@thomasfosterau/effect-document`, not a package of its own, unless it brings a dependency the package lacks** (the owner's rule; the owner's own libraries count as dependencies, runtime platforms don't). The CSV, RTF, OOXML, PDF and iWork packages were merged in on the owner's explicit decision, `@thomasfosterau/effect-parse` becoming an optional peer, as in effect-rdf.

A new format adds `src/<format>/` with an `index.ts` barrel (and a barrel per nested subpath), its `exports` entries in `packages/core/package.json`, its `entries` in `packages/core/vite.config.ts` (which also feed the test aliases), its names in `paths` in `tsconfig.base.json`, its barrels in `.fallowrc.json`'s `entry` and a zone (`src/<format>/**`, `test/<format>/**`) and rule allowing `core`, its expected reach in `test/module-graph.test.ts` and `scripts/check-dist-imports.mjs`, a section in `packages/core/README.md` and `packages/core/AGENTS.md`, its entry in the root `README.md` package table, and a changeset. A new package (a format that needs a dependency the package lacks) is an owner decision: it adds a row to the root `README.md` package table, its own `AGENTS.md` (with a `CLAUDE.md` that imports it) and `README.md`, its names in `paths` and a `test/tsconfig.json` extending its `tsconfig.test.json`, a `.fallowrc.json` zone and rule plus its entry points, a root `package.json` devDependency, its `options` import in the root `vite.config.ts` and its `#check` / `#build` edges there, and its directory in `scripts/check-dist-imports.mjs` and `scripts/check-pack.mjs`.

## Running individual checks

Narrower variants of the [commands](#commands) above:

```sh
vp lint                                  # oxlint (@enfect/oxlint + @effect/tsgo presets)
vp fmt                                   # oxfmt
vp run --filter ./packages/core check    # the package's type gate alone
vp test run test/pdf/pdf.test.ts         # one file (from packages/core)
vp run fallow:audit                      # change-set review (not a CI gate)
```
