---
"@thomasfosterau/effect-csv": minor
---

Breaking defaults, by owner decision on #88:

- The CSV reader and scanners now take the first row as the header (`treatFirstRowAsHeader` defaults to `true`, as in pandas). Pass `treatFirstRowAsHeader: false` for a headerless file.
- Type inference is per-column by default (`inference` defaults to `"column"`): a column is numeric or boolean only if every value in it is, otherwise the whole column stays text. Pass `inference: "cell"` for the previous value-by-value inference.
