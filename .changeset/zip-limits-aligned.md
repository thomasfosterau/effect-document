---
"@thomasfosterau/effect-ooxml": patch
"@thomasfosterau/effect-iwork": patch
---

Align the zip-bomb limits of the OOXML and iWork readers, so both are configured and fail the same way:

- OOXML: `OpcLimits` takes iWork's names, `maxEntrySize` (was `maxPartBytes`) and `maxTotalSize` (was `maxTotalBytes`), and every limit is optional (`?: number | undefined`; an explicit `undefined` keeps the default). The defaults are now iWork's: 10,000 entries, 256 MiB per part (was 100 MiB) and 512 MiB in total (was 500 MiB). The reader option is `limits?: OpcLimits` (was `Partial<OpcLimits>`).
- iWork: `ResolvedLimits` is renamed `ResolvedBundleLimits`, to match OOXML's new `ResolvedOpcLimits`. A limit failure becomes a `ParseError` with `code: "LimitExceeded"`, as OOXML's does, and every reader `ParseError`'s `reason` now names the `IworkError` reason (`Failed to read keynote: Truncated: …`).
- Both report a limit with the same messages: `more than N zip entries`, `<entry> is N bytes uncompressed, over the M-byte limit` and `the parts read exceed the N-byte total limit`.
