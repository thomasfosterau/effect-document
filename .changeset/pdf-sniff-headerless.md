---
"@thomasfosterau/effect-document": patch
---

`detect` recognises a PDF without its `%PDF-` header when an object definition opens it, as the PDF reader already reads such a file (#173), instead of ranking it as CSV (#188). `opensWithObject` (in `./pdf/cos`) is the check both use.
