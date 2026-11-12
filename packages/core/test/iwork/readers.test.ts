import { it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { zipSync } from "fflate";
import { blocksToText, bytes, type ParseError } from "@thomasfosterau/effect-document";
import { ComponentPathOrder, openBundle } from "../../src/iwork/bundle.ts";
import { isIworkError } from "../../src/iwork/errors.ts";
import { chunk } from "../../src/iwork/iwa.ts";
import * as Keynote from "../../src/iwork/keynote.ts";
import * as Numbers from "../../src/iwork/numbers.ts";
import * as Pages from "../../src/iwork/pages.ts";
import { lenField, record, varintField } from "./encode.ts";

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** A one-object `.iwa` holding a `TSWP.StorageArchive` (type 2001) with this text. */
const storageIwa = (id: number, text: string): Uint8Array =>
  chunk(new Uint8Array(record(id, [{ type: 2001, payload: lenField(3, utf8(text)) }])));

/** The reason of the `IworkError` behind a reader's failure. */
const failureReason = (read: Effect.Effect<unknown, ParseError>) =>
  Effect.gen(function* () {
    const r = yield* Effect.result(read);
    return Result.isFailure(r) && isIworkError(r.failure.cause)
      ? r.failure.cause.reason
      : undefined;
  });

const readers = [
  ["keynote", Keynote.makeKeynoteReader()],
  ["pages", Pages.makePagesReader()],
  ["numbers", Numbers.makeNumbersReader()],
] as const;

describe("non-iWork input fails with a typed reason", () => {
  const docx = zipSync({
    "[Content_Types].xml": new Uint8Array(utf8("<Types/>")),
    "word/document.xml": new Uint8Array(utf8("<w:document/>")),
  });

  it.effect.each(readers)("a .docx read as %s is NotIwork", ([, reader]) =>
    Effect.gen(function* () {
      expect(yield* failureReason(reader.read(bytes(docx)))).toBe("NotIwork");
    }),
  );

  it.effect("iWork '09 XML packages are LegacyIwork09Unsupported", () =>
    Effect.gen(function* () {
      const key09 = zipSync({ "index.apxl.gz": new Uint8Array([0x1f, 0x8b]) });
      const pages09 = zipSync({ "index.xml": new Uint8Array(utf8("<sl:document/>")) });
      expect(yield* failureReason(Keynote.makeKeynoteReader().read(bytes(key09)))).toBe(
        "LegacyIwork09Unsupported",
      );
      expect(yield* failureReason(Pages.makePagesReader().read(bytes(pages09)))).toBe(
        "LegacyIwork09Unsupported",
      );
      expect(yield* failureReason(Numbers.makeNumbersReader().read(bytes(pages09)))).toBe(
        "LegacyIwork09Unsupported",
      );
    }),
  );

  test("the codec reports it too", () => {
    const r = openBundle(zipSync({ "Index.xml.gz": new Uint8Array([1]) }));
    expect(Result.isFailure(r) && r.failure.message).toMatch(/iWork '09/);
  });
});

describe("Keynote slide components", () => {
  it.effect("sort numerically, and suffixed components are slides too", () =>
    Effect.gen(function* () {
      const deck = zipSync({
        "Index/Document.iwa": chunk(new Uint8Array(record(1, []))),
        "Index/Slide-10000.iwa": storageIwa(10000, "third"),
        "Index/Slide-8060-2.iwa": storageIwa(8061, "second"),
        "Index/Slide-8060.iwa": storageIwa(8060, "first"),
        "Index/MasterSlide-7880.iwa": storageIwa(7880, "Title Text"),
      });
      const doc = yield* Keynote.makeKeynoteReader().read(bytes(deck));
      const show = doc.blocks[0];
      assert(show !== undefined && Predicate.isTagged(show, "SlideShow"));
      expect(
        show.slides.map((slide) =>
          blocksToText(
            slide.shapes.flatMap((s) => (Predicate.isTagged(s, "TextBox") ? s.content : [])),
          ),
        ),
      ).toEqual(["first", "second", "third"]);
    }),
  );

  test("ComponentPathOrder compares digit runs as numbers", () => {
    const paths = [
      "Index/Slide-10000.iwa",
      "Index/Slide-8060-2.iwa",
      "Index/Slide-9.iwa",
      "Index/Slide-8060.iwa",
    ];
    expect(Arr.sort(paths, ComponentPathOrder)).toEqual([
      "Index/Slide-9.iwa",
      "Index/Slide-8060.iwa",
      "Index/Slide-8060-2.iwa",
      "Index/Slide-10000.iwa",
    ]);
  });
});

/** A `TN.SheetArchive` object named `name`. */
const sheetObject = (id: number, name: string) => ({
  id,
  type: 2,
  payload: lenField(1, utf8(name)),
});

describe("Numbers sheet order", () => {
  it.effect("follows TN.DocumentArchive.sheets, not component order", () =>
    Effect.gen(function* () {
      // sheet 10 ("Second") is stored first; the document lists sheet 20 ("First") first
      const sheets = [
        sheetObject(10, "Second"),
        sheetObject(30, "Unlisted"),
        sheetObject(20, "First"),
      ];
      const documentArchive = [
        ...lenField(1, varintField(1, 20)),
        ...lenField(1, varintField(1, 10)),
      ];
      const stream = [
        ...sheets.flatMap((s) => record(s.id, [s])),
        ...record(1, [{ type: 1, payload: documentArchive }]),
      ];
      const workbook = zipSync({ "Index/Document.iwa": chunk(new Uint8Array(stream)) });
      const doc = yield* Numbers.makeNumbersReader().read(bytes(workbook));
      expect(
        doc.blocks.map((b) => (Predicate.isTagged(b, "Worksheet") ? b.name : undefined)),
      ).toEqual(["First", "Second", "Unlisted"]);
    }),
  );
});
