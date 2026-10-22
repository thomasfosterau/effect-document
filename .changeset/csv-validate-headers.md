---
"@thomasfosterau/effect-csv": minor
---

Add a `validateHeaders` scan option. When set, a header row with an empty or whitespace-only name, or a name used twice, fails with a `ParseError` that gives the column. This applies to the first row and to `providedHeaders`, in both `scanCsv` and `scanCsvStream`. It is off by default, so such headers are still kept as they are.
