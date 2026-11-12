---
"@thomasfosterau/effect-document": patch
---

fix(pdf): a file without its `%PDF-` header is read when an object definition starts it, repaired by the object scan, as pdf.js reads it (#173). Anything else without a header is still refused.
