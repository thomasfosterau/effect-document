---
"@thomasfosterau/effect-document": minor
---

Add `sheetRowOfNumbers(index, cells)`: `sheetRowOf` for a row its caller expects to hold only plain numbers, with the same result and the same failures. Its check of the numbers only ever meets arrays of numbers, which V8 holds as unboxed doubles and reads without boxing; `sheetRowOf`'s check meets every kind of row and boxes each number it reads from such an array. The CSV reader uses it for rows of numbers.
