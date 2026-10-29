---
"@thomasfosterau/effect-document": minor
---

Add `encodeDocument` / `decodeDocument` (and `encodeDocumentResult` / `decodeDocumentResult`), a wire codec for `Document` that handles any nesting depth (#191). Effect's Schema parser recurses once per level, so encoding or decoding a document a few hundred levels deep with `Schema` overflows the call stack and dies with a defect; the new codec walks the tree with an explicit work list. It produces the same JSON (key order included) and the same documents as the Schema codec, and fails with a `SchemaError` pointing at the offending node.
