---
"@thomasfosterau/effect-rtf": patch
---

Fix the RTF writer's character escaping and header, and round-trip headings.

- Characters above U+FFFF are written as a signed UTF-16 surrogate pair (`\u-10179?\u-8704?`), and control characters as `\uN` instead of raw.
- The header declares `\ansicpg1252` and `\uc1`, and has a font table (`\f0` Helvetica, `\f1` Courier New), a colour table and a stylesheet, so `\deff0` points at a real font.
- Headings are written with the `heading N` styles (`\sN\outlinelevelN`), and the reader maps `\outlinelevelN` and heading styles back to `Header`.
- The writer's switches are exhaustive over the profile, so a feature added to the profile without writer support is a compile error.
- New `RtfWriterOptions`: `lineEnding`, `font`, `fontSize`, `paperWidth` / `paperHeight` and `marginLeft` / `marginRight` / `marginTop` / `marginBottom`.
