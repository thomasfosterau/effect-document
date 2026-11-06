/**
 * The typed cell a SpreadsheetML `<c>` holds, from the texts of its parts:
 * what the XLSX reader's tree path (`spreadsheetMlToCell`) and its
 * `sheetData` scanner share, so both type cells alike. Not part of the XLSX
 * entry (only `decodeXstring` is, through `cellTypes.ts`).
 */

import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import { cell, type SheetCell } from "../../index.ts";

/**
 * Decode SpreadsheetML's `_xHHHH_` escapes (ST_Xstring), which carry
 * characters XML 1.0 can't (control characters, lone surrogates). `_x005F_`
 * escapes a literal underscore, so `_x005F_x0041_` decodes to `_x0041_`.
 */
export const decodeXstring = (s: string): string =>
  s.includes("_x")
    ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
    : s;

/**
 * The typed cell a SpreadsheetML `<c>` without a formula holds, from its type
 * (the `t` attribute, `"n"` when absent), the text of its `<v>` and the text
 * of its `<is>` (each none when the cell has none). The XLSX reader's
 * tree path and its `sheetData` scanner both read cells through this.
 */
export const cellOfText = (
  type: string,
  v: Option.Option<string>,
  inline: Option.Option<string>,
  sharedStrings: ReadonlyArray<string>,
): SheetCell => {
  if (type === "inlineStr") return Option.match(inline, { onNone: cell.blank, onSome: cell.text });
  const read = HashMap.get(CELL_READERS, type);
  return Option.isSome(read) ? read.value(v, sharedStrings) : numberCell(v);
};

type CellReader = (v: Option.Option<string>, sharedStrings: ReadonlyArray<string>) => SheetCell;

/** A cell whose `<v>`, when present, maps to a cell through `f`. */
const valued =
  (f: (v: string) => SheetCell): CellReader =>
  (v) =>
    Option.match(v, { onNone: cell.blank, onSome: f });

/** A numeric cell (`t="n"`, the default). */
const numberCell = (v: Option.Option<string>): SheetCell =>
  Option.match(
    Option.filter(v, (text) => text.trim() !== ""),
    {
      onNone: cell.blank,
      onSome: (text) => {
        const num = Number(text);
        return Number.isFinite(num) ? cell.number(num) : cell.text(text);
      },
    },
  );

/** The readers for each `t` cell type other than the numeric default and `inlineStr`. */
const CELL_READERS = HashMap.make<ReadonlyArray<readonly [string, CellReader]>>(
  [
    "s",
    (v, sharedStrings) =>
      Option.match(
        Option.flatMap(v, (text) => Arr.get(sharedStrings, Number.parseInt(text, 10))),
        { onNone: cell.blank, onSome: cell.text },
      ),
  ],
  ["str", valued((v) => cell.text(decodeXstring(v)))],
  ["b", valued((v) => cell.boolean(v.trim() === "1"))],
  ["e", valued((v) => cell.error(v))],
  [
    // An ISO 8601 date (Strict files and some producers).
    "d",
    (v) =>
      Option.match(
        Option.filter(v, (text) => text.trim() !== ""),
        {
          onNone: cell.blank,
          onSome: (text) => {
            // oxlint-disable-next-line effect/use-clock-service -- parses the cell's date, never reads the clock
            const date = new Date(text.trim());
            return Number.isNaN(date.getTime()) ? cell.text(text) : cell.date(date);
          },
        },
      ),
  ],
);
