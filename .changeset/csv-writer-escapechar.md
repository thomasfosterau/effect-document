---
"@thomasfosterau/effect-csv": minor
---

Add an `escapeChar` writer option (#89), as Python's `escapechar` with `doublequote=False`: inside quoted fields the wrapper and the escape character are escaped with it instead of the wrapper being doubled, and with `quoting: "none"` the separator, wrapper, escape character and line breaks are escaped in place instead of failing the write. An `escapeChar` that is not one character, or that is the separator, the wrapper or a line break, fails the write (or the stream). `formatNumber` now accepts an explicit `undefined`. The README documents the writer options and the formula-injection risk `escapeFormulae` guards against.
