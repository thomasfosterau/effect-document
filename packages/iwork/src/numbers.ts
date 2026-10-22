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
  type Content, contentToBytes, defineProfile, type Doc, document, type FeaturesOf, type Format,
  makeReaderTag, ParseError, type Reader, trustAs, Worksheet,
} from "@thomasfosterau/effect-document";
import { decodeAll, openBundle } from "./bundle.js";
import { decodeUtf8, getBytes, parseMessage } from "./protobuf.js";
import { TN_SHEET_ARCHIVE } from "./registry.js";

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

/** Create a Numbers Reader (structure only - sheet names, no cell values yet). */
export const makeNumbersReader = (): Reader<NumbersFeature> => {
  const read = (input: Content): Effect.Effect<Doc<NumbersFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const bundle = openBundle(contentToBytes(input));
        const names: string[] = [];
        for (const obj of decodeAll(bundle)) {
          for (const msg of obj.messages) {
            if (msg.type !== TN_SHEET_ARCHIVE) continue;
            const nameBytes = getBytes(parseMessage(msg.payload), SHEET_NAME_FIELD);
            names.push(nameBytes === undefined ? `Sheet${names.length + 1}` : decodeUtf8(nameBytes));
          }
        }
        if (names.length === 0) names.push("Sheet1");
        const sheets = names.map(
          (name) => new Worksheet({ name, columns: [], rows: [], merges: [] })
        );
        return trustAs<NumbersFeature>(document(sheets));
      },
      catch: (cause) =>
        new ParseError({ format: "numbers", reason: `Failed to read numbers: ${String(cause)}`, cause }),
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
