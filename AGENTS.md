# AGENTS.md

`CLAUDE.md` is a symlink to this file. Project conventions live here; personal style preferences live in user memory.

This repo publishes one package, `@thomasfosterau/effect-document`: an Effect-native universal document schema (a Pandoc-style AST spanning prose, spreadsheets and presentations), the feature **profiles** that carve it into typed subsets, the `Reader` / `Writer` / `Format` / `convert` pipeline, and one nested subpath per format family. The type system tracks which subset a document belongs to: a reader returns exactly its format's profile, a writer accepts only what its format can represent, and `narrow` reports every loss.

| Package | Directory | Entries |
| --- | --- | --- |
| `@thomasfosterau/effect-document` | `packages/core` | core: `.`, `./schema`, `./profile`, `./profiles`, `./io`; formats: `./csv`, `./rtf`, `./ooxml` (`./ooxml/xlsx`, `./ooxml/docx`, `./ooxml/pptx`), `./pdf` (`./pdf/cos`), `./iwork` (`./iwork/pages`, `./iwork/numbers`, `./iwork/keynote`, `./iwork/codec`) |

No format is on the root barrel. Each lives in `packages/core/src/<format>/`, with its tests in `packages/core/test/<format>/`, and reaches the core by relative import. `@thomasfosterau/effect-parse` is an optional peer, reached only from `./csv`, `./rtf`, `./ooxml*` and `./iwork*`; `fflate` is a dependency, reached only from `./ooxml*`, `./pdf*` and `./iwork*`; `packages/core/test/module-graph.test.ts` and `vp run check:dist` pin both.

`examples/` is a private workspace package (`vp run examples` runs it); `bench/` is another (`vp run bench`, the benchmarks against other libraries); `test/integration` holds the cross-format suite.

**A format is a subpath of `@thomasfosterau/effect-document`, not a package of its own, unless it brings a dependency the package lacks** (the owner's rule; the owner's own libraries count as dependencies, runtime platforms don't). The CSV, RTF, OOXML, PDF and iWork packages were merged in on the owner's explicit decision, `@thomasfosterau/effect-parse` becoming an optional peer, as in effect-rdf. A new format adds `src/<format>/` with an `index.ts` barrel (and a barrel per nested subpath), its `exports` entries in `packages/core/package.json`, its `entries` in `packages/core/vite.config.ts` (which also feed the test aliases), its names in `paths` in `tsconfig.base.json`, its barrels in `.fallowrc.json`'s `entry` and a zone (`src/<format>/**`, `test/<format>/**`) and rule allowing `core`, its expected reach in `test/module-graph.test.ts` and `scripts/check-dist-imports.mjs`, a section in `packages/core/README.md` and `packages/core/CLAUDE.md`, a row here and in the root `README.md`, and a changeset. A new package (a format that needs a dependency the package lacks) is an owner decision: it adds a row here and in the root `README.md`, its own `CLAUDE.md` and `README.md`, its names in `paths` and a `test/tsconfig.json` extending its `tsconfig.test.json`, a `.fallowrc.json` zone and rule plus its entry points, a root `package.json` devDependency, its `options` import in the root `vite.config.ts` and its `#check` / `#build` edges there, and its directory in `scripts/check-dist-imports.mjs` and `scripts/check-pack.mjs`.

## Common pitfalls

- **Never edit a version in a `package.json`.** Versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: strict` rejects anything else). After editing it, run `pnpm install` and commit `pnpm-lock.yaml`, or every CI job fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first. Dependabot (`.github/dependabot.yml`) groups only the lockstep sets (`toolchain`: vite-plus, vitest, `@vitest/*`, `@effect/tsgo`; `effect`: `effect` + `@effect/*`) with a 1-day cooldown; everything else arrives as its own PR (pnpm's `minimumReleaseAge` is 8 hours); the moves it cannot make — the npm-alias entries (`vite`, `typescript`, `@typescript/native`), the `vitest` pins vite-plus dictates, a supporting `@effect/tsgo`, and `catalogs.peers` — are made by hand on the matching PR, as that file's header lists.
- **`dist/` is the product.** The package is a `vp pack` (tsdown) library with one bundle per entry point (`entries` in `packages/core/vite.config.ts`) and shared code in hashed chunks; `exports` points at `dist/`, so `examples/` and `bench/` consume it the way a consumer does. Its tests resolve its name and subpaths to `src/` at run time (the alias in `vite.package.ts`), as does the integration suite. Type checking resolves them to `src/` too (`paths` in `tsconfig.base.json`), so `vp check`'s type-aware lint and `vp run check` need no `dist/`; `vp run check:pack` is what type-checks the built declarations as a consumer sees them. Inside `src/`, a format imports the core by relative path, never by the package's own name. `packages/core/test/tsconfig.json` extends its `tsconfig.test.json` so oxlint-tsgolint, which reads the nearest `tsconfig.json`, types the tests the way `vp run check` does.
- **`"sideEffects": false` is a claim about `dist/`, and it is load-bearing.** Every emitted `.js` must be pure declarations: no top-level statements with effects, no top-level `await`. That is what lets a consumer's bundler drop the formats it does not use.
- **The profile is the contract.** A reader's return type and a writer's parameter type are `Doc<F>` for the format's profile; a change that lets a writer accept a feature its format cannot encode, or a reader emit one outside its profile, is a type-level regression even when every runtime test passes. `test/integration/type-level.types.ts` pins the compile-time guarantees.
- **Lossy steps are reported, never silent.** `narrow` and `convert` record every drop and conversion in the `LossReport`; a writer that quietly discards a node breaks that promise.
- **`effect` is a peer, never a dependency.** Two copies break `Context` / `Layer` / `Schema` identity; the consuming app owns the singleton.
- **The per-value loops are hot paths.** A reader runs once per cell, glyph or XML element and a writer once per field. Keep `Schema.Class` constructors (`new CellText(…)`, `new SheetRow(…)`), an `Effect` or `Result` per value, and per-value regexes and closures out of them: use core's constructors (`cell.*`, `str`, `sheetRow`, `sheetRowFrom`, `sheetRowOf`, `sparseRow`, `worksheet`, `worksheetFromRows`), which skip the schema pass for input they have checked. Run the benchmark for the format (`vp run bench:<format>`) before and after touching a reader, a writer or those constructors, and report the numbers. A one-site `oxlint-disable-next-line effect/imperative-loops` carries the measured reason.

The package's invariants, terms and import boundaries, the core's and each format's, live only in [`packages/core/CLAUDE.md`](packages/core/CLAUDE.md); read it before changing the package.

## Conventions

- **Effect-first.** Domain failures are tagged errors (`ReadError`, `WriteError`, `ProfileViolation`, …; see [Effect](#effect)); work that can fail returns `Effect`; optional values are `Option` where a caller branches on them. Pure total functions (the byte-level decoders included) stay plain functions.
- **Optional props and fields are declared `T | undefined`, never bare `x?: T`.** The workspace compiles with `exactOptionalPropertyTypes`.
- **Relative imports carry their `.ts` extension** (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`); Effect modules are imported by path (`import * as Effect from "effect/Effect"`), never from the `effect` barrel.
- **Tests import from `vite-plus/test`**, never `vitest`. The suites live in `packages/core/test/` (a format's in `test/<format>/`), mirroring the module they cover; binary fixtures sit in a `fixtures/` directory beside them with their provenance in a README or `ATTRIBUTION.md` there, and are read through the `FileSystem` service (`@effect/platform-node`, dev-only).
- **Every export has a doc comment** whose first sentence says what it is for and stands alone in a hover. It documents defaults, units, the error channel and the reason for any non-obvious choice.
- **One barrel per entry point**, listed in `packages/core/vite.config.ts` `entries` (export subpath → source file). A new entry is added there, to `exports`, to `paths` in `tsconfig.base.json` and to `entry` in `.fallowrc.json`.
- **Lint findings are fixed, not suppressed.** A rule goes `off` only in `vite.config.ts`, with a comment giving the reason it cannot apply; a one-site `oxlint-disable-next-line` carries `-- <reason>`. The `warn`-tier allowances list in `vite.config.ts` is debt to pay down, not headroom.

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. No pre-push hook: run the gates yourself.
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
12. `vp run test:coverage`, then `vp exec fallow audit --format json --quiet --explain --gate-marker agent` (the fallow gate below; not a CI step). The PreToolUse fallow gate audits against `coverage/coverage-final.json` and never refreshes it, so run `test:coverage` first.

Steps 2–11 are CI's required `ci` job, in its order ([ci.yml](.github/workflows/ci.yml)). `CONTRIBUTING.md` and the PR template link here rather than restating the list.

## Branches and pull requests

- The default branch is `trunk` (renamed from `main`; the workflows, Changesets and the fallow gate already target `trunk`). Branch off `trunk`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch (GitHub's Update-branch button merges).
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch, named `issue-<n>-<slug>` for issue-linked work. Start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing. A worktree needs its own `pnpm install`: the global `vp` delegates to the checkout's own `vite-plus`, so a worktree without `node_modules` has none to run.
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

- The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer range is under `catalogs.peers`. The `effect` peer is `^4.0.0`: raise the floor only when one of the package's own dependencies or peers requires it (or its code needs an unstable module first shipped in a later minor), naming that dependency or module in the catalog comment, and prove the floor by re-running the gates with the catalog pin at the floor version. Raising the floor is a breaking change. The optional `@thomasfosterau/effect-parse` peer is `^0.4.1`, raised with the grammars.
- Tagged errors are `Schema.TaggedError<Self>()(tag, fields)` classes; matching on a document node's tag uses `Match.tag` / `Predicate.isTagged`, not `node._tag === "…"`.
- The parser combinators (CSV, OOXML, iWork and RTF readers) come from `@thomasfosterau/effect-parse`, imported by subpath (`/Parser`, `/Text`, …).

## Agent sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's network allowlist), links `vp` and `vpx` into `~/.local/bin`, and runs `vp install --frozen-lockfile`. Everything else goes through Vite+: `vp exec fallow …` for fallow, `vpx <file>.ts` for TypeScript programs. Nothing else is put on PATH. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets; none are needed, and nothing here can publish.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` (run as `vp exec fallow`) fails; it audits only this checkout and its `.claude/worktrees/*`, skipping any other tree with a notice, and reads the coverage map on disk, so run `vp run test:coverage` first. A PostToolUse hook runs `vp fmt` on every source, JSON, CSS or Markdown file you write or edit.
- Every gate in [Verification](#verification) runs in an agent session; `vp run check:pack` and `pnpm audit` need the network.

## Documentation surfaces

`README.md` at the root is the landing page; `packages/core/README.md` is the API reference consumers read on npm, a section per format; `packages/core/CLAUDE.md` carries the boundary, invariants and terms, a section per format (it is not published); `CONTRIBUTING.md` carries human setup, CI expectations and single-check commands; `PUBLISHING.md` the release pipeline and its one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture. No `docs/` tree is committed; decisions go in issue comments.

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
