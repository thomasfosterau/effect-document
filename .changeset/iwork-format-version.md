---
"@thomasfosterau/effect-document": minor
---

The iWork readers report a document whose `fileFormatVersion` is outside the versions they are known to read (provisionally Numbers 11 to 26, Keynote 3; Pages is not checked yet) as an `iwork.unknownFormatVersion` diagnostic, and read it anyway. Diagnostics gain a `notice` severity for something worth knowing that loses nothing: like `repaired`, it leaves a loss report lossless and never fails `convert`'s `onLoss: "fail"`; `losesNothing` says which severities do.
