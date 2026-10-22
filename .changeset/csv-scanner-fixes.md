---
"@thomasfosterau/effect-csv": patch
---

Fix several CSV scanner bugs.

- A wrapper inside an unquoted field is now a literal character, so
  `12" pizza,3` no longer swallows the following records. Text after a closing
  quote is still kept (`"a"b` reads as `ab`). The old behaviour, where quoted
  segments may start anywhere in a field, is available as `quoteAnywhere`.
- An empty `wrapper` turns quoting off instead of breaking the parser.
- Multi-character separators are matched whole, so fields may contain their
  characters (`a|b||c` with separator `||`).
- `skipRows` counts CRLF, LF and bare CR line endings, in `scanCsv` and
  `scanCsvStream` (a CRLF may be split across chunks).
- `trimWhitespace` keeps whitespace inside quoted fields.
- Without headers, every row must be as wide as the first unless
  `allowVariableColumns` is set. Column-count and syntax errors both report
  the 0-based source row in `position.row`, counting skipped, blank, comment
  and quoted lines.
- Stream syntax errors now carry a source position, and an unclosed quote reads
  "Unclosed quoted field: expected a closing quote" in both scanners.
- With `treatFirstRowAsHeader`, `providedHeaders` now replace the header row
  instead of being ignored.
- The compiled-parser cache evicts the least recently used grammar instead of
  clearing itself.
- A leading byte order mark is ignored for text input.
