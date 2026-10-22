import { describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
import { strToU8, zipSync } from "fflate";
import { bytes } from "@thomasfosterau/effect-document";
import { decodePart, OpcError, OpcReader, resolveTarget, XmlPartError, zipParts } from "../../src/shared/index.ts";
import { makeDocxReader, makeDocxWriter } from "../../src/docx/index.ts";
import { makePptxReader } from "../../src/pptx/index.ts";
import { makeXlsxReader, makeXlsxWriter } from "../../src/xlsx/index.ts";
import { cell, document, para, str, trustAs, worksheet } from "@thomasfosterau/effect-document";

const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));

describe("OpcReader (#55)", () => {
  test("inflates parts lazily and matches part names case-insensitively", () => {
    const pkg = new OpcReader(zip({ "Word/Document.xml": "<a/>", "media/big.bin": new Uint8Array(1000) }));
    expect(pkg.partNames).toContain("media/big.bin");
    expect(pkg.text("word/document.xml")).toBe("<a/>");
    expect(pkg.bytes("/WORD/document.XML")).not.toBeNull();
    expect(pkg.bytes("missing.xml")).toBeNull();
  });

  test("enforces entry-count, per-part and total limits", () => {
    const data = zip({ "a.xml": "x".repeat(100), "b.xml": "y".repeat(100), "c.xml": "z" });
    expect(() => new OpcReader(data, { maxEntries: 2 })).toThrow(OpcError);
    expect(() => new OpcReader(data, { maxPartBytes: 50 }).bytes("a.xml")).toThrow(/inflates to 100 bytes/);
    const pkg = new OpcReader(data, { maxTotalBytes: 150 });
    pkg.bytes("a.xml");
    expect(() => pkg.bytes("b.xml")).toThrow(/more than 150 bytes/);
    expect(pkg.bytes("c.xml")).not.toBeNull();
  });

  test("a zip bomb part is refused before inflating", () => {
    const bomb = zipSync({ "x.xml": new Uint8Array(20 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(() => new OpcReader(bomb, { maxPartBytes: 1024 * 1024 }).bytes("x.xml")).toThrow(/inflates to/);
  });

  test("percent-decodes relationship targets and keeps external ones as-is", () => {
    expect(resolveTarget("word", "media/my%20image.png")).toBe("word/media/my image.png");
    const pkg = new OpcReader(zip({
      "word/_rels/document.xml.rels":
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="r1" Type="t/image" Target="media/a%20b.png"/>` +
        `<Relationship Id="r2" Type="t/hyperlink" Target="https://x.example/a%20b" TargetMode="External"/>` +
        `</Relationships>`,
    }));
    expect(pkg.rels("word/document.xml").map((r) => [r.target, r.external])).toEqual([
      ["word/media/a b.png", false],
      ["https://x.example/a%20b", true],
    ]);
  });

  test("decodes UTF-16 parts by BOM or by their first bytes", () => {
    const utf16le = (s: string, bom: boolean) => {
      const out = new Uint8Array((bom ? 2 : 0) + s.length * 2);
      if (bom) out.set([0xff, 0xfe]);
      for (let i = 0; i < s.length; i++) out[(bom ? 2 : 0) + 2 * i] = s.charCodeAt(i);
      return out;
    };
    expect(decodePart(utf16le("<a>é</a>", true))).toBe("<a>é</a>");
    expect(decodePart(utf16le(`<?xml version="1.0" encoding="UTF-16"?><a/>`, false))).toContain("<a/>");
    expect(decodePart(new Uint8Array([0xfe, 0xff, 0, 0x3c, 0, 0x61, 0, 0x2f, 0, 0x3e]))).toBe("<a/>");
    expect(decodePart(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x62, 0x2f, 0x3e]))).toBe("<b/>");
  });

  test("malformed XML reports the part, line and column", () => {
    const pkg = new OpcReader(zip({ "p.xml": "<a>\n  <b></a>" }));
    try {
      pkg.xml("p.xml");
      throw new Error("expected a failure");
    } catch (e) {
      expect(e).toBeInstanceOf(XmlPartError);
      expect((e as XmlPartError).part).toBe("p.xml");
      expect((e as XmlPartError).failure.position).toEqual({ line: 2, column: 4 });
    }
  });

  test("zip output is byte-deterministic", () => {
    expect(zipParts({ "a.xml": "<a/>" })).toEqual(zipParts({ "a.xml": "<a/>" }));
    const doc = trustAs(document([worksheet("S", [[cell.number(1)]])]));
    const write = () => Effect.runSync(makeXlsxWriter().write(doc as never));
    expect(write()).toEqual(write());
  });
});

describe("readers (#55)", () => {
  const docx = () => {
    const out = Effect.runSync(makeDocxWriter().write(trustAs(document([para([str("hi")])])) as never));
    if (out._tag !== "Bytes") throw new Error("expected bytes");
    return out;
  };

  test("a package of the wrong type fails with WrongPackageType instead of reading empty", () => {
    const pptx = Effect.runSync(Effect.flip(makePptxReader().read(docx())));
    expect(pptx.reason).toContain("WrongPackageType");
    const xlsx = Effect.runSync(Effect.flip(makeXlsxReader().read(docx())));
    expect(xlsx.reason).toContain("WrongPackageType");
    expect(Effect.runSync(makeDocxReader().read(docx())).blocks).toHaveLength(1);
  });

  test("reader limits apply and fail with a ParseError", () => {
    const error = Effect.runSync(Effect.flip(makeDocxReader({ limits: { maxPartBytes: 10 } }).read(docx())));
    expect(error).toMatchObject({ _tag: "ParseError", format: "docx", code: "LimitExceeded" });
    expect(error.reason).toContain("LimitExceeded");
  });

  test("malformed XML in a part carries its position", () => {
    const pkg = zip({
      "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="x/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": "<w:document>\n<w:body></w:document>",
    });
    const error = Effect.runSync(Effect.flip(makeDocxReader().read(bytes(pkg))));
    expect(error.reason).toContain("/word/document.xml");
    expect(error.position).toEqual({ row: 2, column: 2 });
  });
});
