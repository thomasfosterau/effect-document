---
"@thomasfosterau/effect-rtf": minor
"@thomasfosterau/effect-ooxml": minor
---

Move the RTF lexer and A1 references onto `@thomasfosterau/effect-parse`.

- The RTF reader now lexes with a compiled effect-parse grammar (groups, control words with signed parameters, control symbols, `\'hh` escapes, text) and interprets the tokens. Output is unchanged, and it is about 20% faster.
- `parseA1` is a parser too, and now rejects row 0 (`"A0"`), which used to produce row -1.
- New: `parseA1Absolute` for `$`-pinned references (`"$B$3"`) and `parseA1Range` for ranges (`"A1:B2"`). The `a1Cell`, `a1AbsoluteCell` and `a1Range` parsers are exported for use in larger grammars.
