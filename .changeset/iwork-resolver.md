---
"@thomasfosterau/effect-document": minor
---

feat(iwork): the package metadata and a cross-component object resolver (#101). `readPackageMetadata` reads `Index/Metadata.iwa`: the file format version, each component's path and external references, and each data file's path under `Data/`. `makeObjectResolver` finds an archived object by identifier, decoding each component at most once and only when needed. `referenceAt` reads a `TSP.Reference` field. All three are on `./iwork/codec`.
