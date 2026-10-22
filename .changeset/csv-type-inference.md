---
"@thomasfosterau/effect-csv": patch
---

Stop CSV type inference from corrupting values, and make it configurable.

- Only plain decimals (`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`) with at most 15 significant digits are read as numbers. `007`, ZIP codes, `0x1F`, `0b11`, `+1`, `12`, `Infinity` and long IDs now stay text.
- Booleans are matched case-insensitively, so Excel's `TRUE`/`FALSE` read as booleans.
- New inference options: `inference: "column"` types a whole column by all of its values (per-cell stays the default); `booleans` and `booleansCaseSensitive`; `decimalChar` and `groupChar` (CSVW names); `percent`; and `nullValues` for values read as blank cells.
- `inferCell` takes the same options as an optional second argument.
- The `inferTypes` docs describe what inference loses.
