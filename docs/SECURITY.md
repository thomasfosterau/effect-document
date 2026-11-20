# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's [Report a vulnerability](https://github.com/thomasfosterau/effect-document/security/advisories/new) form, not a public issue. Include a description, reproduction steps and the affected version.

## Untrusted input

The readers parse files from anywhere and are written to fail, not hang or crash, on malformed input: every reader returns a `ParseError` rather than throwing, the PDF object layer bounds recursion and repairs rather than trusts cross-reference data, and encrypted PDF and iWork files are refused. Zip containers are inflated under limits: the OOXML (`OpcLimits`) and iWork (`BundleLimits`) readers take a `limits` option (`maxEntries`, `maxEntrySize`, `maxTotalSize`; defaults 10,000 entries, 256 MiB per entry, 512 MiB in total) and check each entry's declared size before inflating it, failing with `code: "LimitExceeded"`. iWork's Snappy decompression is capped (64 MiB per block, 256 MiB per component). PDF Flate streams are not size-limited, so bound the input size you accept for untrusted PDFs. A file that makes a reader hang, exhaust memory or throw is a bug worth reporting.

## Supply chain

- Releases use npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no npm token. Provenance is attached once the repository is public.
- Privileged release jobs install with `--frozen-lockfile --ignore-scripts`, publish with `vp pm publish -- --ignore-scripts` (`vp run release`, after `check:dist` on the same commit; the consumer `check:pack`, which installs from the registry, runs only in CI), use no dependency cache, and run only after `actions.lock` verifies. Publishing needs approval in the protected `release` environment.
- Workflows default to `permissions: {}` and pin actions by tag, locked to commits by `.github/workflows/actions.lock`.
- pnpm's `minimumReleaseAge` holds new versions for 24 hours; Dependabot waits a day.
- [Socket](https://socket.dev) scans dependencies (`socket.yml`), except the private `bench/` package.
