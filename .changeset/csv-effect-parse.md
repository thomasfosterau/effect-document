---
"@thomasfosterau/effect-document": minor
---

Rewrite the CSV scanner on `@thomasfosterau/effect-parse`.

- Quoted fields may now contain line breaks (RFC 4180), so fields the CSV
  writer quotes for embedded newlines read back intact.
- Bare CR line endings are accepted (previously a bare `\r` inside a line hung
  the scanner).
- An unclosed quote is a `ParseError` with its row and column, instead of being
  silently closed at the end of the line.
- New `scanCsvStream(chunks, dialect, options)` scans a `Stream` of text chunks
  and emits each row as soon as it is complete. `readStream` uses it, so rows
  are no longer all scanned up front.
- `scanCsv` uses a compiled, cached grammar: about 14x faster on a 4.5 MB file.
