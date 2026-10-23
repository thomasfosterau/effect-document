---
"@thomasfosterau/effect-csv": patch
---

Document that `formatCsvNumber` writes `NaN`, `Infinity` and `-Infinity` as text, as pandas does, and that they read back as text.
