---
"@thomasfosterau/effect-pdf": patch
---

The COS parser refuses arrays and dictionaries nested more than `MAX_OBJECT_NESTING` (512) levels deep with a `PdfSyntaxError` carrying `code: "LimitExceeded"`, instead of overflowing the stack; the reader reports it as a `ParseError` with the same code.
