/**
 * Every reader classifies its failures with the same `ParseError` codes
 * (#127), so a caller can branch on `code` instead of the message, and a
 * failure's `position` says where it happened when the reader knows.
 */

import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { strToU8, zipSync } from "fflate";
import {
  bytes,
  type Content,
  type Document,
  type ParseError,
  type ParseErrorCode,
  type WriteError,
  document,
  para,
  str,
  text,
  trustAs,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import * as Rtf from "@thomasfosterau/effect-document/rtf";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import { Keynote } from "@thomasfosterau/effect-document/iwork";
import { makeDocxReader, makeDocxWriter } from "@thomasfosterau/effect-document/ooxml/docx";
import { makePptxReader } from "@thomasfosterau/effect-document/ooxml/pptx";
import { makeXlsxReader } from "@thomasfosterau/effect-document/ooxml/xlsx";

/** A reader's failure for `input`. */
const failure = (
  reader: { readonly read: (c: Content) => Effect.Effect<Document, ParseError> },
  input: Content,
) => Effect.flip(reader.read(input));

const NOT_A_ZIP = bytes(strToU8("plainly not a zip archive"));
const RELS = (target: string) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="x/officeDocument" Target="${target}"/></Relationships>`;
/** A real DOCX package, as the writer makes it. */
const DOCX = makeDocxWriter().write(trustAs(document([para([str("hi")])])));

/** A reader's failure for the package `input` writes. */
const failureOf = <E>(
  reader: { readonly read: (c: Content) => Effect.Effect<Document, ParseError> },
  input: Effect.Effect<Content, E>,
) => Effect.flatMap(input, (content) => failure(reader, content));

/** A minimal PDF with an `/Encrypt` entry in its trailer. */
const ENCRYPTED_PDF = (() => {
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj",
    "trailer << /Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 >> >>",
    "%%EOF",
  ].join("\n");
  return bytes(strToU8(body));
})();

/** The first bytes of a Compound File Binary container, as an encrypted Office package has. */
const CFB = bytes(
  new Uint8Array([
    0xd0,
    0xcf,
    0x11,
    0xe0,
    0xa1,
    0xb1,
    0x1a,
    0xe1,
    ...Array.from({ length: 504 }, () => 0),
  ]),
);

/** The DOCX with its end-of-central-directory record cut off (22 bytes, no comment). */
const TRUNCATED = Effect.map(DOCX, (docx) =>
  Predicate.isTagged(docx, "Bytes") ? bytes(docx.bytes.subarray(0, docx.bytes.length - 22)) : docx,
);

const CASES: ReadonlyArray<
  readonly [string, () => Effect.Effect<ParseError, Document | WriteError>, ParseErrorCode]
> = [
  [
    "OOXML: bytes that aren't a zip",
    () => failure(makeDocxReader(), NOT_A_ZIP),
    "InvalidContainer",
  ],
  [
    "OOXML: an encrypted package (a CFB container)",
    () => failure(makeXlsxReader(), CFB),
    "Encrypted",
  ],
  [
    "OOXML: a zip without its central directory",
    () => failureOf(makeDocxReader(), TRUNCATED),
    "InvalidContainer",
  ],
  ["OOXML: a DOCX read as PPTX", () => failureOf(makePptxReader(), DOCX), "WrongFormat"],
  ["OOXML: a DOCX read as XLSX", () => failureOf(makeXlsxReader(), DOCX), "WrongFormat"],
  [
    "OOXML: a package without its main part",
    () =>
      failure(
        makeDocxReader(),
        bytes(zipSync({ "_rels/.rels": strToU8(RELS("word/document.xml")) })),
      ),
    "MissingPart",
  ],
  [
    "OOXML: a part over the entry-size limit",
    () => failureOf(makeDocxReader({ limits: { maxEntrySize: 10 } }), DOCX),
    "LimitExceeded",
  ],
  [
    "CSV: an unclosed quote",
    () => failure(Csv.makeCsvReader(), text('a,"b\n1,2')),
    "MalformedText",
  ],
  ["RTF: text that isn't RTF", () => failure(Rtf.makeRtfReader(), text("hello")), "WrongFormat"],
  [
    "RTF: a \\u parameter out of range",
    () => failure(Rtf.makeRtfReader(), text("{\\rtf1 \\u99999999 x}")),
    "MalformedText",
  ],
  ["PDF: an encrypted file", () => failure(Pdf.makePdfReader(), ENCRYPTED_PDF), "Encrypted"],
  [
    "iWork: bytes that aren't a zip",
    () => failure(Keynote.makeKeynoteReader(), NOT_A_ZIP),
    "InvalidContainer",
  ],
  [
    "iWork: a DOCX read as Keynote",
    () => failureOf(Keynote.makeKeynoteReader(), DOCX),
    "WrongFormat",
  ],
];

describe("ParseError codes (#127)", () => {
  it.effect.each(CASES)("%s", ([, fail, code]) =>
    Effect.gen(function* () {
      const error = yield* fail();
      expect(error._tag).toBe("ParseError");
      expect(error.code).toBe(code);
    }),
  );

  it.effect("an XLSX over its cell limit names the sheet", () =>
    Effect.gen(function* () {
      const sheet = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData></worksheet>`;
      const xlsx = bytes(
        zipSync({
          "_rels/.rels": strToU8(RELS("xl/workbook.xml")),
          "[Content_Types].xml": strToU8(
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
          ),
          "xl/workbook.xml": strToU8(
            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Big" sheetId="1" r:id="s1"/></sheets></workbook>`,
          ),
          "xl/_rels/workbook.xml.rels": strToU8(
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
          ),
          "xl/worksheets/sheet1.xml": strToU8(sheet),
        }),
      );
      const error = yield* failure(makeXlsxReader({ maxCells: 1 }), xlsx);
      expect(error.code).toBe("LimitExceeded");
      expect(error.position?.sheet).toBe("Big");
    }),
  );

  it.effect("a CSV syntax error keeps its row and column", () =>
    Effect.gen(function* () {
      const error = yield* failure(Csv.makeCsvReader(), text('a,b\n1,"2'));
      expect(error.code).toBe("MalformedText");
      // CSV rows count from 0: the quote opens on the second row
      expect(error.position?.row).toBe(1);
    }),
  );
});

describe("OOXML container failures say what they are (#173)", () => {
  it.effect("an encrypted package or legacy binary file is named as such", () =>
    Effect.gen(function* () {
      expect((yield* failure(makeDocxReader(), CFB)).reason).toMatch(
        /Compound File Binary.*encrypted/,
      );
    }),
  );
  it.effect("a truncated zip says its central directory is missing", () =>
    Effect.gen(function* () {
      expect((yield* failureOf(makeDocxReader(), TRUNCATED)).reason).toMatch(
        /without its central directory/,
      );
    }),
  );
});
