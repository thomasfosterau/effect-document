import { describe, expect, test } from "vite-plus/test";
import { Effect, Result } from "effect";
import { zipSync } from "fflate";
import {
  blocksToText,
  bytes,
  type ParseError,
  type SlideShow,
} from "@thomasfosterau/effect-document";
import { compareComponentPaths, openBundle } from "../src/bundle.ts";
import type { IworkError } from "../src/errors.ts";
import { chunk } from "../src/iwa.ts";
import * as Keynote from "../src/keynote.ts";
import * as Numbers from "../src/numbers.ts";
import * as Pages from "../src/pages.ts";
import { lenField, record, varintField } from "./encode.ts";

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** A one-object `.iwa` holding a `TSWP.StorageArchive` (type 2001) with this text. */
const storageIwa = (id: number, text: string): Uint8Array =>
  chunk(new Uint8Array(record(id, [{ type: 2001, payload: lenField(3, utf8(text)) }])));

/** The reason of the `IworkError` behind a reader's failure. */
const failureReason = (read: Effect.Effect<unknown, ParseError>): string | undefined => {
  const r = Effect.runSync(Effect.result(read));
  return Result.isFailure(r) ? (r.failure.cause as IworkError).reason : undefined;
};

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

  for (const [name, reader] of readers) {
    test(`a .docx read as ${name} is NotIwork`, () => {
      expect(failureReason(reader.read(bytes(docx)))).toBe("NotIwork");
    });
  }

  test("iWork '09 XML packages are LegacyIwork09Unsupported", () => {
    const key09 = zipSync({ "index.apxl.gz": new Uint8Array([0x1f, 0x8b]) });
    const pages09 = zipSync({ "index.xml": new Uint8Array(utf8("<sl:document/>")) });
    expect(failureReason(Keynote.makeKeynoteReader().read(bytes(key09)))).toBe(
      "LegacyIwork09Unsupported",
    );
    expect(failureReason(Pages.makePagesReader().read(bytes(pages09)))).toBe(
      "LegacyIwork09Unsupported",
    );
    expect(failureReason(Numbers.makeNumbersReader().read(bytes(pages09)))).toBe(
      "LegacyIwork09Unsupported",
    );
  });

  test("the codec reports it too", () => {
    const r = openBundle(zipSync({ "Index.xml.gz": new Uint8Array([1]) }));
    expect(Result.isFailure(r) && r.failure.message).toMatch(/iWork '09/);
  });
});

describe("Keynote slide components", () => {
  test("sort numerically, and suffixed components are slides too", () => {
    const deck = zipSync({
      "Index/Document.iwa": chunk(new Uint8Array(record(1, []))),
      "Index/Slide-10000.iwa": storageIwa(10000, "third"),
      "Index/Slide-8060-2.iwa": storageIwa(8061, "second"),
      "Index/Slide-8060.iwa": storageIwa(8060, "first"),
      "Index/MasterSlide-7880.iwa": storageIwa(7880, "Title Text"),
    });
    const doc = Effect.runSync(Keynote.makeKeynoteReader().read(bytes(deck)));
    const show = doc.blocks[0] as SlideShow;
    expect(
      show.slides.map((slide) =>
        blocksToText(slide.shapes.flatMap((s) => (s._tag === "TextBox" ? s.content : []))),
      ),
    ).toEqual(["first", "second", "third"]);
  });

  test("compareComponentPaths compares digit runs as numbers", () => {
    const paths = [
      "Index/Slide-10000.iwa",
      "Index/Slide-8060-2.iwa",
      "Index/Slide-9.iwa",
      "Index/Slide-8060.iwa",
    ];
    expect(paths.sort(compareComponentPaths)).toEqual([
      "Index/Slide-9.iwa",
      "Index/Slide-8060.iwa",
      "Index/Slide-8060-2.iwa",
      "Index/Slide-10000.iwa",
    ]);
  });
});

describe("Numbers sheet order", () => {
  test("follows TN.DocumentArchive.sheets, not component order", () => {
    // sheet 10 ("Second") is stored first; the document lists sheet 20 ("First") first
    const sheet = (id: number, name: string) => ({ id, type: 2, payload: lenField(1, utf8(name)) });
    const sheets = [sheet(10, "Second"), sheet(30, "Unlisted"), sheet(20, "First")];
    const documentArchive = [
      ...lenField(1, varintField(1, 20)),
      ...lenField(1, varintField(1, 10)),
    ];
    const stream = [
      ...sheets.flatMap((s) => record(s.id, [s])),
      ...record(1, [{ type: 1, payload: documentArchive }]),
    ];
    const workbook = zipSync({ "Index/Document.iwa": chunk(new Uint8Array(stream)) });
    const doc = Effect.runSync(Numbers.makeNumbersReader().read(bytes(workbook)));
    expect(doc.blocks.map((b) => (b as { name: string }).name)).toEqual([
      "First",
      "Second",
      "Unlisted",
    ]);
  });
});
