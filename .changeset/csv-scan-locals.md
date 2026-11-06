---
"@thomasfosterau/effect-document": patch
---

`scanCsv` of quote-free text keeps the next separator and line-break positions in locals for each record, and knows a field ended at a separator without reading the character: about 4% less time on a 100k-row table of numbers, level with uDSV's `stringArrs` on the mean.
