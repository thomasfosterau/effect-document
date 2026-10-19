# @thomasfosterau/effect-document

The core of effect-document: a type-safe, profile-based universal document schema built on [Effect](https://effect.website) 4, the phantom-typed `Doc<F>` profile system with `widen`/`narrow`, the `Reader`/`Writer`/`Format` abstractions, and the lossy-aware `convert` pipeline.

```bash
bun add effect @thomasfosterau/effect-document
```

Formats are separate packages: `@thomasfosterau/effect-csv`, `@thomasfosterau/effect-ooxml`, `@thomasfosterau/effect-rtf` and `@thomasfosterau/effect-iwork`.

See the [repository README](https://github.com/thomasfosterau/effect-document#readme) for the schema, profiles and conversion model.
