# AGENTS.md

Guidance for coding agents working in this repository, whatever the tool. The project overview, the package's entry points and the format table are in [README.md](README.md); setup, commands, the branch, pull-request and changeset rules and the steps for adding a format are in [CONTRIBUTING.md](CONTRIBUTING.md); the package's boundary, invariants and terms are in [packages/core/AGENTS.md](packages/core/AGENTS.md). Claude Code's own setup (its hooks and settings) is in [.claude/CLAUDE.md](.claude/CLAUDE.md), which imports this file, `CONTRIBUTING.md` and `README.md`. Personal style preferences live in user memory.

This repo publishes one package, `@thomasfosterau/effect-document`: an Effect-native universal document schema (a Pandoc-style AST spanning prose, spreadsheets and presentations), the feature **profiles** that carve it into typed subsets, the `Reader` / `Writer` / `Format` / `convert` pipeline, and one nested subpath per format family. The type system tracks which subset a document belongs to: a reader returns exactly its format's profile, a writer accepts only what its format can represent, and `narrow` reports every loss.

No format is on the root barrel. Each lives in `packages/core/src/<format>/`, with its tests in `packages/core/test/<format>/`, and reaches the core by relative import. `@thomasfosterau/effect-parse` is an optional peer, reached only from `./csv`, `./rtf`, `./ooxml*` and `./iwork*`; `fflate` is a dependency, reached only from `./ooxml*`, `./pdf*` and `./iwork*`; `@thomasfosterau/effect-ext` is a dependency, reached only from `./encoding` (encoding detection, #188); `packages/core/test/module-graph.test.ts` and `vp run check:dist` pin all three.

**A format is a subpath of `@thomasfosterau/effect-document`, not a package of its own, unless it brings a dependency the package lacks** (the owner's rule; the owner's own libraries count as dependencies, runtime platforms don't). The CSV, RTF, OOXML, PDF and iWork packages were merged in on the owner's explicit decision, `@thomasfosterau/effect-parse` becoming an optional peer, as in effect-rdf. The files a new format or package touches are listed in [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-format).

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
- **Tests import from `vite-plus/test`**, never `vitest`, and a test that runs an effect is an `@effect/vitest` test (owner decision, 2026-11-12): `it.effect` (or `it.effect.each`, `it.live`) with its assertions inside the effect, and the services it needs from `layer(...)`, never `Effect.run*` or `Effect.provide` in a test body (`effect/effect-run-in-body` and `effecttsgo/strict-effect-provide` are at error for tests too). A value a whole suite reads once (a fixture set, a tool probe) is a service a `layer` builds. The suites live in `packages/core/test/` (a format's in `test/<format>/`), mirroring the module they cover; binary fixtures sit in a `fixtures/` directory beside them with their provenance in a README or `ATTRIBUTION.md` there, and are read through the `FileSystem` service (`@effect/platform-node`, dev-only).
- **Every export has a doc comment** whose first sentence says what it is for and stands alone in a hover. It documents defaults, units, the error channel and the reason for any non-obvious choice.
- **One barrel per entry point**, listed in `packages/core/vite.config.ts` `entries` (export subpath → source file). A new entry is added there, to `exports`, to `paths` in `tsconfig.base.json` and to `entry` in `.fallowrc.json`.
- **Lint findings are fixed, not suppressed.** A rule goes `off` only in `vite.config.ts`, with a comment giving the reason it cannot apply; a one-site `oxlint-disable-next-line` carries `-- <reason>`. The `warn`-tier allowances list in `vite.config.ts` is debt to pay down, not headroom.

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
12. `vp run test:coverage`, then `vp exec fallow audit --format json --quiet --explain --gate-marker agent` (the fallow gate below; not a CI step). The PreToolUse fallow gate audits against `coverage/coverage-final.json`, regenerating it first when it is missing or older than any source or test file.

Steps 2–11 are the `ci` task in `vite.config.ts` (`vp run ci`, fail-fast, in this order), which [ci.yml](.github/workflows/ci.yml) runs on the current LTS and the latest Node; its required check is `ci`. `CONTRIBUTING.md` and the PR template link here rather than restating the list; the commands themselves are described in [CONTRIBUTING.md](CONTRIBUTING.md#commands).

## Pull requests

The general rules (branching off `trunk`, rebasing, squash-merge prefixes, changesets) are in [CONTRIBUTING.md](CONTRIBUTING.md#branches-and-pull-requests). For agents, in addition:

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

## Documentation surfaces

`README.md` at the root is the landing page (the overview, the entry points and the format table); `packages/core/README.md` is the API reference consumers read on npm, a section per format; `AGENTS.md` (this file) carries the guidance for agents, and `packages/core/AGENTS.md` the package's boundary, invariants and terms, a section per format (neither is published); `CONTRIBUTING.md` carries setup, commands, CI expectations and the branch, pull-request and changeset rules; `.claude/CLAUDE.md` carries Claude Code's own setup and imports the general files, and `packages/core/CLAUDE.md` imports `packages/core/AGENTS.md`; `PUBLISHING.md` the release pipeline and its one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture. No `docs/` tree is committed; decisions go in issue comments.

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
