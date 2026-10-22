/**
 * effect-document: numbers (read-only, structure only - experimental)
 *
 * Reads the sheet structure of Apple Numbers (.numbers) spreadsheets: each
 * `TN.SheetArchive` becomes a named (empty) worksheet. Cell *values* are NOT yet
 * read - Numbers stores them in a hand-packed binary cell-storage blob (the hard
 * part), which is a deferred future phase. This still validates the container
 * codec against real Numbers files and surfaces the workbook's sheets.
 */

import { Effect, Layer } from "effect";
import {
  type Content, defineProfile, type Doc, document, type FeaturesOf, type Format, makeReaderTag,
  type ParseError, type Reader, trustAs, Worksheet,
} from "@thomasfosterau/effect-document";
import { decodeUtf8, getBytes, parseMessage } from "./protobuf.js";
import { eachComponent, type IworkReaderOptions, openInput } from "./read.js";
import { TN_SHEET_ARCHIVE } from "./registry.js";

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

/**
 * Create a Numbers Reader (structure only - sheet names, no cell values yet).
 * A component that fails to decode fails the read unless `lenient`.
 */
export const makeNumbersReader = (options?: IworkReaderOptions): Reader<NumbersFeature> => {
  const read = (input: Content): Effect.Effect<Doc<NumbersFeature>, ParseError> =>
    Effect.gen(function* () {
      const bundle = yield* openInput("numbers", input, options);
      // a sheet's name, or undefined when it has none
      const decoded = yield* eachComponent("numbers", bundle, Object.keys(bundle.components), options, (obj) =>
        obj.messages
          .filter((msg) => msg.type === TN_SHEET_ARCHIVE)
          .map((msg) => getBytes(parseMessage(msg.payload), SHEET_NAME_FIELD))
      );
      const names: string[] = [];
      for (const { items } of decoded) {
        for (const nameBytes of items) {
          names.push(nameBytes === undefined ? `Sheet${names.length + 1}` : decodeUtf8(nameBytes));
        }
      }
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
  profile: Numbers,
  reader: makeNumbersReader(),
};

export const NumbersReaderTag = makeReaderTag<NumbersFeature>("numbers");
export const NumbersReaderLive = Layer.succeed(NumbersReaderTag, makeNumbersReader());
