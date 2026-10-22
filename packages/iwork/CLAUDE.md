# @thomasfosterau/effect-iwork (packages/iwork)

Read-only Apple iWork readers, each with its own profile: `keynote.ts` (slide text), `pages.ts` (body text), `numbers.ts` (sheet structure). They sit on the container codec (`./codec`): `bundle.ts` (the ZIP bundle and its `.iwa` components), `iwa.ts` (chunk framing), `snappy.ts` (the Snappy block codec), `protobuf.ts` (the wire reader), `archive.ts` (archived objects and messages), `registry.ts` (the message type ids the readers use) and `text.ts` (text storages to paragraphs).

## Boundary

Peers: `effect`; dependencies `@thomasfosterau/effect-document`, `@thomasfosterau/effect-parse` and `fflate` (ZIP). `.fallowrc.json` zone `iwork` may import `core` only.

## Invariants

- **Read-only, text only.** Writing needs Apple's proprietary object-graph schemas; there is no writer, and no reader claims more structure than it extracts (Numbers has no cell values yet).
- **iWork's Snappy is block-only** (no stream framing or CRC); copies may overlap and are expanded byte by byte. The compressor emits literals only, which is valid and accepted by Apple's decoder.
- **The codec is synchronous and throws `IworkFormatError`** (an encrypted bundle, a malformed varint) or effect-parse failures; the readers wrap them as a `ParseError`'s `cause`. An `.iwph` entry marks a password-protected document, which is refused.
- **Message type ids are reverse-engineered** (keynote-parser's v14.4 mapping) and may drift between iWork versions; add a new one to `registry.ts` with its archive name.
- **Fixtures are vendored** from MIT-licensed projects (`test/fixtures/ATTRIBUTION.md`); keep the attribution with any new one.
