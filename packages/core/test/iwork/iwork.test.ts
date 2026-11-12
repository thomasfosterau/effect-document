import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { zipSync } from "fflate";
import { blocksToText, bytes } from "@thomasfosterau/effect-document";
import { compressBlock, decompressBlock } from "../../src/iwork/snappy.ts";
import { chunk, dechunk } from "../../src/iwork/iwa.ts";
import { parseMessage, readVarint } from "../../src/iwork/protobuf.ts";
import { openBundle } from "../../src/iwork/bundle.ts";
import * as Keynote from "../../src/iwork/keynote.ts";
import * as Numbers from "../../src/iwork/numbers.ts";
import { fixture } from "./fixture.ts";

layer(NodeServices.layer)((it) => {
  describe("Snappy block codec", () => {
    test("literals-only compress then decompress is identity", () => {
      const data = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
      const round = decompressBlock(compressBlock(data));
      expect(round).toEqual(data);
    });

    it.effect("decompresses a real Apple IWA's first block to 64 KiB (multi-chunk)", () =>
      Effect.gen(function* () {
        // the multi-chunk fixture's first block is a full 64 KiB uncompressed slice
        const stream = dechunk(yield* fixture("multi-chunk.iwa"));
        expect(stream.length).toBeGreaterThan(65536);
      }),
    );
  });

  describe("IWA framing", () => {
    it.effect("dechunks a real Apple .iwa file", () =>
      Effect.gen(function* () {
        const stream = dechunk(yield* fixture("simple-oneslide.iwa"));
        expect(stream.length).toBeGreaterThan(0);
      }),
    );

    it.effect("chunk(dechunk(x)) round-trips byte-for-byte", () =>
      Effect.gen(function* () {
        const stream = dechunk(yield* fixture("simple-oneslide.iwa"));
        expect(dechunk(chunk(stream))).toEqual(stream);
      }),
    );

    test("rejects a bad chunk type or a truncated chunk at its offset", () => {
      expect(() => dechunk(new Uint8Array([0x01, 0, 0, 0]))).toThrow(
        /offset 0[\s\S]*chunk type 0x00/,
      );
      expect(() => dechunk(new Uint8Array([0x00, 5, 0, 0, 1]))).toThrow(/offset 4[\s\S]*IWA chunk/);
    });
  });

  describe("Protobuf wire reader", () => {
    test("parses varint and length-delimited fields", () => {
      // field 1 = varint 5 ; field 2 = "hi"
      const fields = parseMessage(new Uint8Array([0x08, 0x05, 0x12, 0x02, 0x68, 0x69]));
      expect(fields[0]).toMatchObject({ field: 1, wire: 0, value: 5 });
      expect(fields[1]).toMatchObject({ field: 2, wire: 2 });
      expect(new TextDecoder().decode(fields[1]!.bytes)).toBe("hi");
    });

    test("parses fixed 32- and 64-bit fields", () => {
      // field 1 = fixed64 2^32 + 1 ; field 2 = fixed32 258
      const fields = parseMessage(new Uint8Array([0x09, 1, 0, 0, 0, 1, 0, 0, 0, 0x15, 2, 1, 0, 0]));
      expect(fields).toEqual([
        { field: 1, wire: 1, value: 2 ** 32 + 1, raw: new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0]) },
        { field: 2, wire: 5, value: 258, raw: new Uint8Array([2, 1, 0, 0]) },
      ]);
    });

    test("reads multi-byte varints at an offset", () => {
      expect(readVarint(new Uint8Array([0xff, 0xac, 0x02]), 1)).toEqual({ value: 300, pos: 3 });
      expect(() => readVarint(new Uint8Array(11).fill(0xff), 0)).toThrow(/longer than 10 bytes/);
    });

    test("truncated fields and unknown wire types fail with their offset", () => {
      expect(() => parseMessage(new Uint8Array([0x08, 0x01, 0x12, 0x05, 0x68]))).toThrow(
        /offset 4[\s\S]*needs 5 bytes, only 1 left/,
      );
      expect(() => parseMessage(new Uint8Array([0x09, 1, 2, 3]))).toThrow(
        /needs 8 bytes, only 3 left/,
      );
      expect(() => parseMessage(new Uint8Array([0x08, 0x80]))).toThrow(/varint/);
      expect(() => parseMessage(new Uint8Array([0x08, 0x01, 0x0b]))).toThrow(
        /offset 2[\s\S]*unsupported wire type 3 \(field 1\)/,
      );
    });
  });

  describe("Keynote reader (real .key fixture)", () => {
    it.effect("extracts slide text into a conforming presentation document", () =>
      Effect.gen(function* () {
        const doc = yield* Keynote.makeKeynoteReader().read(
          bytes(yield* fixture("simple-oneslide.key")),
        );
        expect(Keynote.Keynote.is(doc)).toBe(true);
        const ss = doc.blocks.find((b) => Predicate.isTagged(b, "SlideShow"));
        assert(ss !== undefined && Predicate.isTagged(ss, "SlideShow"));
        expect(ss.slides).toHaveLength(1);
        const text = blocksToText(doc.blocks);
        expect(text).toContain("Example Presentation");
        expect(text).toContain("This is a subtitle.");
        // the inline-image placeholder (U+FFFC) is stripped
        expect(text).not.toContain("￼");
      }),
    );
  });

  describe("Numbers reader (real .numbers fixture, structure only)", () => {
    it.effect("reads the sheet names into (empty) worksheets", () =>
      Effect.gen(function* () {
        const doc = yield* Numbers.makeNumbersReader().read(
          bytes(yield* fixture("test-1.numbers")),
        );
        expect(Numbers.Numbers.is(doc)).toBe(true);
        const names = doc.blocks.flatMap((b) =>
          Predicate.isTagged(b, "Worksheet") ? [b.name] : [],
        );
        expect(names).toEqual(["ZZZ_Sheet_1", "ZZZ_Sheet_2"]);
      }),
    );
  });

  describe("encrypted documents", () => {
    test("are refused with a clear error", () => {
      // a zip containing a top-level .iwph (password-hint) marker
      const zip = zipSync({ ".iwph": new Uint8Array([1]), "Index/Document.iwa": new Uint8Array() });
      const result = openBundle(zip);
      expect(Result.isFailure(result) && result.failure.reason).toBe("Encrypted");
      expect(Result.isFailure(result) && result.failure.message).toMatch(/encrypted/);
    });
  });
});
