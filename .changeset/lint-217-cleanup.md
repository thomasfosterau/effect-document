---
"@thomasfosterau/effect-document": patch
"@thomasfosterau/effect-pdf": patch
---

Type-safety cleanup from the lint paydown (#217); no behaviour changes on any valid input. `dispatchTag` now types its node as the member of the union its tag names, so each handler gets its own node without a cast. `PdfFile.catalog` throws a `PdfSyntaxError` ("no document catalog") instead of returning a non-dictionary, and the stack-safe document decoder checks that its result is a `Document`.
