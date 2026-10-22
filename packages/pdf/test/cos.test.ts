import { describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
import { blocksToText, bytes, document, para, str, trustAs } from "@thomasfosterau/effect-document";
import { type PdfFeature, makePdfReader, makePdfWriter } from "../src/index.ts";
import {
  PdfBuilder,
  PdfFile,
  type PdfObject,
  type PdfStream,
  applyFilter,
  bytesToLatin1,
  decodeFilters,
  flateEncode,
  isDict,
  isStream,
  latin1ToBytes,
  parseContentStream,
  parseObject,
  pdfArray,
  pdfDict,
  pdfName,
  pdfRef,
  pdfStream,
  pdfString,
  pdfTextString,
  rewritePdf,
  serializeObject,
} from "../src/cos/index.ts";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
const enc = latin1ToBytes;
const parse = (s: string): PdfObject => parseObject(enc(s));
const text = (o: PdfObject): string =>
  o !== null && typeof o === "object" && o._tag === "String" ? bytesToLatin1(o.bytes) : "?";

const concat = (parts: ReadonlyArray<Uint8Array | string>): Uint8Array => {
  const bufs = parts.map((p) => (typeof p === "string" ? enc(p) : p));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let pos = 0;
  for (const b of bufs) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
};

const pdfBytes = (body: string, title?: string): Uint8Array => {
  const c = run(
    makePdfWriter().write(
      trustAs<PdfFeature>(document([para([str(body)])], title === undefined ? {} : { title })),
    ),
  );
  if (c._tag !== "Bytes") throw new Error("expected bytes");
  return c.bytes;
};

describe("object parser", () => {
  test("scalars, names and references", () => {
    expect(parse("42")).toBe(42);
    expect(parse("-3.5")).toBe(-3.5);
    expect(parse(".25")).toBe(0.25);
    expect(parse("true")).toBe(true);
    expect(parse("null")).toBe(null);
    expect(parse("/A#20B")).toEqual(pdfName("A B"));
    expect(parse("12 0 R")).toEqual(pdfRef(12, 0));
    const a = parse("[1 0 R 2 /X 3 4]");
    expect(a).toEqual(pdfArray([pdfRef(1, 0), 2, pdfName("X"), 3, 4]));
  });

  test("literal strings: escapes, balanced parentheses, octal, line continuations", () => {
    expect(text(parse("(a(b)c)"))).toBe("a(b)c");
    expect(text(parse("(\\(\\)\\\\\\n\\t)"))).toBe("()\\\n\t");
    expect(text(parse("(\\101\\7a)"))).toBe("A\x07a");
    expect(text(parse("(one\\\ntwo)"))).toBe("onetwo");
    expect(text(parse("(cr\r\nlf)"))).toBe("cr\nlf");
  });

  test("hex strings ignore whitespace and pad an odd final digit", () => {
    expect(text(parse("<48 65 6C6C 6F>"))).toBe("Hello");
    expect(text(parse("<414>"))).toBe("A@");
  });

  test("dictionaries, comments and nesting", () => {
    const d = parse("<< /Type /Page % a comment\n /Kids [ << /A 1 >> ] /Empty >>");
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    expect(d.entries.get("Type")).toEqual(pdfName("Page"));
    expect(d.entries.get("Empty")).toBe(null);
  });

  test("streams honour a correct /Length and recover from a wrong one", () => {
    const good = parse("<< /Length 5 >>\nstream\nhello\nendstream");
    expect(isStream(good) && bytesToLatin1(good.data)).toBe("hello");
    const bad = parse("<< /Length 99 >>\nstream\r\nhello world\r\nendstream");
    expect(isStream(bad) && bytesToLatin1(bad.data)).toBe("hello world");
  });

  test("serializing and re-parsing is the identity", () => {
    const o = pdfDict({
      Name: pdfName("A B/C"),
      Str: pdfString(enc("p(a)r\\e\n\xff")),
      Hex: pdfString(Uint8Array.of(0, 1, 254), true),
      Arr: pdfArray([1, -2.5, 0.000001, true, null, pdfRef(3, 1)]),
      Text: pdfTextString("Ünïcode ✓"),
    });
    expect(parseObject(serializeObject(o))).toEqual(o);
    const s = pdfStream(pdfDict({ Type: pdfName("X") }), Uint8Array.of(0, 255, 10, 13));
    const back = parseObject(serializeObject(s)) as PdfStream;
    expect(Array.from(back.data)).toEqual([0, 255, 10, 13]);
  });
});

describe("content streams", () => {
  test("operators collect their operands", () => {
    const ops = parseContentStream(enc("BT /F1 12 Tf 72 700 Td [(He) -120 (llo)] TJ ET"));
    expect(ops.map((o) => o.op)).toEqual(["BT", "Tf", "Td", "TJ", "ET"]);
    expect(ops[1]!.operands).toEqual([pdfName("F1"), 12]);
  });

  test("inline images are skipped as one operation", () => {
    const ops = parseContentStream(
      enc("q BI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\xff EI Q (after) Tj"),
    );
    expect(ops.map((o) => o.op)).toEqual(["q", "BI", "Q", "Tj"]);
    const img = ops[1]!.operands[0] as PdfStream;
    expect(img.dict.entries.get("W")).toBe(2);
    expect(Array.from(img.data)).toEqual([0x00, 0x45, 0x49, 0xff]);
  });
});

describe("filters", () => {
  test("ASCIIHex, ASCII85 and RunLength", () => {
    expect(bytesToLatin1(applyFilter("ASCIIHexDecode", enc("48 69>"), undefined))).toBe("Hi");
    expect(bytesToLatin1(applyFilter("ASCII85Decode", enc("<~9jqo^~>"), undefined))).toBe("Man ");
    expect(bytesToLatin1(applyFilter("ASCII85Decode", enc("z9jqo~>"), undefined))).toBe(
      "\0\0\0\0Man",
    );
    expect(
      bytesToLatin1(
        applyFilter("RunLengthDecode", Uint8Array.of(2, 65, 66, 67, 254, 68, 128), undefined),
      ),
    ).toBe("ABCDDD");
  });

  test("LZW (the example from the specification)", () => {
    const out = applyFilter(
      "LZWDecode",
      Uint8Array.of(0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01),
      undefined,
    );
    expect(Array.from(out)).toEqual([45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
  });

  test("Flate with a PNG Up predictor, through a filter chain", () => {
    const rows = [
      [1, 2, 3],
      [4, 6, 8],
    ];
    // PNG "Up" (2): each byte stored as the difference from the byte above
    const predicted = Uint8Array.of(2, 1, 2, 3, 2, 3, 4, 5);
    const flated = flateEncode(predicted);
    const hex = enc(Array.from(flated, (b) => b.toString(16).padStart(2, "0")).join("") + ">");
    const dict = pdfDict({
      Filter: pdfArray([pdfName("ASCIIHexDecode"), pdfName("FlateDecode")]),
      DecodeParms: pdfArray([null, pdfDict({ Predictor: 12, Columns: 3 })]),
    });
    expect(Array.from(decodeFilters(dict, hex).data)).toEqual(rows.flat());
  });

  test("image filters are reported, not decoded", () => {
    const d = decodeFilters(pdfDict({ Filter: pdfName("DCTDecode") }), Uint8Array.of(0xff, 0xd8));
    expect(d.imageFilter).toBe("DCTDecode");
    expect(Array.from(d.data)).toEqual([0xff, 0xd8]);
  });
});

// A file with a cross-reference stream (PNG-predicted) and an object stream.
const xrefStreamPdf = (): Uint8Array => {
  const content = "BT /F1 12 Tf 72 720 Td (Packed objects) Tj ET";
  const members: Array<[number, PdfObject]> = [
    [1, pdfDict({ Type: pdfName("Catalog"), Pages: pdfRef(2) })],
    [2, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([pdfRef(3)]), Count: 1 })],
    [
      3,
      pdfDict({
        Type: pdfName("Page"),
        Parent: pdfRef(2),
        MediaBox: pdfArray([0, 0, 612, 792]),
        Contents: pdfRef(4),
        Resources: pdfDict({ Font: pdfDict({ F1: pdfRef(5) }) }),
      }),
    ],
    [
      5,
      pdfDict({ Type: pdfName("Font"), Subtype: pdfName("Type1"), BaseFont: pdfName("Helvetica") }),
    ],
  ];
  let header = "";
  let body = "";
  for (const [num, obj] of members) {
    header += `${num} ${body.length} `;
    body += bytesToLatin1(serializeObject(obj)) + " ";
  }
  const objstm = header + body;

  const parts: Array<Uint8Array | string> = ["%PDF-1.5\n"];
  let pos = parts[0]!.length;
  const offsets: Record<number, number> = {};
  const add = (num: number, s: Uint8Array): void => {
    offsets[num] = pos;
    const chunk = concat([`${num} 0 obj\n`, s, "\nendobj\n"]);
    parts.push(chunk);
    pos += chunk.length;
  };
  add(4, serializeObject(pdfStream(pdfDict(), enc(content))));
  add(
    6,
    serializeObject(
      pdfStream(pdfDict({ Type: pdfName("ObjStm"), N: 4, First: header.length }), enc(objstm)),
    ),
  );
  offsets[7] = pos;

  // rows of [type(1) field2(4) field3(2)], PNG Up-predicted
  const rows: number[][] = [];
  const row = (type: number, f2: number, f3: number) =>
    rows.push([
      type,
      (f2 >>> 24) & 255,
      (f2 >>> 16) & 255,
      (f2 >>> 8) & 255,
      f2 & 255,
      f3 >> 8,
      f3 & 255,
    ]);
  row(0, 0, 65535);
  row(2, 6, 0);
  row(2, 6, 1);
  row(2, 6, 2);
  row(1, offsets[4]!, 0);
  row(2, 6, 3);
  row(1, offsets[6]!, 0);
  row(1, offsets[7]!, 0);
  const predicted: number[] = [];
  rows.forEach((r, i) =>
    predicted.push(2, ...r.map((b, j) => (b - (rows[i - 1]?.[j] ?? 0)) & 255)),
  );
  const xref = pdfStream(
    pdfDict({
      Type: pdfName("XRef"),
      Size: 8,
      W: pdfArray([1, 4, 2]),
      Root: pdfRef(1),
      Filter: pdfName("FlateDecode"),
      DecodeParms: pdfDict({ Predictor: 12, Columns: 7 }),
    }),
    flateEncode(Uint8Array.from(predicted)),
  );
  add(7, serializeObject(xref));
  parts.push(`startxref\n${offsets[7]}\n%%EOF\n`);
  return concat(parts);
};

describe("PdfFile", () => {
  test("reads a classic xref table", () => {
    const file = PdfFile.open(pdfBytes("Hello", "T"));
    expect(file.repaired).toBe(false);
    expect(file.version).toBe("1.7");
    expect(file.pages().length).toBe(1);
    expect(file.encrypted).toBe(false);
  });

  test("reads cross-reference streams and object streams", () => {
    const data = xrefStreamPdf();
    const file = PdfFile.open(data);
    expect(file.repaired).toBe(false);
    expect(file.entry(3)?._tag).toBe("Compressed");
    expect(file.pages().length).toBe(1);
    const doc = run(makePdfReader().read(bytes(data)));
    expect(blocksToText(doc.blocks)).toBe("Packed objects");
  });

  test("repairs a file whose startxref points nowhere", () => {
    const data = pdfBytes("Survives damage");
    const s = bytesToLatin1(data).replace(/startxref\n\d+/, "startxref\n999999");
    const file = PdfFile.open(enc(s));
    expect(file.repaired).toBe(true);
    expect(blocksToText(run(makePdfReader().read(bytes(enc(s)))).blocks)).toBe("Survives damage");
  });

  test("repairs a file with no xref table or trailer at all", () => {
    const s = bytesToLatin1(pdfBytes("No table"));
    const truncated = s.slice(0, s.indexOf("xref\n"));
    expect(blocksToText(run(makePdfReader().read(bytes(enc(truncated)))).blocks)).toBe("No table");
  });

  test("repairs shifted object offsets", () => {
    // junk inserted after the header moves every object
    const s = bytesToLatin1(pdfBytes("Shifted"));
    const shifted = s.replace("%PDF-1.7\n", "%PDF-1.7\n% padding padding padding\n");
    expect(blocksToText(run(makePdfReader().read(bytes(enc(shifted)))).blocks)).toBe("Shifted");
  });

  test("follows incremental updates (/Prev): the newest object wins", () => {
    const base = pdfBytes("Body", "Old title");
    const file = PdfFile.open(base);
    const infoRef = file.trailer.entries.get("Info");
    const rootRef = file.trailer.entries.get("Root");
    const prevXref = Number(/startxref\n(\d+)/.exec(bytesToLatin1(base))![1]);
    const infoNum = (infoRef as { num: number }).num;
    const objAt = base.length;
    const update = `${infoNum} 0 obj\n<< /Title (New title) >>\nendobj\n`;
    const xrefAt = objAt + update.length;
    const tail =
      `xref\n${infoNum} 1\n${String(objAt).padStart(10, "0")} 00000 n\r\n` +
      `trailer\n<< /Size ${infoNum + 1} /Root ${(rootRef as { num: number }).num} 0 R /Info ${infoNum} 0 R /Prev ${prevXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const updated = concat([base, update, tail]);
    const doc = run(makePdfReader().read(bytes(updated)));
    expect(doc.meta.title).toBe("New title");
    expect(blocksToText(doc.blocks)).toBe("Body");
  });

  test("rejects non-PDF input and refuses encrypted files", () => {
    const notPdf = Effect.runSync(Effect.result(makePdfReader().read(bytes(enc("hello")))));
    expect(notPdf._tag).toBe("Failure");
    const s = bytesToLatin1(pdfBytes("Secret"));
    const encrypted = s.replace(
      "trailer\n<<",
      "trailer\n<</Encrypt << /Filter /Standard /V 1 /R 2 >> ",
    );
    const r = Effect.runSync(Effect.result(makePdfReader().read(bytes(enc(encrypted)))));
    expect(r._tag).toBe("Failure");
    if (r._tag === "Failure") expect(r.failure.reason).toContain("encrypted");
  });

  test("rewritePdf expands object streams and keeps the content", () => {
    const file = PdfFile.open(xrefStreamPdf());
    const out = rewritePdf(file);
    const again = PdfFile.open(out);
    expect(again.repaired).toBe(false);
    expect(again.entry(3)?._tag).toBe("Offset");
    expect(again.entry(6)?._tag ?? "Free").toBe("Free"); // the object stream itself is gone
    expect(blocksToText(run(makePdfReader().read(bytes(out))).blocks)).toBe("Packed objects");
  });

  test("PdfBuilder writes a file PdfFile can read back", () => {
    const pdf = new PdfBuilder();
    const pages = pdf.alloc();
    const page = pdf.add(pdfDict({ Type: pdfName("Page"), Parent: pages }));
    pdf.set(pages, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([page]), Count: 1 }));
    const root = pdf.add(pdfDict({ Type: pdfName("Catalog"), Pages: pages }));
    const file = PdfFile.open(pdf.build({ root }));
    expect(file.repaired).toBe(false);
    expect(file.pages()[0]!.mediaBox).toEqual([0, 0, 612, 792]); // the default
  });
});
