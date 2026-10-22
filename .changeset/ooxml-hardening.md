---
"@thomasfosterau/effect-ooxml": patch
---

Harden the OOXML XML parser and OPC package handling.

XML parser:

- It now builds its tree iteratively, so 20,000+ levels of nesting no longer overflow the stack.
- `parseXmlResult` never throws, and invalid character references become U+FFFD.
- Element namespaces are resolved into a new `ns` field. When `w:val` and `w14:val` both exist, `getAttr` prefers the attribute in the element's own namespace.
- `mc:AlternateContent` resolves to an understood `mc:Choice`, otherwise to the `mc:Fallback`.
- DOCTYPE internal subsets are skipped, and entities are never expanded.
- Names are validated, and duplicate attributes are rejected.

`OpcReader`:

- Parts are inflated lazily, within configurable limits on entry count, per-part size and total size (`OpcLimits`, the reader option `limits`).
- Part names match case-insensitively, and relationship targets are percent-decoded.
- UTF-16 parts are decoded.
- `[Content_Types].xml` is checked, so a package of the wrong type fails with `WrongPackageType` instead of reading as empty.

Readers:

- Malformed XML reports its part and line/column in `ParseError.position`.
- The XLSX reader uses the shared `OpcReader`.

Writers:

- Zip output is byte-deterministic (fixed `mtime`).
