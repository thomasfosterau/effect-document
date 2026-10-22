---
"@thomasfosterau/effect-rtf": patch
---

Fix the RTF reader's character decoding, formatting state and destinations.

- `\'hh` escapes are decoded through the active font's `\fcharset` / `\cpg`
  or the document's `\ansicpg` (cp1252 `\'93` is now `“`), and double-byte
  code pages (932, 936, 949, 950) combine lead and trail bytes.
- `Bytes` input is read as 7-bit RTF: 8-bit bytes go through the code page
  instead of being decoded as UTF-8.
- `\ucN` sets the `\u` fallback length, a `\'hh` fallback is skipped, `\u`
  surrogate pairs combine, and an out-of-range `\u` parameter fails with a
  `ParseError` instead of a defect.
- `\plain` resets character formatting. Special-character words (`\rquote`,
  `\emdash`, `\bullet`, ...) and `\-` / `\_` produce their characters.
- `\cell` separates cells with a tab; `\row`, `\sect`, `\page` and `\column`
  break paragraphs.
- Footnotes, `\v` hidden text, `\deleted` revisions, `\fldinst`, `\listtext`
  and many unstarred destinations (`annotation`, `object`, `shp`, `xe`,
  `header*`, `rsidtbl`, ...) are no longer read as body text.
- `\binN` data is skipped; `\tab-y` keeps its hyphen; text after the
  outermost group is ignored; input that doesn't start with `{\rtf` fails
  with a `ParseError`.
