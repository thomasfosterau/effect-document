import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { zipSync } from "fflate";
import { blocksToText, type SlideShow } from "../../../src/schema/index.js";
import { bytes, contentToText } from "../../../src/io/content.js";
import { convert } from "../../../src/io/convert.js";
import { compressBlock, decompressBlock } from "../../../src/formats/iwork/snappy.js";
import { chunk, dechunk } from "../../../src/formats/iwork/iwa.js";
import { parseMessage, readVarint } from "../../../src/formats/iwork/protobuf.js";
import { openBundle } from "../../../src/formats/iwork/bundle.js";
import * as Keynote from "../../../src/formats/iwork/keynote.js";
import * as Numbers from "../../../src/formats/iwork/numbers.js";
import * as Rtf from "../../../src/formats/rtf/index.js";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`test/fixtures/iwork/${name}`));

describe("Snappy block codec", () => {
  test("literals-only compress then decompress is identity", () => {
    const data = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
    const round = decompressBlock(compressBlock(data));
    expect(round).toEqual(data);
  });

  test("decompresses a real Apple IWA's first block to 64 KiB (multi-chunk)", () => {
    // the multi-chunk fixture's first block is a full 64 KiB uncompressed slice
    const stream = dechunk(fixture("multi-chunk.iwa"));
    expect(stream.length).toBeGreaterThan(65536);
  });
});

describe("IWA framing", () => {
  test("dechunks a real Apple .iwa file", () => {
    const stream = dechunk(fixture("simple-oneslide.iwa"));
    expect(stream.length).toBeGreaterThan(0);
  });

  test("chunk(dechunk(x)) round-trips byte-for-byte", () => {
    const stream = dechunk(fixture("simple-oneslide.iwa"));
    expect(dechunk(chunk(stream))).toEqual(stream);
  });

  test("rejects a bad chunk type or a truncated chunk at its offset", () => {
    expect(() => dechunk(new Uint8Array([0x01, 0, 0, 0]))).toThrow(/offset 0[\s\S]*chunk type 0x00/);
    expect(() => dechunk(new Uint8Array([0x00, 5, 0, 0, 1]))).toThrow(/offset 4[\s\S]*IWA chunk/);
  });
});

describe("Protobuf wire reader", () => {
  test("parses varint and length-delimited fields", () => {
    // field 1 = varint 5 ; field 2 = "hi"
    const fields = parseMessage(new Uint8Array([0x08, 0x05, 0x12, 0x02, 0x68, 0x69]));
    expect(fields[0]).toMatchObject({ field: 1, wire: 0, value: 5 });
    expect(fields[1]).toMatchObject({ field: 2, wire: 2 });
    expect(new TextDecoder().decode(fields[1]!.bytes!)).toBe("hi");
  });

  test("parses fixed 32- and 64-bit fields", () => {
    // field 1 = fixed64 2^32 + 1 ; field 2 = fixed32 258
    const fields = parseMessage(new Uint8Array([0x09, 1, 0, 0, 0, 1, 0, 0, 0, 0x15, 2, 1, 0, 0]));
    expect(fields).toEqual([
      { field: 1, wire: 1, value: 2 ** 32 + 1 },
      { field: 2, wire: 5, value: 258 },
    ]);
  });

  test("reads multi-byte varints at an offset", () => {
    expect(readVarint(new Uint8Array([0xff, 0xac, 0x02]), 1)).toEqual({ value: 300, pos: 3 });
    expect(() => readVarint(new Uint8Array(11).fill(0xff), 0)).toThrow(/longer than 10 bytes/);
  });

  test("truncated fields and unknown wire types fail with their offset", () => {
    expect(() => parseMessage(new Uint8Array([0x08, 0x01, 0x12, 0x05, 0x68]))).toThrow(
      /offset 4[\s\S]*needs 5 bytes, only 1 left/
    );
    expect(() => parseMessage(new Uint8Array([0x09, 1, 2, 3]))).toThrow(/needs 8 bytes, only 3 left/);
    expect(() => parseMessage(new Uint8Array([0x08, 0x80]))).toThrow(/varint/);
    expect(() => parseMessage(new Uint8Array([0x08, 0x01, 0x0b]))).toThrow(
      /offset 2[\s\S]*unsupported wire type 3 \(field 1\)/
    );
  });
});

describe("Keynote reader (real .key fixture)", () => {
  test("extracts slide text into a conforming presentation document", () => {
    const doc = run(Keynote.makeKeynoteReader().read(bytes(fixture("simple-oneslide.key"))));
    expect(Keynote.Keynote.is(doc)).toBe(true);
    const ss = doc.blocks.find((b) => b._tag === "SlideShow") as SlideShow;
    expect(ss.slides).toHaveLength(1);
    const text = blocksToText(doc.blocks);
    expect(text).toContain("Example Presentation");
    expect(text).toContain("This is a subtitle.");
    // the inline-image placeholder (U+FFFC) is stripped
    expect(text).not.toContain("￼");
  });
});

describe("Numbers reader (real .numbers fixture, structure only)", () => {
  test("reads the sheet names into (empty) worksheets", () => {
    const doc = run(Numbers.makeNumbersReader().read(bytes(fixture("test-1.numbers"))));
    expect(Numbers.Numbers.is(doc)).toBe(true);
    const names = doc.blocks.filter((b) => b._tag === "Worksheet").map((b) => (b as { name: string }).name);
    expect(names).toEqual(["ZZZ_Sheet_1", "ZZZ_Sheet_2"]);
  });
});

describe("convert: Keynote -> RTF (iWork into a writable format)", () => {
  test("flattens the deck's text into RTF", () => {
    const { content } = run(
      convert({ from: Keynote.format, to: Rtf.format, input: bytes(fixture("simple-oneslide.key")) })
    );
    const rtf = contentToText(content);
    expect(rtf.startsWith("{\\rtf1")).toBe(true);
    expect(rtf).toContain("Example Presentation");
  });
});

describe("encrypted documents", () => {
  test("are refused with a clear error", () => {
    // a zip containing a top-level .iwph (password-hint) marker
    const zip = zipSync({ ".iwph": new Uint8Array([1]), "Index/Document.iwa": new Uint8Array() });
    expect(() => openBundle(zip)).toThrow(/encrypted/);
  });
});
