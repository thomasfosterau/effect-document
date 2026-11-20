# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) from [release.yml](../.github/workflows/release.yml).

## Flow

1. A change that affects the published package carries a changeset (`vp exec changeset`).
2. On `trunk`, the Release workflow opens or updates the "chore: version packages" PR (`pnpm run version`: `changeset version`, then `vp fmt` on the changelogs and a lockfile refresh). `.changeset/config.json` sets `"format": false` because Changesets would otherwise call Vite+'s IDE-only `oxfmt` shim, which fails outside an editor.
3. Merging that PR lets the `publish` job, after approval in the `release` environment, run `vp run release`: the build, `vp run check:dist` and the consumer pack check `vp run check:pack` on that commit, then `vp pm publish -r --access public --no-git-checks -- --ignore-scripts` (pnpm skips versions already on npm and does the OIDC exchange itself), then `changeset git-tag`, which tags each untagged version and reports the tags to the action, which pushes them and creates GitHub releases. A failed publish stops before tagging. There is no publish script.

`vp run release:dry-run` runs the same checks and lists what `vp pm publish` would publish, without publishing or tagging. `check:pack` packs separately from the publish: the checked and published tarballs come from the same commit in the same job, not the same file.

## One-time setup

1. **Settings → Actions → General**: allow GitHub Actions to create pull requests.
2. **npm**: publish the first version by hand from a clean `trunk` as `thomasfosterau` (`vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release`, then `git push origin --tags`; never from the package directory), then add a trusted publisher for `@thomasfosterau/effect-document` (GitHub Actions, `thomasfosterau/effect-document`, workflow `release.yml`, environment `release`) and remove any automation tokens.
3. **Environment `release`**: required reviewer (the owner), deployments from `trunk` only.
4. **`trunk`**: require pull requests and the CI checks `ci (node lts)` and `ci (node latest)`.
5. **Workflow lockfile**: generate `.github/workflows/actions.lock` with `gh actions-lock` and regenerate it after changing any `uses:`.
