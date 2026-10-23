---
"@thomasfosterau/effect-csv": minor
---

Add an `escapeChar` writer option (#89), as Python's `escapechar` with `doublequote=False`: a wrapper inside a quoted field is written after the escape character instead of being doubled. It fails closed: a field holding the escape character itself fails the write, and `quoting: "none"` still fails on a field that needs quotes rather than escaping its separators or line breaks. An `escapeChar` that is not one character, or that is the separator, the wrapper or a line break, fails the write (or the stream). `formatNumber` now accepts an explicit `undefined`. The README documents the writer options and the formula-injection risk `escapeFormulae` guards against.
