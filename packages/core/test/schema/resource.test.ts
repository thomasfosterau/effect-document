import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  contentId,
  decodeDocumentResult,
  document,
  Document,
  emuExtent,
  EMU_PER_INCH,
  encodeDocumentResult,
  Image,
  imageInfo,
  para,
  Resource,
  resourceIdOf,
  resourceOf,
  resourceUrl,
  str,
  withResource,
} from "../../src/schema/index.ts";
import { collectFeatures, narrow, Profiles } from "../../src/profile/index.ts";

const PIXEL = new Resource({ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) });

/** A document with one image referring to `PIXEL` in its media bag. */
const withPixel = (): Document => {
  const added = withResource(document([]), PIXEL);
  return document(
    [para([new Image({ alt: [str("dot")], target: { url: added.url } })])],
    {},
    added.document.resources,
  );
};

describe("media bag (#113)", () => {
  test("resource: URLs name the bag's ids; other URLs name none", () => {
    expect(resourceIdOf(resourceUrl("abc"))).toEqual(Option.some("abc"));
    expect(Option.isNone(resourceIdOf("https://example.com/a.png"))).toBe(true);
    expect(Option.isNone(resourceIdOf("resource:"))).toBe(true);
  });

  test("a document without resources has no resources key", () => {
    expect(Object.hasOwn(document([]), "resources")).toBe(false);
    expect(Object.hasOwn(document([], {}, {}), "resources")).toBe(false);
  });

  test("adding the same content twice stores it once", () => {
    const first = withResource(document([]), PIXEL);
    const again = withResource(
      first.document,
      new Resource({ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]), filename: "b.png" }),
    );
    expect(again.url).toBe(first.url);
    expect(Rec.keys(again.document.resources ?? {})).toHaveLength(1);
    const other = withResource(
      again.document,
      new Resource({ mediaType: "image/png", bytes: new Uint8Array([9]) }),
    );
    expect(other.url).not.toBe(first.url);
    expect(Rec.keys(other.document.resources ?? {})).toHaveLength(2);
  });

  test("a hash collision is resolved by comparing bytes", () => {
    const id = contentId(PIXEL.bytes);
    const impostor = new Resource({ mediaType: "image/png", bytes: new Uint8Array([7, 7, 7]) });
    const doc = document([], {}, { [id]: impostor });
    const added = withResource(doc, PIXEL);
    expect(added.url).toBe(resourceUrl(`${id}-1`));
    assert(Option.isSome(resourceOf(added.document, added.url)));
  });

  test("resourceOf finds the resource an image refers to", () => {
    const doc = withPixel();
    const [block] = doc.blocks;
    assert(block !== undefined && Predicate.isTagged(block, "Para"));
    const [img] = block.content;
    assert(img !== undefined && Predicate.isTagged(img, "Image"));
    expect(Option.map(resourceOf(doc, img.target.url), (r) => [...r.bytes])).toEqual(
      Option.some([1, 2, 3]),
    );
  });

  test("encodes its bytes as base64, through Schema and the stack-safe codec alike", () => {
    const doc = withPixel();
    const json = Schema.encodeSync(Document)(doc);
    const [entry] = Rec.values(json.resources ?? {});
    expect(entry).toEqual({ mediaType: "image/png", bytes: "AQID" });
    const ours = encodeDocumentResult(doc);
    assert(Result.isSuccess(ours));
    expect(ours.success).toEqual(json);
    const back = decodeDocumentResult(json);
    assert(Result.isSuccess(back));
    expect(back.success).toEqual(doc);
  });

  test("a document with resources uses doc.resources", () => {
    expect(collectFeatures(withPixel()).has("doc.resources")).toBe(true);
    expect(collectFeatures(document([])).has("doc.resources")).toBe(false);
    expect(Profiles.Full.is(withPixel())).toBe(true);
    expect(Profiles.Markdown.is(withPixel())).toBe(false);
  });

  test("narrowing to a profile without resources drops each one, reported at its id", () => {
    const doc = withPixel();
    const id = Rec.keys(doc.resources ?? {})[0];
    const { document: out, loss } = narrow(doc, Profiles.Markdown);
    expect(out.resources).toBeUndefined();
    expect(loss.entries).toEqual([
      expect.objectContaining({
        feature: "doc.resources",
        action: "dropped",
        severity: "dropped-content",
        path: ["resources", id],
      }),
    ]);
    const kept = narrow(doc, Profiles.Html);
    expect(kept.document.resources).toEqual(doc.resources);
    expect(kept.loss.isLossless).toBe(true);
  });
});

const bytesOf = (s: string) => new TextEncoder().encode(s);

/** Bytes from space-separated hex pairs. */
const hexBytes = (hex: string): ReadonlyArray<number> =>
  hex.split(" ").map((pair) => Number.parseInt(pair, 16));

/** `n` as four big-endian bytes. */
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** `n` as two big-endian bytes. */
const u16 = (n: number) => [(n >> 8) & 255, n & 255];

/** A PNG chunk of `type` holding `data`, with a zero CRC (the reader doesn't check it). */
const chunk = (type: string, data: ReadonlyArray<number>) => [
  ...u32(data.length),
  ...bytesOf(type),
  ...data,
  ...u32(0),
];

/** A PNG header: signature, IHDR of `w` × `h`, then a pHYs chunk at `ppm` pixels per metre. */
const pngHeader = (w: number, h: number, ppm?: number): Uint8Array =>
  new Uint8Array([
    ...hexBytes("89 50 4e 47 0d 0a 1a 0a"),
    ...chunk("IHDR", [...u32(w), ...u32(h), 8, 6, 0, 0, 0]),
    ...(ppm === undefined ? [] : chunk("pHYs", [...u32(ppm), ...u32(ppm), 1])),
    ...chunk("IDAT", []),
  ]);

/** A JPEG header: SOI, a JFIF APP0 at `dpi`, a DQT to skip, then SOF0 of `w` × `h`. */
const jpegHeader = (w: number, h: number, dpi: number): Uint8Array =>
  new Uint8Array([
    ...hexBytes("ff d8 ff e0 00 10"),
    ...bytesOf("JFIF\u0000"),
    ...hexBytes("01 01 01"),
    ...u16(dpi),
    ...u16(dpi),
    ...hexBytes("00 00 ff db 00 04 00 00 ff c0 00 0b 08"),
    ...u16(h),
    ...u16(w),
    ...hexBytes("01 01 11 00"),
  ]);

/** An SVG's size as `[width, height]`. */
const svgSize = (svg: string) => Option.map(imageInfo(bytesOf(svg)), (i) => [i.width, i.height]);

/** The EMU extent of a 96 × 192 PNG at `dpi`. */
const extentAt = (dpi: Option.Option<{ x: number; y: number }>) =>
  emuExtent({ mediaType: "image/png", width: 96, height: 192, dpi });

describe("imageInfo (#113)", () => {
  test("reads a PNG's size and its pHYs resolution", () => {
    expect(imageInfo(pngHeader(640, 480, 11811))).toEqual(
      Option.some({
        mediaType: "image/png",
        width: 640,
        height: 480,
        dpi: Option.some({ x: 300, y: 300 }),
      }),
    );
    expect(Option.map(imageInfo(pngHeader(2, 3)), (i) => i.dpi)).toEqual(
      Option.some(Option.none()),
    );
  });

  test("reads a JPEG's frame size past other segments, and its JFIF density", () => {
    expect(imageInfo(jpegHeader(1024, 768, 72))).toEqual(
      Option.some({
        mediaType: "image/jpeg",
        width: 1024,
        height: 768,
        dpi: Option.some({ x: 72, y: 72 }),
      }),
    );
  });

  test("reads a GIF's logical screen size", () => {
    const gif = new Uint8Array([...bytesOf("GIF89a"), 10, 1, 20, 0, 0, 0, 0]);
    expect(Option.map(imageInfo(gif), (i) => [i.mediaType, i.width, i.height])).toEqual(
      Option.some(["image/gif", 266, 20]),
    );
  });

  test("reads an SVG's width and height in CSS pixels, or its viewBox", () => {
    expect(
      svgSize(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2in" height="72pt">',
      ),
    ).toEqual(Option.some([192, 96]));
    expect(svgSize('<svg viewBox="0 0 300 150" width="100%">')).toEqual(Option.some([300, 150]));
    expect(svgSize("<svg>")).toEqual(Option.none());
  });

  test("says nothing of content it doesn't know or can't size", () => {
    expect(Option.isNone(imageInfo(new Uint8Array([0, 1, 2])))).toBe(true);
    expect(Option.isNone(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])))).toBe(true);
    expect(Option.isNone(imageInfo(pngHeader(0, 5)))).toBe(true);
  });

  test("an image's EMU extent is its pixels at its resolution, 96 dpi by default", () => {
    expect(extentAt(Option.none())).toEqual({ cx: EMU_PER_INCH, cy: 2 * EMU_PER_INCH });
    expect(extentAt(Option.some({ x: 192, y: 192 }))).toEqual({
      cx: EMU_PER_INCH / 2,
      cy: EMU_PER_INCH,
    });
  });
});
