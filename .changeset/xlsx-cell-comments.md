---
"@thomasfosterau/effect-document": minor
---

Cell comments. The schema gains `Comment` (author, initials, date, resolved mark, body blocks and replies, shared with the prose comments to come) and `CellComment`, and `Worksheet.comments` lists a sheet's, under the new `review.comments` and `review.threads` features (`Spreadsheet` and `Full` allow both). `narrow` drops comments for a profile without them, puts them in notes when a worksheet becomes a prose table, and folds a thread into its comment for a profile without threads, reporting each. `withSheetComments` sets a sheet's comments and `withSheetLayout` carries them. XLSX reads legacy notes and Excel's threaded comments (replies, resolved marks, dates and authors) and writes legacy notes with the VML drawing Excel shows them with; the `Xlsx` profile has `review.comments` and `XlsxRead` also `review.threads`.
