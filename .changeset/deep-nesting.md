---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-ooxml": patch
"@thomasfosterau/effect-pdf": patch
---

Deeply nested documents no longer overflow the stack in feature collection (`Profile.is`, `validate`, `collectFeatures`) or in the text collapse (`blocksToText`, `inlinesToText`, `cellToText`, `shapeToText`): these walks now use an explicit stack.

New in core: `nestingDepth` / `blocksNestingDepth` (iterative), `DEFAULT_MAX_NESTING_DEPTH` (128, below the depth at which Schema encoding of nested tables overflows the stack), `limitNestingDepth`, and an optional `ParseError.code` (`"LimitExceeded"`). The DOCX and PDF readers, whose nesting follows the input, take a `maxDepth` option and fail with a `LimitExceeded` ParseError past it.
