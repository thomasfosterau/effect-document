---
"@thomasfosterau/effect-csv": patch
---

The CSV reader, scanner and writer are faster (see `vp run bench:csv`). On 8 MB of mixed rows: `read` 1.85 s → about 0.4 s, 2.7× faster than SheetJS reading the same text into a workbook; `scanCsv` is at 1.1–1.9× uDSV, about level with d3-dsv and Papa Parse; `scanCsvStream` is 2× faster than before and faster than Papa Parse's and csv-parse's Node streams; `write` 0.9 s → about 0.25 s, close to Papa Parse writing the same rows from plain arrays (about 0.2 s). Type inference matches the default number syntax without a regular expression, and skips the null lookup for values that can't be null. Column-count and header errors are found as before, and a stream still emits the rows before a bad one before failing on it. Fixes: a `padRows` write of a sheet with hundreds of thousands of rows no longer overflows the stack.
