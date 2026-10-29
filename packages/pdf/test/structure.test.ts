/**
 * The writer's structure tree (tagged PDF, #198): the elements it writes, the
 * marked content they own, and the parent tree that maps content back to them.
 */

import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  type Block,
  BlockQuote,
  bulletList,
  codeBlock,
  document,
  header,
  link,
  OrderedList,
  orderedList,
  para,
  plainText,
  str,
  trustAs,
  Underline,
} from "@thomasfosterau/effect-document";
import { type PdfFeature, makePdfWriter } from "../src/index.ts";
import {
  PdfFile,
  type PdfDict,
  type PdfObject,
  type PdfRef,
  bytesToLatin1,
  isArray,
  isDict,
  isName,
  isRef,
  isString,
  parseContentStream,
} from "../src/cos/index.ts";

/** The bullet as the writer encodes it (WinAnsiEncoding's code 0o177, which PDF maps to a bullet). */
const BULLET = "\x7f";

const write = (blocks: ReadonlyArray<Block>, meta: Record<string, unknown> = {}): PdfFile => {
  const c = Effect.runSync(
    makePdfWriter({ compress: false }).write(trustAs<PdfFeature>(document(blocks, meta))),
  );
  assert(Predicate.isTagged(c, "Bytes"));
  return PdfFile.open(c.bytes);
};

/** Each page's marked content: its text by MCID, and the artifacts' operators. */
/** The MCID a `BDC` operator's properties give, or `"other"` for a sequence without one. */
const mcidOf = (props: PdfObject | undefined): number | "other" => {
  const mcid = isDict(props) ? props.entries.get("MCID") : undefined;
  return Predicate.isNumber(mcid) ? mcid : "other";
};

const markedContent = (file: PdfFile) =>
  file.pages().map((page) => {
    const contents = file.resolve(page.dict.entries.get("Contents"));
    assert(contents !== undefined && Predicate.isTagged(contents, "Stream"));
    const texts = new Map<number, string>();
    const artifacts: Array<string> = [];
    const open: Array<number | "Artifact" | "other"> = [];
    // text shown outside any marked-content sequence
    let unmarked = 0;
    /** Record an operator shown inside the innermost open sequence. */
    const shown = (op: string, operand: PdfObject | undefined): void => {
      const inside = open[open.length - 1];
      if (inside === "Artifact") artifacts.push(op);
      if (op !== "Tj") return;
      if (inside === undefined) unmarked += 1;
      else if (Predicate.isNumber(inside) && isString(operand))
        texts.set(inside, (texts.get(inside) ?? "") + bytesToLatin1(operand.bytes));
    };
    parseContentStream(file.decode(contents).data).forEach(({ op, operands }) => {
      if (op === "BDC") open.push(mcidOf(operands[1]));
      else if (op === "BMC") open.push(isName(operands[0], "Artifact") ? "Artifact" : "other");
      else if (op === "EMC") open.pop();
      else shown(op, operands[0]);
    });
    expect(open).toEqual([]);
    expect(unmarked).toBe(0);
    return { ref: page.ref, texts, artifacts };
  });

/** A structure element as a plain tree: its type, and its kids as elements, text or links. */
type Shape = { readonly S: string; readonly K: ReadonlyArray<Shape | string> };

const structure = (file: PdfFile): Shape => {
  const pages = markedContent(file);
  const pageOf = (ref: PdfObject | undefined): number =>
    pages.findIndex((p) => isRef(ref) && p.ref?.num === ref.num);
  const tree = file.lookupDict(file.catalog, "StructTreeRoot");
  assert(tree !== undefined);
  const shape = (elem: PdfDict): Shape => {
    const own = pageOf(elem.entries.get("Pg"));
    const k = file.resolve(elem.entries.get("K"));
    const kids = isArray(k) ? k.items : k === undefined ? [] : [k];
    return {
      S: file.lookupName(elem, "S") ?? "?",
      K: kids.map((kid): Shape | string => {
        if (Predicate.isNumber(kid)) return pages[own]?.texts.get(kid) ?? "";
        const d = file.resolve(kid);
        assert(isDict(d));
        const type = file.lookupName(d, "Type");
        if (type === "MCR") {
          const mcid = file.lookupNumber(d, "MCID") ?? -1;
          return pages[pageOf(d.entries.get("Pg"))]?.texts.get(mcid) ?? "";
        }
        if (type === "OBJR") return "[link]";
        return shape(d);
      }),
    };
  };
  const root = file.lookupDict(tree, "K");
  assert(root !== undefined);
  return shape(root);
};

describe("the PDF writer's structure tree (#198)", () => {
  test("marks the document as tagged", () => {
    const file = write([para([str("x")])], { lang: "en-AU" });
    expect(file.lookupDict(file.catalog, "MarkInfo")?.entries.get("Marked")).toBe(true);
    const lang = file.lookup(file.catalog, "Lang");
    assert(isString(lang));
    expect(bytesToLatin1(lang.bytes)).toBe("en-AU");
    const page = file.pages()[0]!;
    expect(page.dict.entries.get("StructParents")).toBe(0);
  });

  test("tags headings, paragraphs, links, lists, code and quotes", () => {
    const file = write([
      header(2, [str("Title")]),
      para([str("See "), link([str("here")], "https://example.com"), str(".")]),
      bulletList([[plainText("a")], [para([str("b")]), bulletList([[plainText("c")]])]]),
      new BlockQuote({ content: [para([str("q")])] }),
      new OrderedList({ start: 3, items: [[plainText("one")]] }),
      codeBlock("x = 1"),
    ]);
    expect(structure(file)).toEqual({
      S: "Document",
      K: [
        { S: "H2", K: ["Title"] },
        { S: "P", K: ["See ", { S: "Link", K: ["here", "[link]"] }, "."] },
        {
          S: "L",
          K: [
            {
              S: "LI",
              K: [
                { S: "Lbl", K: [BULLET] },
                { S: "LBody", K: [{ S: "P", K: ["a"] }] },
              ],
            },
            {
              S: "LI",
              K: [
                { S: "Lbl", K: [BULLET] },
                {
                  S: "LBody",
                  K: [
                    { S: "P", K: ["b"] },
                    {
                      S: "L",
                      K: [
                        {
                          S: "LI",
                          K: [
                            { S: "Lbl", K: [BULLET] },
                            { S: "LBody", K: [{ S: "P", K: ["c"] }] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { S: "BlockQuote", K: [{ S: "P", K: ["q"] }] },
        {
          S: "L",
          K: [
            {
              S: "LI",
              K: [
                { S: "Lbl", K: ["3."] },
                { S: "LBody", K: [{ S: "P", K: ["one"] }] },
              ],
            },
          ],
        },
        { S: "Code", K: ["x = 1"] },
      ],
    });
  });

  test("records list numbering and block placement as attributes", () => {
    const file = write([
      orderedList([[plainText("a")]]),
      bulletList([[plainText("b")]]),
      codeBlock("c"),
    ]);
    const root = file.lookupDict(file.lookupDict(file.catalog, "StructTreeRoot"), "K");
    const kids = file.lookupArray(root, "K")?.items.map((k) => file.resolve(k)) ?? [];
    const attr = (i: number, key: string): string | undefined => {
      const elem = kids[i];
      assert(isDict(elem));
      return file.lookupName(file.lookupDict(elem, "A"), key);
    };
    expect(attr(0, "ListNumbering")).toBe("Decimal");
    expect(attr(1, "ListNumbering")).toBe("Disc");
    expect(attr(2, "Placement")).toBe("Block");
  });

  test("the parent tree maps every MCID and link annotation to its element", () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" ");
    const file = write([para([str(words)]), para([link([str("a link")], "https://example.com")])]);
    const pages = markedContent(file);
    expect(pages.length).toBeGreaterThan(1);
    const tree = file.lookupDict(file.catalog, "StructTreeRoot");
    const nums = file.lookupArray(file.lookupDict(tree, "ParentTree"), "Nums")?.items ?? [];
    const entries = new Map<number, PdfObject | undefined>();
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const key = nums[i];
      assert(Predicate.isNumber(key));
      entries.set(key, nums[i + 1]);
    }
    /** Whether element `ref`'s kids include MCID `mcid` on page `page`. */
    const owns = (ref: PdfObject | undefined, page: number, mcid: number): boolean => {
      const elem = file.resolve(ref);
      assert(isDict(elem));
      const ownPage = elem.entries.get("Pg");
      const kids = file.lookupArray(elem, "K")?.items ?? [];
      const onPage = (pg: PdfObject | undefined): boolean =>
        isRef(pg) && pg.num === pages[page]?.ref?.num;
      return kids.some((kid) => {
        if (Predicate.isNumber(kid)) return kid === mcid && onPage(ownPage);
        const d = file.resolve(kid);
        return isDict(d) && file.lookupNumber(d, "MCID") === mcid && onPage(d.entries.get("Pg"));
      });
    };
    pages.forEach((page, p) => {
      const owners = entries.get(p);
      assert(isArray(owners));
      expect(owners.items.length).toBe(page.texts.size);
      owners.items.forEach((owner, mcid) => expect(owns(owner, p, mcid)).toBe(true));
    });
    // the paragraph that runs over a page break has content on both pages
    const first = structure(file).K[0];
    assert(first !== undefined && !Predicate.isString(first));
    expect(first.K.length).toBeGreaterThan(1);
    // (lines are joined without their breaks, so compare the words alone)
    expect(first.K.join("").replace(/\s/g, "")).toBe(words.replace(/\s/g, ""));
    // the link annotation's /StructParent is its Link element's key
    const annots = file
      .pages()
      .flatMap((page) => file.lookupArray(page.dict, "Annots")?.items ?? []);
    expect(annots.length).toBe(1);
    const annot = file.resolve(annots[0]);
    assert(isDict(annot));
    const key = file.lookupNumber(annot, "StructParent");
    assert(key !== undefined);
    const linkElem = file.resolve(entries.get(key));
    assert(isDict(linkElem));
    expect(file.lookupName(linkElem, "S")).toBe("Link");
    const objr = file
      .lookupArray(linkElem, "K")
      ?.items.map((k) => file.resolve(k))
      .find(isDict);
    assert(objr !== undefined);
    const obj = objr.entries.get("Obj");
    assert(isRef(obj) && isRef(annots[0]));
    expect(obj.num).toBe((annots[0] as PdfRef).num);
    expect(file.lookupNumber(tree, "ParentTreeNextKey")).toBe(pages.length + 1);
  });

  test("decoration is an artifact, not content", () => {
    const file = write([para([new Underline({ content: [str("u")] })])]);
    const [page] = markedContent(file);
    expect(page?.artifacts).toContain("S");
    expect([...(page?.texts.values() ?? [])]).toEqual(["u"]);
  });
});
