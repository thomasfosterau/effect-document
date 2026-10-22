---
"@thomasfosterau/effect-iwork": patch
---

iWork codec hardening:

- Snappy: the preamble is capped (64 MiB per block, and no more than the input can expand to), and every copy offset, copy length and literal is checked against the input and output. A block must produce exactly its declared length. `dechunk` caps a whole stream at 256 MiB (`maxLength`).
- Archive stream: ArchiveInfo and payload lengths are checked against the buffer, and a missing identifier, type or length is an error instead of 0. Object identifiers are exact `bigint`s.
- Protobuf: fixed-width fields keep their raw bytes. New `getDouble`, `getFloat`, `getBigInt` (`uint64`, `int64`, `sint64`), `getSint` and `getPacked` helpers. Varints above 2^53 keep their exact value.
- Errors: the codec fails only with a typed `IworkError` that carries a reason, the component, the object id and the byte offset. `openBundle`, `decodeComponent`, `decodeAll` and `decodeIwa` return a `Result`. The readers keep the location in the `ParseError` and take a `lenient` option that skips a bad component with a logged warning.
- Memory: only `Index/*.iwa` components (and `Index.zip`) are inflated, under entry-count, entry-size and total-size limits. Media is read on demand with `bundle.readEntry`. `openBundleDirectory` opens an unzipped package directory through `FileSystem`.
