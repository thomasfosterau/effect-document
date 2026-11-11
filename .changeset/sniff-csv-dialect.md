---
"@thomasfosterau/effect-document": minor
---

`Csv.sniffDialect(text)` finds the CSV dialect of a bounded sample (the first 64 KiB, #188): the separator (comma, semicolon, tab or pipe), the line break, any preamble lines to skip, and whether the first row is a header, using the reader's own rule. It returns them as reader options, with a confidence and an evidence string.
