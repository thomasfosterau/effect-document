---
"@thomasfosterau/effect-pdf": minor
---

Scanned pages: the reader lists pages that paint images but have no text in the document's `pagesWithoutText` metadata, and OCRs them when given an engine. The new `ocr` reader option (or the `OcrEngine` service with `PdfOcrReaderLive`) takes any engine implementing `OcrEngineShape`; none is bundled. The engine receives each image as the file stores it: JPEG, JPEG 2000, CCITT and JBIG2 data are passed through encoded, and other images arrive as decoded gray, RGB or CMYK samples. The words it returns are laid out like any other text. `PageText` gains `images`, and `decodeFilters` now also returns the image codec's `imageParms`.
