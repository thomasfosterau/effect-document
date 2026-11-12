import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  bytes,
  collectDiagnostics,
  type Content,
  type Document,
  type Meta,
  document,
  type ParseError,
  type WriteError,
  para,
  Slide,
  SlideShow,
  str,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import { makeDocxReader, makeDocxWriter } from "../../../src/ooxml/docx/index.ts";
import { makePptxReader, makePptxWriter } from "../../../src/ooxml/pptx/index.ts";
import { makeXlsxReader, makeXlsxWriter } from "../../../src/ooxml/xlsx/index.ts";
import { appPropsXml, corePropsXml } from "../../../src/ooxml/shared/index.ts";

const FULL = {
  title: "A <title> & more",
  subject: "Subject",
  author: "Ada Lovelace",
  keywords: "one, two",
  description: "Notes",
  lastModifiedBy: "Grace Hopper",
  revision: "7",
  category: "Reports",
  contentStatus: "Draft",
  lang: "en-AU",
  created: "2024-05-06T07:08:09Z",
  modified: "2025-01-02T03:04:05.5+10:00",
  creator: "My Writer 1.0",
};

interface Case {
  readonly id: "docx" | "xlsx" | "pptx";
  readonly doc: (meta: Meta) => Document;
  readonly write: (doc: Document) => Effect.Effect<Content, WriteError>;
  readonly read: (content: Content) => Effect.Effect<Document, ParseError>;
}

// The readers and writers are typed by profile; these samples conform to each.
const CASES: ReadonlyArray<Case> = [
  {
    id: "docx",
    doc: (meta) => document([para([str("hi")])], meta),
    write: (doc) => makeDocxWriter().write(trustAs(doc)),
    read: (content) => makeDocxReader().read(content),
  },
  {
    id: "xlsx",
    doc: (meta) => document([worksheet("S", [["a", 1]])], meta),
    write: (doc) => makeXlsxWriter().write(trustAs(doc)),
    read: (content) => makeXlsxReader().read(content),
  },
  {
    id: "pptx",
    doc: (meta) => document([new SlideShow({ slides: [new Slide({ shapes: [] })] })], meta),
    write: (doc) => makePptxWriter().write(trustAs(doc)),
    read: (content) => makePptxReader().read(content),
  },
];

const parts = (content: Content): Record<string, string> => {
  assert(Predicate.isTagged(content, "Bytes"), "expected bytes");
  return Rec.map(unzipSync(content.bytes), (data) => strFromU8(data));
};

const rezip = (files: Record<string, string>): Content =>
  bytes(zipSync(Rec.map(files, (text) => strToU8(text))));

describe.each(CASES)("$id package metadata (#79)", (c) => {
  test("every key round-trips through docProps", async () => {
    const out = await Effect.runPromise(c.write(c.doc(FULL)).pipe(Effect.flatMap(c.read)));
    expect(out.meta).toEqual(FULL);
  });

  test("a document without meta writes empty properties and invents nothing", async () => {
    const content = await Effect.runPromise(c.write(c.doc({})));
    const files = parts(content);
    expect(files["docProps/core.xml"]).not.toMatch(/<dc|<cp:[a-z]+>|<dcterms/);
    expect(files["docProps/app.xml"]).toContain("<Application>effect-document</Application>");
    expect(files["[Content_Types].xml"]).toContain("/docProps/core.xml");
    expect(files["_rels/.rels"]).toContain('Target="docProps/core.xml"');
    expect(files["_rels/.rels"]).toContain('Target="docProps/app.xml"');
    const ids = Array.from((files["_rels/.rels"] ?? "").matchAll(/Id="([^"]+)"/g), (m) => m[1]);
    expect(ids).toEqual(["rId1", "rId2", "rId3"]);
    const read = await Effect.runPromise(c.read(content));
    // the Application we wrote is read back as the producing application
    expect(read.meta).toEqual({ creator: "effect-document" });
    const again = await Effect.runPromise(c.write(c.doc({})));
    expect(parts(again)).toEqual(files);
  });

  test("a package using other prefixes for the same namespaces still reads", async () => {
    const files = parts(await Effect.runPromise(c.write(c.doc({}))));
    files["docProps/core.xml"] =
      `<?xml version="1.0"?><x:coreProperties xmlns:x="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:d="http://purl.org/dc/elements/1.1/" xmlns:t="http://purl.org/dc/terms/">` +
      `<d:title>Other</d:title><x:keywords>k</x:keywords><t:created>2020</t:created><d:creator>  </d:creator></x:coreProperties>`;
    files["docProps/app.xml"] =
      `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Elsewhere</Application></Properties>`;
    const out = await Effect.runPromise(c.read(rezip(files)));
    expect(out.meta).toEqual({
      title: "Other",
      keywords: "k",
      created: "2020",
      creator: "Elsewhere",
    });
  });

  test("elements in the wrong namespace are ignored", async () => {
    const files = parts(await Effect.runPromise(c.write(c.doc({}))));
    files["docProps/core.xml"] =
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="urn:other"><dc:title>No</dc:title></cp:coreProperties>`;
    const out = await Effect.runPromise(c.read(rezip(files)));
    expect(out.meta).not.toHaveProperty("title");
  });

  test("a package without property parts reads with no keys", async () => {
    const files = parts(await Effect.runPromise(c.write(c.doc({}))));
    delete files["docProps/core.xml"];
    delete files["docProps/app.xml"];
    const [out, found] = await Effect.runPromise(collectDiagnostics(c.read(rezip(files))));
    expect(out.meta).toEqual({});
    expect(found).toEqual([]);
  });

  test("a malformed core.xml is reported and the read goes on", async () => {
    const files = parts(await Effect.runPromise(c.write(c.doc({ title: "T" }))));
    files["docProps/core.xml"] = "<cp:coreProperties><dc:title>oops";
    const [out, found] = await Effect.runPromise(collectDiagnostics(c.read(rezip(files))));
    expect(out.meta).toEqual({ creator: "effect-document" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      format: c.id,
      stage: "read",
      code: `${c.id}.metadataUnreadable`,
      severity: "dropped-content",
      path: ["docProps/core.xml"],
    });
  });

  test("an invalid date is skipped with a diagnostic; other keys are written", async () => {
    const meta = { title: "T", created: "yesterday", modified: "2024-02-03", author: 5 };
    const [content, found] = await Effect.runPromise(collectDiagnostics(c.write(c.doc(meta))));
    expect(found.map((d) => [d.code, d.stage, d.severity, d.path])).toEqual([
      [`${c.id}.metadataSkipped`, "write", "dropped-content", ["meta", "created"]],
    ]);
    const out = await Effect.runPromise(c.read(content));
    expect(out.meta).toEqual({ title: "T", modified: "2024-02-03", creator: "effect-document" });
  });
});

const written = (created: string) => corePropsXml({ created }).includes("<dcterms:created");

describe("core properties XML", () => {
  test.each(["2024", "2024-05", "2024-05-06", "2024-05-06T07:08Z", "2024-05-06T07:08:09.12-05:30"])(
    "writes the W3CDTF date %s",
    (date) => expect(written(date)).toBe(true),
  );

  test.each(["24", "2024-13", "2024-05-32", "2024-05-06T07:08", "2024-05-06 07:08Z", ""])(
    "does not write %j as a date",
    (date) => expect(written(date)).toBe(false),
  );

  test("escapes text and ignores non-string and empty values", () => {
    expect(corePropsXml({ title: "a<b&c", author: "", subject: 3 })).toContain(
      "<dc:title>a&lt;b&amp;c</dc:title>",
    );
    expect(corePropsXml({ author: "", subject: 3, nope: "x" })).toMatch(/\/>$/);
    expect(appPropsXml({ creator: "A&B" })).toContain("<Application>A&amp;B</Application>");
    expect(appPropsXml({ creator: "" })).toContain("<Application>effect-document</Application>");
  });
});
