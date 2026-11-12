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

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf16le = (s: string): Uint8Array =>
  Uint8Array.from(Array.from(s).flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8]));
const utf16be = (s: string): Uint8Array =>
  Uint8Array.from(Array.from(s).flatMap((ch) => [ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 0xff]));
/** "café,naïve\n" in Windows-1252: é and ï are single bytes no UTF-8 sequence starts with. */
const CP1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);

describe("detectEncoding (#188 §2)", () => {
  test.each([
    ["UTF-8", [0xef, 0xbb, 0xbf]],
    ["UTF-16LE", [0xff, 0xfe]],
    ["UTF-16BE", [0xfe, 0xff]],
  ] as const)("a %s byte-order mark settles it", async (encoding, bom) => {
    const found = await run(detectEncoding(bytes(Uint8Array.from([...bom, 0x61, 0x00]))));
    expect(found).toMatchObject({ encoding, confidence: 1, bom: true });
  });

  test("valid UTF-8 with non-ASCII text, and ASCII only", async () => {
    expect(await run(detectEncoding(bytes(utf8("café,naïve\n"))))).toMatchObject({
      encoding: "UTF-8",
      confidence: 0.95,
      bom: false,
    });
    expect(await run(detectEncoding(bytes(utf8("a,b\n1,2\n"))))).toMatchObject({
      encoding: "UTF-8",
      confidence: 0.9,
    });
  });

  test("bytes that are not UTF-8 are Windows-1252, with the offset that ruled UTF-8 out", async () => {
    const found = await run(detectEncoding(bytes(CP1252)));
    expect(found.encoding).toBe("windows-1252");
    expect(found.confidence).toBe(0.5);
    // the sequence é (0xE9) starts is broken by the next byte, so that's the offset reported
    expect(found.evidence).toContain("at byte 4");
  });

  test("UTF-16 without a byte-order mark, by its zero bytes", async () => {
    const sample = "name,value\nalpha,1\nbeta,2\n";
    expect((await run(detectEncoding(bytes(utf16le(sample))))).encoding).toBe("UTF-16LE");
    expect((await run(detectEncoding(bytes(utf16be(sample))))).encoding).toBe("UTF-16BE");
  });

  test("a character the sample's end splits is not taken for invalid UTF-8", async () => {
    // "é" (two bytes) straddles the 64 KiB boundary
    const data = utf8(`${"a".repeat(ENCODING_SAMPLE_BYTES - 1)}é${"b".repeat(10)}`);
    expect((await run(detectEncoding(bytes(data)))).encoding).toBe("UTF-8");
  });

  test("only the sample is looked at", async () => {
    const data = Uint8Array.from([...utf8("a".repeat(ENCODING_SAMPLE_BYTES)), 0xe9]);
    expect((await run(detectEncoding(bytes(data)))).encoding).toBe("UTF-8");
  });

  test("text content is already decoded", async () => {
    expect(await run(detectEncoding(text("x")))).toMatchObject({
      encoding: "UTF-8",
      confidence: 1,
    });
  });
});

describe("decodeText (#188 §2)", () => {
  test("decodes with the detected encoding, a byte-order mark stripped", async () => {
    expect((await run(decodeText(bytes(CP1252)))).text).toBe("café,naïve\n");
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("é")]);
    expect((await run(decodeText(bytes(withBom)))).text).toBe("é");
    expect(
      (await run(decodeText(bytes(Uint8Array.from([0xff, 0xfe, ...utf16le("hi")]))))).text,
    ).toBe("hi");
  });

  test("decodes with the encoding the caller picks", async () => {
    // the same bytes read as ISO-8859-15 and as Windows-1252 differ only where those encodings do
    const euro = Uint8Array.from([0xa4]);
    expect((await run(decodeText(bytes(euro), { encoding: "ISO-8859-15" }))).text).toBe("€");
    expect((await run(decodeText(bytes(euro), { encoding: "windows-1252" }))).text).toBe("¤");
  });

  test("is strict: bytes the encoding doesn't define fail with MalformedText at their offset", async () => {
    const error = await run(Effect.flip(decodeText(bytes(CP1252), { encoding: "UTF-8" })));
    expect(error).toMatchObject({ format: "text", code: "MalformedText", position: { offset: 4 } });
  });

  test("a CJK encoding decodes where the platform's TextDecoder has it", async () => {
    // "日本" in Shift_JIS
    const sjis = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b]);
    expect((await run(decodeText(bytes(sjis), { encoding: "Shift_JIS" }))).text).toBe("日本");
  });

  test("text content is returned as it is, and the result reads as CSV", async () => {
    const input = text("a,b\n");
    expect(await run(decodeText(input))).toBe(input);
    const doc = await run(Effect.flatMap(decodeText(bytes(CP1252)), Csv.makeCsvReader().read));
    expect(doc.blocks).toHaveLength(1);
  });

  test("names effect-ext's encodings", () => {
    expect(ENCODING_NAMES).toContain("windows-1252");
    expect(ENCODING_NAMES).toContain("UTF-16LE");
  });
});
