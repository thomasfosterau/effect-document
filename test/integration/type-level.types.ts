/**
 * Compile-only assertions for the profile type system. This file is type-checked
 * by `tsc` (it is under `test/`), not executed by `bun test`. Each
 * `@ts-expect-error` asserts that an *unsound* assignment is correctly rejected;
 * if any such assignment ever started compiling, tsc would flag the now-unused
 * directive and fail the build.
 */

import {
  type BlockOf,
  type CellOf,
  type Doc,
  type Document,
  type FeaturesOf,
  type InlineOf,
  Profiles,
  type TagsOf,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import { Docx, Xlsx } from "@thomasfosterau/effect-ooxml";
import * as Pdf from "@thomasfosterau/effect-pdf";
import * as Rtf from "@thomasfosterau/effect-rtf";

type CsvF = FeaturesOf<typeof Profiles.Csv>;
type SpreadsheetF = FeaturesOf<typeof Profiles.Spreadsheet>;

declare const csvDoc: Doc<CsvF>;
declare const fullDoc: Doc; // the richest document (Doc<Feature>)
declare const bareDoc: Document; // an unbranded, unvalidated document

// (1) Widening is free: a CSV document satisfies any superset profile.
export const widenToAny: Doc = csvDoc;
export const widenToSpreadsheet: Doc<SpreadsheetF> = csvDoc;

// (2) An over-rich document is NOT assignable to a narrower profile.
// @ts-expect-error a full document is too rich for the CSV profile
export const tooRich: Doc<CsvF> = fullDoc;

// (3) A writer only accepts documents its format can represent.
declare const xlsxWriter: NonNullable<typeof Xlsx.format.writer>;
declare const csvWriter: NonNullable<typeof Csv.format.writer>;

// A CSV document can be written by the (wider) XLSX writer - free widening.
export const widenForWrite = xlsxWriter.write(csvDoc);

// But a full document cannot be handed to the CSV writer.
// @ts-expect-error full document is richer than the CSV writer can represent
export const writeTooRich = csvWriter.write(fullDoc);

// (4) An unbranded, unvalidated Document cannot be written at all - you must
// establish which profile it conforms to first (validate / narrow).
// @ts-expect-error a bare Document has no profile brand
export const writeBare = csvWriter.write(bareDoc);

// (5) Prose formats: RTF fits inside DOCX, but a DOCX document (tables...) is
// too rich for the PDF writer.
declare const rtfDoc: Doc<FeaturesOf<typeof Rtf.profile>>;
declare const docxDoc: Doc<FeaturesOf<typeof Docx.profile>>;
declare const pdfWriter: NonNullable<typeof Pdf.format.writer>;
export const rtfIntoDocx: Doc<FeaturesOf<typeof Docx.profile>> = rtfDoc;
// @ts-expect-error a DOCX document may hold tables, which the PDF writer can't represent
export const docxIntoPdf = pdfWriter.write(docxDoc);

// (6) A profile's node types (#109): `TagsOf` maps features to the tags of
// the nodes they name, and `BlockOf` / `InlineOf` / `CellOf` are the nodes a
// document of the profile may hold, which writers render exhaustively.
type CsvTags = TagsOf<CsvF>;
export const csvTag: CsvTags = "CellNumber";
// @ts-expect-error a date cell is not in the CSV profile
export const notCsvTag: CsvTags = "CellDate";
declare const csvCell: CellOf<CsvF>;
export const csvCellTag: "CellText" | "CellNumber" | "CellBoolean" | "CellBlank" = csvCell._tag;
declare const pdfInline: InlineOf<FeaturesOf<typeof Pdf.format.writeProfile>>;
// @ts-expect-error inline code is not in the PDF write profile
export const pdfCode: "Code" = pdfInline._tag;
declare const docxBlock: BlockOf<FeaturesOf<typeof Docx>>;
// @ts-expect-error a rule is not in the DOCX profile
export const docxRule: "HorizontalRule" = docxBlock._tag;
