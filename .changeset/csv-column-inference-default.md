---
"@thomasfosterau/effect-csv": minor
---

New reader defaults, by owner decision on #88:

- The CSV reader sniffs the header row when `treatFirstRowAsHeader` is unset. The first row is the header when it has at least two rows, every value in the first row is non-empty text, and at least one column below it is all numbers or booleans (like Python's `csv.Sniffer.has_header`). An explicit `true` or `false` overrides the sniff. The header row is read as text and left out of inference. The scanners and `readStream` still default to no header.
- Type inference is per-column by default (`inference` defaults to `"column"`): a column is numeric or boolean only if every value in it is, and otherwise the whole column stays text. Pass `inference: "cell"` for the previous value-by-value inference.
