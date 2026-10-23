---
"@thomasfosterau/effect-rtf": patch
---

The RTF reader decodes cp1252 (`\ansicpg1252`, `\fcharset0`, and the fallback for unsupported code pages such as 437 and 850) by table instead of through `TextDecoder("windows-1252")`, so bytes 0x80–0x9F come out as `€`, `“`, `”`, `–` and the rest of cp1252 on Node 22 too, where `TextDecoder` returned their Latin-1 C1 control characters.
