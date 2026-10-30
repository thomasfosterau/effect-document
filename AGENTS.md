# AGENTS.md

`CLAUDE.md` is a symlink to this file. Project conventions live here; personal style preferences live in user memory.

This repo publishes the `@thomasfosterau/effect-document` package family: an Effect-native universal document schema (a Pandoc-style AST spanning prose, spreadsheets and presentations), the feature **profiles** that carve it into typed subsets, the `Reader` / `Writer` / `Format` / `convert` pipeline, and one package per format family. The type system tracks which subset a document belongs to: a reader returns exactly its format's profile, a writer accepts only what its format can represent, and `narrow` reports every loss.

| Package | Directory | Entries |
| --- | --- | --- |
| `@thomasfosterau/effect-document` | `packages/core` | `.`, `./schema`, `./profile`, `./profiles`, `./io` |
| `@thomasfosterau/effect-csv` | `packages/csv` | `.` |
| `@thomasfosterau/effect-ooxml` | `packages/ooxml` | `.`, `./xlsx`, `./docx`, `./pptx` |
| `@thomasfosterau/effect-rtf` | `packages/rtf` | `.` |
| `@thomasfosterau/effect-pdf` | `packages/pdf` | `.`, `./cos` |
| `@thomasfosterau/effect-iwork` | `packages/iwork` | `.`, `./pages`, `./numbers`, `./keynote`, `./codec` |

`examples/` is a private workspace package (`vp run examples` runs it); `test/integration` holds the cross-format suite.

A new package adds a row here and in the root `README.md`, its own `CLAUDE.md` and `README.md`, its names in `paths` in `tsconfig.base.json` and a `test/tsconfig.json` extending its `tsconfig.test.json`, a `.fallowrc.json` zone and rule plus its entry points, a root `package.json` devDependency, its `options` import in the root `vite.config.ts` (the integration aliases) and its `#check` / `#build` edges there (`check`, `check:dist`, `check:pack`, `examples`, `test:coverage`), and its directory in `scripts/check-dist-imports.mjs` and `scripts/check-pack.mjs`.

## Common pitfalls

- **Never edit a version in a `package.json`.** Versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: strict` rejects anything else). After editing it, run `pnpm install` and commit `pnpm-lock.yaml`, or every CI job fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first. Dependabot (`.github/dependabot.yml`) groups every lockstep set (`toolchain`, `effect`, `zip`, `parse`, `example-runner`, `changesets`, `fallow`, `pack-lint`, `github-actions`) with a 1-day cooldown (pnpm's `minimumReleaseAge` is 8 hours); the moves it cannot make — the npm-alias entries (`vite`, `typescript`, `@typescript/native`), the `vitest` pins vite-plus dictates, a supporting `@effect/tsgo`, and `catalogs.peers` — are made by hand on the matching PR, as that file's header lists.
- **`dist/` is the product.** Each package is a `vp pack` (tsdown) library with one bundle per entry point (`entries` in its `vite.config.ts`); `exports` points at `dist/`, so a sibling package consumes it the way a consumer does and its `check` / `test:unit` tasks take a `{ task: "build", from: "dependencies" }` edge. A package's own tests resolve its name to `src/` at run time (the alias in `vite.package.ts`); the integration suite resolves every package to `src/`. Type checking resolves every package name to `src/` (`paths` in `tsconfig.base.json`), so `vp check`'s type-aware lint and `vp run check` need no `dist/`; `vp run check:pack` is what type-checks the built declarations as a consumer sees them. Each `packages/*/test/tsconfig.json` extends its `tsconfig.test.json` so oxlint-tsgolint, which reads the nearest `tsconfig.json`, types the tests the way `vp run check` does.
- **`"sideEffects": false` is a claim about `dist/`, and it is load-bearing.** Every emitted `.js` must be pure declarations: no top-level statements with effects, no top-level `await`. That is what lets a consumer's bundler drop the formats it does not use.
- **The profile is the contract.** A reader's return type and a writer's parameter type are `Doc<F>` for the format's profile; a change that lets a writer accept a feature its format cannot encode, or a reader emit one outside its profile, is a type-level regression even when every runtime test passes. `test/integration/type-level.types.ts` pins the compile-time guarantees.
- **Lossy steps are reported, never silent.** `narrow` and `convert` record every drop and conversion in the `LossReport`; a writer that quietly discards a node breaks that promise.
- **`effect` is a peer, never a dependency.** Two copies break `Context` / `Layer` / `Schema` identity; the consuming app owns the singleton.

Package-local invariants, terms and import boundaries live only in each package's `CLAUDE.md` (`packages/<name>/CLAUDE.md`); read it before changing that package.

## Conventions

- **Effect-first.** Domain failures are tagged errors (`ReadError`, `WriteError`, `ProfileViolation`, …; see [Effect](#effect)); work that can fail returns `Effect`; optional values are `Option` where a caller branches on them. Pure total functions (the byte-level decoders included) stay plain functions.
- **Optional props and fields are declared `T | undefined`, never bare `x?: T`.** The workspace compiles with `exactOptionalPropertyTypes`.
- **Relative imports carry their `.ts` extension** (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`); Effect modules are imported by path (`import * as Effect from "effect/Effect"`), never from the `effect` barrel.
- **Tests import from `vite-plus/test`**, never `vitest`. A package's suites live in `packages/<name>/test/`, mirroring the module they cover; binary fixtures sit in `test/fixtures/` with their provenance in a README or `ATTRIBUTION.md` there, and are read through the `FileSystem` service (`@effect/platform-node`, dev-only).
- **Every export has a doc comment** whose first sentence says what it is for and stands alone in a hover. It documents defaults, units, the error channel and the reason for any non-obvious choice.
- **One barrel per entry point**, listed in the package's `vite.config.ts` `entries` (export subpath → source file). A new entry is added there, to `exports`, to `paths` in `tsconfig.base.json` and to `entry` in `.fallowrc.json`.
- **Lint findings are fixed, not suppressed.** A rule goes `off` only in `vite.config.ts`, with a comment giving the reason it cannot apply; a one-site `oxlint-disable-next-line` carries `-- <reason>`. The `warn`-tier allowances list in `vite.config.ts` is debt to pay down, not headroom.

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. No pre-push hook: run the gates yourself.
- `vp check` — format + lint (Oxfmt + Oxlint with the Effect presets: `@enfect/oxlint`'s `recommended` and `@effect/tsgo`'s, plus oxlint's `correctness`, `suspicious` and `perf` categories over the `typescript`, `unicorn`, `oxc`, `import`, `promise`, `vitest` and `jsdoc` plugins, and `vite-plus/prefer-vite-plus-imports`; type-aware through oxlint-tsgolint, with `typeCheck` on). `vp run check` — the type gate: every package's `src` under `tsconfig.json` and its tests under `tsconfig.test.json`, plus the root `tsconfig.test.json` (the integration suite and `examples/`). They are different commands.
- `vp run -r test:unit` — every package's unit suite (node Vitest; nothing here needs a database or a credential).
- `vp run test:integration` — the cross-format suite under `test/integration`.
- `vp run corpora:fetch` — fetches the public corpora pinned in `corpora.json` into the git-ignored `.corpora/` (network; a corpus already at its pin is kept). `vp run test:corpus` then runs every reader over every corpus file (`test/corpus`): a defect or a hang fails it, and the read rates and each rejected file's reason go to `.corpora/report.json`. Without a fetch it skips. `vp run test:validate` checks writer output with independent tools (`test/validate`): every XML part the DOCX, XLSX and PPTX writers produce, for a sample of every feature they accept, against the ECMA-376 schemas (fetched as the `ecma-376-schemas` corpus) with `xmllint`; a schema error Office itself also produces is listed with its reason in `KNOWN_DIVERGENCES`, anything else fails. It skips locally without the schemas or `xmllint`, and fails under CI. `vp run test:interop` opens our writers' output in independent tools (`test/interop`): LibreOffice converts every DOCX, XLSX, PPTX and RTF feature sample to PDF, `qpdf --check` and `pdftotext` check the PDF samples, and pandoc reads the DOCX ones. It is CI's optional `interop` job, not a gate; a missing tool skips its tests unless `INTEROP=1`. Corpora are fetched, never committed; a new one is an entry in `corpora.json` (repository, pinned commit, path globs, licence, whether it is vendorable).
- `vp run -r build` — `vp pack` → every package's `dist/`.
- `vp run check:dist` — the import guard: no built `dist/` imports `effect/unstable/*`. Run after the build.
- `vp run examples` — runs every program under `examples/` against the built packages.
- `vp run check:pack` — the consumer smoke test: packs every package as `pnpm publish` would, lints the tarballs (publint, attw `esm-only`), installs them into a scratch project from npm, and imports and type-checks every entry (`nodenext`, `skipLibCheck: false`). Run after the build; needs the registry.
- `vp run test:coverage` — every suite under one Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads for exact per-function CRAP scores. Without the map fallow scores every function as uncovered, and any function with cyclomatic complexity ≥ 5 fails the gate on its own.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`; `vp run <task>` instead of bare `pnpm`). The sanctioned non-`vp` invocations: `pnpm install` (and `pnpm install --frozen-lockfile` in CI), `pnpm changeset` / `pnpm publish` on the release path. Single-check variants are in [CONTRIBUTING.md](CONTRIBUTING.md#running-individual-checks).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why in the PR body; never imply it ran.

1. From a clean install, which is what CI sees: `rm -rf node_modules packages/*/node_modules packages/*/dist examples/node_modules && pnpm install --frozen-lockfile`.
2. `vp check`
3. `vp run check`
4. `vp run -r test:unit`
5. `vp run test:integration`
6. `vp run corpora:fetch && vp run test:validate && vp run test:corpus` (network; `test:validate` needs `xmllint`)
7. `vp run -r build`
8. `vp run check:dist`
9. `vp run examples`
10. `vp run check:pack` (network)
11. `pnpm audit --audit-level high` (network)
12. `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent` (the fallow gate below; not a CI step). The PreToolUse fallow gate audits against `coverage/coverage-final.json` and never refreshes it, so run `test:coverage` first.

Steps 2–11 are CI's required `ci` job, in its order ([ci.yml](.github/workflows/ci.yml)). `CONTRIBUTING.md` and the PR template link here rather than restating the list.

## Branches and pull requests

- The default branch is `trunk` (renamed from `main`; the workflows, Changesets and the fallow gate already target `trunk`). Branch off `trunk`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch, named `issue-<n>-<slug>` for issue-linked work. Start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing. A worktree needs its own `pnpm install`: the linked `vp` re-execs the nearest `node_modules/vite-plus/bin/vp` walking up from cwd.
- Every change to a published package's behaviour carries a changeset (`pnpm changeset`). Changes to doc comments that reach the emitted `.d.ts` (TSDoc) take a `patch` changeset; other docs-only changes (READMEs, guidance), CI and tooling need none. Never publish or version by hand: the Release workflow opens the version PR (`chore: version packages`) and the owner merges it. Publishing is npm trusted publishing (OIDC) from the protected `release` environment; there is no `NPM_TOKEN` ([PUBLISHING.md](PUBLISHING.md)).
- Push your branch; open a pull request only when the owner asks for one (this repo grants no standing approval to open PRs). Once a PR you opened exists, watch it to merge or close: investigate CI failures and review comments as they arrive, rebase promptly when it goes conflicting, and keep its body current.
- GitHub writes go to `thomasfosterau/effect-document` only — never to `effect-parse`, the owner's other libraries or upstream projects without the owner's explicit approval for that action in the current session. Pass `-R thomasfosterau/effect-document` whenever the cwd might be another checkout. If another repo needs something, say so in the PR body.

## Work tracker

- Issues in `thomasfosterau/effect-document` are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. There is no in-repo backlog file.
- The issue is the spec — read its comments; later comments override the body. Re-verify the issue's code claims against current `trunk` before editing.
- Record decisions and findings as comments on the issue they were found working.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence on the issue and stop.
- Scope cut mid-PR becomes a linked issue before merge.

## Effect

Read the installed package before writing Effect code: `node_modules/effect/CLAUDE.md` and the `ai-docs/` examples it links, `node_modules/effect/dist/*.d.ts` and `node_modules/effect/src`. Never guess at an Effect API.

- The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer floor is under `catalogs.peers`. Raising the floor is a breaking change for every published package.
- Tagged errors are `Schema.TaggedError<Self>()(tag, fields)` classes; matching on a document node's tag uses `Match.tag` / `Predicate.isTagged`, not `node._tag === "…"`.
- The parser combinators (CSV, OOXML, iWork and RTF readers) come from `@thomasfosterau/effect-parse`, imported by subpath (`/Parser`, `/Text`, …).

## Agent sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts `vp` (a re-exec shim that prefers the nearest worktree's `node_modules`), `fallow` and `tsx` on PATH for non-interactive shells. It hydrates no secrets; none are needed, and nothing here can publish.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` fails; it reads the coverage map on disk, so run `vp run test:coverage` first. A PostToolUse hook runs `vp fmt` on every source, JSON, CSS or Markdown file you write or edit.
- `.claude/settings.json` enables the `@enfect/claude` plugin (Effect guidance, skills and post-write pattern checks), pinned by `ref` to the reviewed `mpsuesser/enfect` commit that published 0.9.0; moving it is a reviewed edit of that SHA.
- Every gate in [Verification](#verification) runs in an agent session; `vp run check:pack` and `pnpm audit` need the network.

## Documentation surfaces

`README.md` at the root is the landing page; each package `README.md` is the API reference consumers read on npm; each package `CLAUDE.md` carries its boundary, invariants and terms (it is not published); `CONTRIBUTING.md` carries human setup, CI expectations and single-check commands; `PUBLISHING.md` the release pipeline and its one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture. No `docs/` tree is committed; decisions go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
