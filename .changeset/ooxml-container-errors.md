---
"@thomasfosterau/effect-document": patch
---

fix(ooxml): an encrypted (password-protected) Office file or a legacy binary `.xls` / `.doc` / `.ppt` (a Compound File Binary container) now fails with code `Encrypted` and says what it is, and a zip without its central directory says it is truncated. Both used to fail as "invalid zip data" (#173).
