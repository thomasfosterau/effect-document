---
"@thomasfosterau/effect-document": patch
---

fix(ooxml): DOCX, XLSX and PPTX writing no longer fails on hosts west of UTC ("date not in range 1980-2099"), and writes the same bytes in every time zone. fflate encodes zip timestamps in local time, so the fixed 1980-01-01 timestamp is now built from local fields.
