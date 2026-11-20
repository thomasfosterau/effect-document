---
"@thomasfosterau/effect-document": minor
---

The `effect` peer is now `^4.1.5` (was `^4.0.0`). **Breaking** for apps on an earlier effect 4: upgrade it to 4.1.5. The iWork protobuf wire reader (`parseMessage`, `readVarint`, `getPacked` and the `varint`, `field` and `message` parsers in `/iwork/codec`) now runs on `ProtobufReader` from `effect/protobuf`. Records and accessors are unchanged; a tag with field number 0 is now a `Malformed` error, and a wire error's `detail` is worded as `effect/protobuf` words it.
