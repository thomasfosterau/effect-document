import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vite-plus/test";
import { bytes, text } from "@thomasfosterau/effect-document";
import {
  decodeText,
  detectEncoding,
  ENCODING_NAMES,
  ENCODING_SAMPLE_BYTES,
} from "@thomasfosterau/effect-document/encoding";
import * as Csv from "@thomasfosterau/effect-document/csv";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf16le = (s: string): Uint8Array =>
  Uint8Array.from(Array.from(s).flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8]));
const utf16be = (s: string): Uint8Array =>
  Uint8Array.from(Array.from(s).flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]));
/** "café,naïve\n" in Windows-1252: é and ï are single bytes no UTF-8 sequence starts with. */
const CP1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);

describe("detectEncoding (#188 §2)", () => {
  it.effect.each([
    ["UTF-8", [0xef, 0xbb, 0xbf]],
    ["UTF-16LE", [0xff, 0xfe]],
    ["UTF-16BE", [0xfe, 0xff]],
  ] as const)("a %s byte-order mark settles it", ([encoding, bom]) =>
    Effect.gen(function* () {
      const found = yield* detectEncoding(bytes(Uint8Array.from([...bom, 0x61, 0x00])));
      expect(found).toMatchObject({ encoding, confidence: 1, bom: true });
    }),
  );

  it.effect("valid UTF-8 with non-ASCII text, and ASCII only", () =>
    Effect.gen(function* () {
      expect(yield* detectEncoding(bytes(utf8("café,naïve\n")))).toMatchObject({
        encoding: "UTF-8",
        confidence: 0.95,
        bom: false,
      });
      expect(yield* detectEncoding(bytes(utf8("a,b\n1,2\n")))).toMatchObject({
        encoding: "UTF-8",
        confidence: 0.9,
      });
    }),
  );

  it.effect("bytes that are not UTF-8 are Windows-1252, with the offset that ruled UTF-8 out", () =>
    Effect.gen(function* () {
      const found = yield* detectEncoding(bytes(CP1252));
      expect(found.encoding).toBe("windows-1252");
      expect(found.confidence).toBe(0.5);
      // the sequence é (0xE9) starts is broken by the next byte, so that's the offset reported
      expect(found.evidence).toContain("at byte 4");
    }),
  );

  it.effect("UTF-16 without a byte-order mark, by its zero bytes", () =>
    Effect.gen(function* () {
      const sample = "name,value\nalpha,1\nbeta,2\n";
      expect((yield* detectEncoding(bytes(utf16le(sample)))).encoding).toBe("UTF-16LE");
      expect((yield* detectEncoding(bytes(utf16be(sample)))).encoding).toBe("UTF-16BE");
    }),
  );

  it.effect("a character the sample's end splits is not taken for invalid UTF-8", () =>
    Effect.gen(function* () {
      // "é" (two bytes) straddles the 64 KiB boundary
      const data = utf8(`${"a".repeat(ENCODING_SAMPLE_BYTES - 1)}é${"b".repeat(10)}`);
      expect((yield* detectEncoding(bytes(data))).encoding).toBe("UTF-8");
    }),
  );

  it.effect("only the sample is looked at", () =>
    Effect.gen(function* () {
      const data = Uint8Array.from([...utf8("a".repeat(ENCODING_SAMPLE_BYTES)), 0xe9]);
      expect((yield* detectEncoding(bytes(data))).encoding).toBe("UTF-8");
    }),
  );

  it.effect("text content is already decoded", () =>
    Effect.gen(function* () {
      expect(yield* detectEncoding(text("x"))).toMatchObject({
        encoding: "UTF-8",
        confidence: 1,
      });
    }),
  );
});

describe("decodeText (#188 §2)", () => {
  it.effect("decodes with the detected encoding, a byte-order mark stripped", () =>
    Effect.gen(function* () {
      expect((yield* decodeText(bytes(CP1252))).text).toBe("café,naïve\n");
      const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("é")]);
      expect((yield* decodeText(bytes(withBom))).text).toBe("é");
      expect((yield* decodeText(bytes(Uint8Array.from([0xff, 0xfe, ...utf16le("hi")])))).text).toBe(
        "hi",
      );
    }),
  );

  it.effect("decodes with the encoding the caller picks", () =>
    Effect.gen(function* () {
      // the same bytes read as ISO-8859-15 and as Windows-1252 differ only where those encodings do
      const euro = Uint8Array.from([0xa4]);
      expect((yield* decodeText(bytes(euro), { encoding: "ISO-8859-15" })).text).toBe("€");
      expect((yield* decodeText(bytes(euro), { encoding: "windows-1252" })).text).toBe("¤");
    }),
  );

  it.effect(
    "is strict: bytes the encoding doesn't define fail with MalformedText at their offset",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(decodeText(bytes(CP1252), { encoding: "UTF-8" }));
        expect(error).toMatchObject({
          format: "text",
          code: "MalformedText",
          position: { offset: 4 },
        });
      }),
  );

  it.effect("a CJK encoding decodes where the platform's TextDecoder has it", () =>
    Effect.gen(function* () {
      // "日本" in Shift_JIS
      const sjis = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b]);
      expect((yield* decodeText(bytes(sjis), { encoding: "Shift_JIS" })).text).toBe("日本");
    }),
  );

  it.effect("text content is returned as it is, and the result reads as CSV", () =>
    Effect.gen(function* () {
      const input = text("a,b\n");
      expect(yield* decodeText(input)).toBe(input);
      const doc = yield* Effect.flatMap(decodeText(bytes(CP1252)), Csv.makeCsvReader().read);
      expect(doc.blocks).toHaveLength(1);
    }),
  );

  test("names effect-ext's encodings", () => {
    expect(ENCODING_NAMES).toContain("windows-1252");
    expect(ENCODING_NAMES).toContain("UTF-16LE");
  });
});
