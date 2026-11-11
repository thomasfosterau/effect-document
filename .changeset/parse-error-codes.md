---
"@thomasfosterau/effect-document": minor
---

`ParseError.code` is now a shared union every reader fills (#127): `InvalidContainer`, `WrongFormat`, `MissingPart`, `Encrypted`, `MalformedXml`, `MalformedBinary`, `MalformedText`, `LimitExceeded` and `Unsupported`, so a caller can branch on the kind of failure instead of its message. `ParseError.position` gains `part`, `offset`, `component`, `object`, `sheet` and `cell`: a malformed OOXML part names the part, a PDF syntax error its byte offset, an iWork failure its component and object, and an XLSX over its cell limit the sheet. The XLSX reader's `maxCells` failure now carries `LimitExceeded`, and a non-zip OOXML input fails as `InvalidContainer` rather than with fflate's message. `ParseErrorCode` and `SourcePosition` are exported.
