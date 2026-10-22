# @thomasfosterau/effect-document (packages/core)

The document schema (`src/schema`: the AST as `Schema.TaggedClass` nodes, attributes, the feature taxonomy, constructors), the profile system (`src/profile`: `defineProfile`, `Doc<F>`, conformance, `widen` / `narrow`, the built-in profiles) and the I/O pipeline (`src/io`: `Content`, `Reader` / `Writer` / `Format`, the tagged errors, `convert`). Every other package depends on it.

## Boundary

Peer: `effect`. Imports nothing from this workspace and no format: `.fallowrc.json` zone `core`, no outbound rule. A format-specific rule (an OOXML style, a PDF font) never lives here; it goes in the format's package, behind its own profile.

## Invariants

- **The schema is the wire format.** Every node encodes to plain JSON and decodes back (`Schema.encode` / `decode` of `Document`); a node added without its `*Encoded` interface and a place in the `Inline` / `Block` / `SheetCell` / `Shape` unions breaks that round trip.
- **Every node tag maps to exactly one feature** (`TAG_FEATURE` in `feature.ts`), and attribute facets are features too (`attr.id`, `attr.classes`, `attr.style`, `attr.keyValue`). A new node adds its tag there, to the right `ALL_*_FEATURES` group, to `narrow`'s handling and to `collectFeatures`.
- **`Doc<F>` is a phantom brand; only `defineProfile`'s `validate` / `schema`, `narrow` and `trustAs` produce one.** `trustAs` is the unchecked escape hatch for code that built the document itself; readers use it for their own output, never for input they did not produce.
- **`narrow` never drops silently.** Every node or facet it removes or down-converts is a `LossEntry` (`dropped` or `converted`, with a detail), in document order; `convert` returns the same report. A lossless narrowing reports `isLossless`.
- **Errors are tagged and carried in the error channel**: `ParseError` (format, reason, optional source position, cause), `WriteError`, `ProfileViolation` (the unsupported features), `ConversionError` (a format missing its reader or writer). Their tags and field names are API: every format package constructs them.

## Terms

- **Feature** — one capability a document can use: a node kind (`block.header`, `cell.date`) or an attribute facet (`attr.style`).
- **Profile** — a named feature set with its attribute policy, the type `Doc<F>` it brands, a runtime check (`is` / `validate`) and a `Schema`.
- **Widen / narrow** — moving a document to a superset profile (free, by assignability) or a subset one (lossy, reported).
