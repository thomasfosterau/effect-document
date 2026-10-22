# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security rationale behind the pipeline. (Copied from the effect-web library, itself from effect-jsonapi.)

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the packages and the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file alongside your change. Which changes need one is set out in [AGENTS.md](AGENTS.md#branches-and-pull-requests); a doc-comment change that reaches the emitted `.d.ts` takes a `patch`.
2. **Merge to `trunk`.** The [`Release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates a **"Version Packages"** PR that applies the version bumps and rolls the changesets into each package's `CHANGELOG.md`. The version step is `changeset version && vp fmt && pnpm install --lockfile-only`, with `"format": false` in `.changeset/config.json`: Changesets 3 otherwise auto-detects the `oxfmt` binary Vite+ installs and runs `oxfmt --write` on the new changelogs, but that binary is Vite+'s IDE-only shim and exits 1 outside LSP mode, which fails the release before the PR is opened. `vp fmt` formats the changelogs instead, so the Version Packages PR passes `vp check`.
3. **Merge the "Version Packages" PR.** With no changesets left, the workflow builds every package and publishes the bumped ones to npm via trusted publishing (with provenance once the repository is public — see below), then tags the commits and creates the GitHub releases.

The publish step runs `pnpm -r publish --ignore-scripts`, which rewrites each package's `workspace:` and `catalog:` specifiers to concrete ranges and publishes natively: since pnpm 11 `pnpm publish` no longer delegates to the npm CLI, and pnpm itself fetches the GitHub Actions OIDC token (audience `npm:registry.npmjs.org`) and exchanges it for a short-lived npm token. The job therefore never upgrades npm; the npm bundled with Node is not on the publish path. `--ignore-scripts` keeps any publish lifecycle script (`prepublishOnly`, `prepack`, `publish`, …) out of the job holding `id-token: write`; no package defines one today, and `vp run -r build` runs before the publish. Provenance is pnpm's call too: pnpm 11 takes settings like `provenance` only from `pnpm_config_*` (so an `NPM_CONFIG_PROVENANCE` would be ignored), and with no `pnpm_config_provenance` set it attaches provenance only when the OIDC token reports a public repository **and** the registry reports the package as public, skipping it with a `ERR_PNPM_PROVENANCE_INSUFFICIENT_INFORMATION` warning while the repository is private. `changeset tag` then emits the `New tag:` lines the Changesets action uses to push the tags and create the GitHub releases.

## Maintainer setup (one-time)

0. **Rename the default branch to `trunk`** (Settings → General → Default branch). The workflows, Changesets and the fallow gate are already configured for `trunk`; until the rename neither CI nor Release runs.
1. **Allow Actions to open the Version Packages PR.** In the repo: **Settings → Actions → General → Workflow permissions** → enable **"Allow GitHub Actions to create and approve pull requests"**. Without this the built-in `GITHUB_TOKEN` is forbidden from opening pull requests and the workflow fails at the PR-creation step — even though the job already grants `pull-requests: write`.
2. **Bootstrap each package on npm.** A trusted publisher can only be configured on a package that already exists, so the very first version of each package is published by hand from a clean checkout (`vp run -r build && pnpm --filter <name> publish --access public`, with an npm login that has publish rights on the `@thomasfosterau` scope; no `--provenance`, which can only be generated on CI), or the first `Release` run is given a short-lived granular token via a `NODE_AUTH_TOKEN` step that is removed afterwards.
3. **Configure the trusted publisher** on npmjs.com for each package → **Settings → Trusted Publisher**:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/effect-document`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

4. **Protect the `release` environment.** **Settings → Environments → `release`** → enable **Required reviewers** (yourself) and restrict deployment to the `trunk` branch, so publishing pauses for manual approval.
5. **Protect `trunk`.** Require pull requests and passing CI before merge, and disallow direct pushes, so a release can only be triggered by merging the reviewed "Version Packages" PR.
