---
"@thomasfosterau/effect-csv": patch
---

CSV type inference keeps a value as a number exactly when a double holds its written significant digits, replacing the 15-significant-digit cutoff. Full-precision doubles such as `0.30000000000000004` are now read as numbers. Values that would change when parsed still stay text, such as 20-digit IDs, `9007199254740993` (2^53 + 1) and `1e400`.
