# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-document/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected package and version.

## Supply-chain hardening

These packages are published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Once the source repository is public, every version the release workflow publishes carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements), cryptographically linking the artifact to the exact source commit and workflow. Provenance is only attached when the source repository and the package are both public, so while this repository is private `pnpm publish` skips it with a warning.
- **Install scripts disabled in the release job.** The release workflow installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts`, and turns off pnpm 11's `verify-deps-before-run` for that job (`pnpm_config_verify_deps_before_run: "false"`) so a later `pnpm run` cannot silently re-install with scripts; a compromised (transitive) dependency cannot execute install hooks in the privileged publish job. The publish itself runs as `pnpm -r publish --ignore-scripts`, so no package lifecycle script (`prepublishOnly`, `prepack`, …) runs there either. No unpinned tooling is installed there: pnpm (pinned by `packageManager`) performs the OIDC exchange itself, so npm is never upgraded in the job. CI runs the workspace's own `prepare` (the `@effect/tsgo` patch the type gate needs) but only ever holds read permissions.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject malicious workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `minimumReleaseAge` holds newly published third-party versions for 8 hours before pnpm will install them; Dependabot proposes updates for review after a 1-day cooldown (its smallest unit), so it never proposes a version pnpm would refuse.

## Untrusted input

The readers parse files from anywhere. They are written to fail, not hang or crash, on malformed input: every reader returns a `ParseError` in the error channel rather than throwing, the PDF object layer bounds recursion (page trees, Form XObjects, reference chains) and repairs rather than trusts cross-reference data, and encrypted PDF and iWork files are refused. Zip containers are inflated under zip-bomb limits: the OOXML readers (`OpcLimits`) and the iWork readers (`BundleLimits`) take the same `limits` option (`maxEntries`, `maxEntrySize`, `maxTotalSize`; defaults 10,000 entries, 256 MiB per entry and 512 MiB in total), inflate only the parts they read, and check each entry's declared size before inflating it, so a zip bomb fails with a `ParseError` whose `code` is `"LimitExceeded"`. iWork's Snappy decompression is capped too (64 MiB per block, 256 MiB per component). PDF Flate streams are not size-limited (a stream is inflated to whatever length it produces), so a consumer reading untrusted PDFs should bound the input size it accepts. A file that makes a reader hang, exhaust memory or throw is a bug worth reporting through the channel above.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).
