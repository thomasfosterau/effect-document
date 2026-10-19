---
"@thomasfosterau/effect-document": minor
---

Migrate to Effect 4. The `effect` peer dependency is now `^4.0.0`.

- Node schemas use the Effect 4 Schema API (`Schema.Union([...])`,
  `Schema.Literals([...])`, `Schema.Record(key, value)`, `Schema.Codec`).
  Encode and decode with `Schema.encodeEffect` / `Schema.decodeEffect`.
- `CellDate` still encodes to an ISO-8601 string (`Schema.DateFromString`).
- `Profile.schema` is typed as `Schema.Codec<Doc<F>, DocumentEncoded>`.
- `makeReaderTag` / `makeWriterTag` return `Context.Service` keys.
