/**
 * effect-document: numbers (read-only, structure only - experimental)
 *
 * Reads the sheet structure of Apple Numbers (.numbers) spreadsheets: each
 * `TN.SheetArchive` becomes a named (empty) worksheet, in the order of the
 * `TN.DocumentArchive`'s sheet list. Cell *values* are NOT yet
 * read - Numbers stores them in a hand-packed binary cell-storage blob (the hard
 * part), which is a deferred future phase. This still validates the container
 * codec against real Numbers files and surfaces the workbook's sheets.
 */

import { Effect, Layer } from "effect";
import {
  type Content, defineProfile, type Doc, document, type FeaturesOf, type Format, makeReaderTag,
  type ParseError, type Reader, trustAs, Worksheet,
} from "@thomasfosterau/effect-document";
import { decodeUtf8, getAllBytes, getBigInt, getBytes, parseMessage } from "./protobuf.js";
import { eachComponent, type IworkReaderOptions, openInput } from "./read.js";
import { REFERENCE_IDENTIFIER_FIELD, TN_DOCUMENT_ARCHIVE, TN_SHEET_ARCHIVE } from "./registry.js";

export type { IworkReaderOptions } from "./read.js";

export const numbersFeatures = [
  "sheet.worksheet",
  "sheet.multiple",
  "cell.text",
  "cell.number",
  "cell.boolean",
  "cell.blank",
] as const;

/** The Numbers (read) profile. */
export const Numbers = defineProfile("numbers", numbersFeatures);
export type NumbersFeature = FeaturesOf<typeof Numbers>;

const SHEET_NAME_FIELD = 1; // TN.SheetArchive.name
const DOCUMENT_SHEETS_FIELD = 1; // TN.DocumentArchive.sheets (repeated TSP.Reference)

/** What the reader collects from the objects: the document's sheet order, and the sheets. */
type Found =
  | { readonly _tag: "Order"; readonly ids: ReadonlyArray<bigint> }
  | { readonly _tag: "Sheet"; readonly id: bigint; readonly name: Uint8Array | undefined };

const find = (type: number, id: bigint, payload: Uint8Array): Found[] => {
  if (type === TN_SHEET_ARCHIVE) {
    return [{ _tag: "Sheet", id, name: getBytes(parseMessage(payload), SHEET_NAME_FIELD) }];
  }
  if (type === TN_DOCUMENT_ARCHIVE) {
    const ids: bigint[] = [];
    for (const ref of getAllBytes(parseMessage(payload), DOCUMENT_SHEETS_FIELD)) {
      const sheetId = getBigInt(parseMessage(ref), REFERENCE_IDENTIFIER_FIELD);
      if (sheetId !== undefined) ids.push(sheetId);
    }
    return [{ _tag: "Order", ids }];
  }
  return [];
};

/**
 * The sheets in the document's order. A sheet the document doesn't list keeps
 * its place after the listed ones, in component order.
 */
const inDocumentOrder = (found: ReadonlyArray<Found>) => {
  const sheets = found.filter((f) => f._tag === "Sheet");
  const order = found.find((f) => f._tag === "Order")?.ids ?? [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return sheets
    .map((sheet, i) => ({ sheet, key: rank.get(sheet.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map(({ sheet }) => sheet);
};

/**
 * Create a Numbers Reader (structure only - sheet names, no cell values yet).
 * A component that fails to decode fails the read unless `lenient`.
 */
export const makeNumbersReader = (options?: IworkReaderOptions): Reader<NumbersFeature> => {
  const read = (input: Content): Effect.Effect<Doc<NumbersFeature>, ParseError> =>
    Effect.gen(function* () {
      const bundle = yield* openInput("numbers", input, options);
      const decoded = yield* eachComponent("numbers", bundle, Object.keys(bundle.components), options, (obj) =>
        obj.messages.flatMap((msg) => find(msg.type, obj.identifier, msg.payload))
      );
      const names = inDocumentOrder(decoded.flatMap(({ items }) => items)).map(({ name }, i) =>
        name === undefined ? `Sheet${i + 1}` : decodeUtf8(name)
      );
      if (names.length === 0) names.push("Sheet1");
      const sheets = names.map(
        (name) => new Worksheet({ name, columns: [], rows: [], merges: [] })
      );
      return trustAs<NumbersFeature>(document(sheets));
    });
  return { format: "numbers", profile: Numbers, read };
};

/** The Numbers profile (alias of {@link Numbers}). */
export const profile = Numbers;

/** The Numbers format bundle (read-only, structure only) for use with `convert`. */
export const format: Format<NumbersFeature> = {
  id: "numbers",
  readProfile: Numbers,
  writeProfile: Numbers,
  reader: makeNumbersReader(),
};

export const NumbersReaderTag = makeReaderTag<NumbersFeature>("numbers");
export const NumbersReaderLive = Layer.succeed(NumbersReaderTag, makeNumbersReader());
