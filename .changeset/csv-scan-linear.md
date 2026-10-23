---
"@thomasfosterau/effect-csv": patch
---

`scanCsv` (and so the CSV reader) no longer takes time quadratic in the input when it validates column counts, the default: a record's source row, which is found by walking the text up to it, is now computed only when that record's width is wrong and the error reports it. A 0.25 MB file that took about 3 s now scans in milliseconds.
