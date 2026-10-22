/**
 * Opening a PDF file: the cross-reference machinery (ISO 32000-2 §7.5).
 *
 * `PdfFile.open` reads the trailer and the cross-reference chain from the end
 * of the file - classic `xref` tables, cross-reference streams, hybrid files
 * (`/XRefStm`) and incremental updates (`/Prev`) - and then serves indirect
 * objects on demand, including objects packed into object streams. Objects are
 * parsed lazily and cached.
 *
 * Damaged files are common, so when the cross-reference data is missing or
 * points at the wrong place, the file is reconstructed by scanning for
 * `n g obj` headers and `trailer` dictionaries, the way viewers do.
 *
 * Encrypted files open (their structure is readable) but report `encrypted`;
 * their strings and streams are not decrypted.
 */

import { type Decoded, decodeFilters } from "./filters.ts";
import {
  type PdfArray, type PdfDict, type PdfObject, type PdfRef, type PdfStream, dictOf, isArray, isDict,
  isName, isRef, isStream, pdfDict,
} from "./objects.ts";
import { Lexer, Parser, PdfSyntaxError, ascii, indexOf, isKeyword, isWhitespace, lastIndexOf } from "./parser.ts";

/** Where an indirect object lives. */
export type XrefEntry =
  | { readonly _tag: "Offset"; readonly offset: number; readonly gen: number }
  | { readonly _tag: "Compressed"; readonly stream: number; readonly index: number }
  | { readonly _tag: "Free" };

/** A page of the document, with its inherited attributes resolved. */
export interface PdfPage {
  /** The page dictionary. */
  readonly dict: PdfDict;
  /** The page's indirect reference, when it has one. */
  readonly ref?: PdfRef | undefined;
  /** The (possibly inherited) resource dictionary. */
  readonly resources: PdfDict;
  /** The (possibly inherited) media box `[llx lly urx ury]`. */
  readonly mediaBox: readonly [number, number, number, number];
  /** The (possibly inherited) rotation, in degrees. */
  readonly rotate: number;
}

const STARTXREF = ascii("startxref");
const TRAILER = ascii("trailer");
const OBJ = ascii("obj");

const DEFAULT_MEDIA_BOX = [0, 0, 612, 792] as const;

/** A parsed PDF file. */
export class PdfFile {
  /** The header version (`1.7`), or the catalog's `/Version` when that is later. */
  readonly version: string;
  /** The (merged) trailer dictionary. */
  readonly trailer: PdfDict;
  /** Whether the cross-reference data had to be rebuilt by scanning the file. */
  readonly repaired: boolean;

  private xref: Map<number, XrefEntry>;
  private readonly cache = new Map<number, PdfObject>();
  private readonly objectStreams = new Map<number, Map<number, PdfObject>>();
  private readonly loading = new Set<number>();
  private rebuilt: { xref: Map<number, XrefEntry>; trailer: PdfDict } | undefined;

  readonly bytes: Uint8Array;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    const header = indexOf(bytes.subarray(0, 1024), ascii("%PDF-"));
    const vm = header >= 0 ? /^(\d\.\d)/.exec(String.fromCharCode(...bytes.subarray(header + 5, header + 8))) : null;
    let version = vm?.[1] ?? "1.4";

    let xref: Map<number, XrefEntry> | undefined;
    let trailer: PdfDict | undefined;
    let repaired = false;
    try {
      const read = this.readXrefChain();
      xref = read.xref;
      trailer = read.trailer;
      this.xref = xref;
      if (!isDict(this.resolve(trailer.entries.get("Root")))) throw new PdfSyntaxError("no document catalog", 0);
    } catch {
      const rebuilt = this.rebuild();
      xref = rebuilt.xref;
      trailer = rebuilt.trailer;
      repaired = true;
      this.cache.clear();
      this.objectStreams.clear();
    }
    this.xref = xref;
    this.trailer = trailer;
    this.repaired = repaired;
    if (!isDict(this.resolve(trailer.entries.get("Root")))) {
      throw new PdfSyntaxError("not a PDF file: no document catalog found", 0);
    }
    const catalogVersion = this.resolve(this.catalog.entries.get("Version"));
    if (isName(catalogVersion) && /^\d\.\d$/.test(catalogVersion.name) && catalogVersion.name > version) {
      version = catalogVersion.name;
    }
    this.version = version;
  }

  /** Open a PDF from its bytes. Throws `PdfSyntaxError` if it is not a readable PDF. */
  static open(bytes: Uint8Array): PdfFile {
    if (indexOf(bytes.subarray(0, 1024), ascii("%PDF-")) < 0) {
      throw new PdfSyntaxError("not a PDF file: missing %PDF- header", 0);
    }
    return new PdfFile(bytes);
  }

  /** Whether the file is encrypted (strings and streams are then not readable). */
  get encrypted(): boolean {
    return this.trailer.entries.has("Encrypt");
  }

  /** The document catalog (`/Root`). */
  get catalog(): PdfDict {
    return this.resolve(this.trailer.entries.get("Root")) as PdfDict;
  }

  /** The document information dictionary (`/Info`), if any. */
  get info(): PdfDict | undefined {
    const info = this.resolve(this.trailer.entries.get("Info"));
    return isDict(info) ? info : undefined;
  }

  /** The numbers of every object in the cross-reference data (free entries excluded). */
  objectNumbers(): number[] {
    return [...this.xref.entries()].filter(([, e]) => e._tag !== "Free").map(([n]) => n).sort((a, b) => a - b);
  }

  /** Where an object lives, according to the cross-reference data. */
  entry(num: number): XrefEntry | undefined {
    return this.xref.get(num);
  }

  // ==========================================================================
  // Objects
  // ==========================================================================

  /** Fetch indirect object `num` (`null` when it does not exist, as the spec says). */
  get(num: number): PdfObject {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
    if (this.loading.has(num)) return null; // a reference cycle through /Length
    this.loading.add(num);
    try {
      let object = this.load(num, this.xref);
      if (object === undefined && !this.repaired && this.xref.get(num)?._tag === "Offset") {
        // the table points at the wrong place: look the object up by scanning
        this.rebuilt ??= this.rebuild();
        object = this.load(num, this.rebuilt.xref);
      }
      const value = object ?? null;
      this.cache.set(num, value);
      return value;
    } finally {
      this.loading.delete(num);
    }
  }

  /** Follow references until a direct object. */
  resolve(o: PdfObject | undefined): PdfObject | undefined {
    let x = o;
    for (let hops = 0; isRef(x) && hops < 32; hops++) x = this.get(x.num);
    return isRef(x) ? null : x;
  }

  /** A dictionary entry, dereferenced. */
  lookup(dict: PdfDict | undefined, key: string): PdfObject | undefined {
    return dict === undefined ? undefined : this.resolve(dict.entries.get(key));
  }

  /** A dictionary entry that is (or refers to) a dictionary, or a stream's dictionary. */
  lookupDict(dict: PdfDict | undefined, key: string): PdfDict | undefined {
    return dictOf(this.lookup(dict, key));
  }

  /** A dictionary entry that is (or refers to) an array. */
  lookupArray(dict: PdfDict | undefined, key: string): PdfArray | undefined {
    const v = this.lookup(dict, key);
    return isArray(v) ? v : undefined;
  }

  /** A dictionary entry that is (or refers to) a number. */
  lookupNumber(dict: PdfDict | undefined, key: string): number | undefined {
    const v = this.lookup(dict, key);
    return typeof v === "number" ? v : undefined;
  }

  /** A dictionary entry that is (or refers to) a name. */
  lookupName(dict: PdfDict | undefined, key: string): string | undefined {
    const v = this.lookup(dict, key);
    return isName(v) ? v.name : undefined;
  }

  /** Decode a stream's data through its filters. */
  decode(stream: PdfStream): Decoded {
    return decodeFilters(stream.dict, stream.data, (o) => this.resolve(o));
  }

  private load(num: number, xref: Map<number, XrefEntry>): PdfObject | undefined {
    const e = xref.get(num);
    if (e === undefined || e._tag === "Free") return undefined;
    if (e._tag === "Compressed") return this.loadCompressed(e.stream, num);
    try {
      const parser = this.parserAt(e.offset);
      const obj = parser.indirect();
      return obj.num === num ? obj.object : undefined;
    } catch {
      return undefined;
    }
  }

  private parserAt(offset: number): Parser {
    return new Parser(new Lexer(this.bytes, offset), (length) => {
      const v = this.resolve(length);
      return typeof v === "number" ? v : undefined;
    });
  }

  /** An object from an object stream (members are found by number; the entry's index is only a hint). */
  private loadCompressed(streamNum: number, num: number): PdfObject | undefined {
    let objects = this.objectStreams.get(streamNum);
    if (objects === undefined) {
      objects = new Map();
      this.objectStreams.set(streamNum, objects);
      const stream = this.get(streamNum);
      if (isStream(stream)) {
        try {
          const n = this.lookupNumber(stream.dict, "N") ?? 0;
          const first = this.lookupNumber(stream.dict, "First") ?? 0;
          const data = this.decode(stream).data;
          const header = new Parser(new Lexer(data));
          const offsets: Array<[number, number]> = [];
          for (let i = 0; i < n; i++) {
            const objNum = header.object();
            const offset = header.object();
            if (typeof objNum !== "number" || typeof offset !== "number") break;
            offsets.push([objNum, offset]);
          }
          for (const [objNum, offset] of offsets) {
            try {
              objects.set(objNum, new Parser(new Lexer(data, first + offset)).object());
            } catch {
              // skip an unreadable member
            }
          }
        } catch {
          // an undecodable object stream yields no objects
        }
      }
    }
    return objects.get(num);
  }

  // ==========================================================================
  // Cross-reference chain
  // ==========================================================================

  private readXrefChain(): { xref: Map<number, XrefEntry>; trailer: PdfDict } {
    const bytes = this.bytes;
    const at = lastIndexOf(bytes, STARTXREF, bytes.length);
    if (at < 0) throw new PdfSyntaxError("no startxref", bytes.length);
    const offsetValue = new Parser(new Lexer(bytes, at + STARTXREF.length)).object();
    if (typeof offsetValue !== "number") throw new PdfSyntaxError("startxref is not a number", at);

    const xref = new Map<number, XrefEntry>();
    const trailers: PdfDict[] = [];
    const visited = new Set<number>();
    const pending = [offsetValue];
    while (pending.length > 0) {
      const offset = pending.shift()!;
      if (visited.has(offset) || offset < 0 || offset >= bytes.length) continue;
      visited.add(offset);
      const section = this.readXrefSection(offset);
      for (const [num, entry] of section.entries) if (!xref.has(num)) xref.set(num, entry);
      trailers.push(section.trailer);
      const stm = section.trailer.entries.get("XRefStm");
      if (typeof stm === "number") {
        // hybrid file: the stream's entries come before the previous section's
        if (!visited.has(stm)) {
          visited.add(stm);
          try {
            const extra = this.readXrefSection(stm);
            for (const [num, entry] of extra.entries) if (!xref.has(num)) xref.set(num, entry);
          } catch {
            // a broken hybrid stream: the table alone may still be enough
          }
        }
      }
      const prev = section.trailer.entries.get("Prev");
      if (typeof prev === "number") pending.push(prev);
    }
    return { xref, trailer: mergeTrailers(trailers) };
  }

  private readXrefSection(offset: number): { entries: Map<number, XrefEntry>; trailer: PdfDict } {
    const lexer = new Lexer(this.bytes, offset);
    const save = lexer.pos;
    const first = lexer.next();
    if (first.kind === "keyword" && first.word === "xref") return this.readXrefTable(lexer);
    lexer.pos = save;
    return this.readXrefStream(offset);
  }

  private readXrefTable(lexer: Lexer): { entries: Map<number, XrefEntry>; trailer: PdfDict } {
    const entries = new Map<number, XrefEntry>();
    const parser = new Parser(lexer);
    for (;;) {
      const startTok = parser.item();
      if (isKeyword(startTok) && startTok.word === "trailer") break;
      const countTok = parser.item();
      if (typeof startTok !== "number" || typeof countTok !== "number") {
        throw new PdfSyntaxError("malformed xref subsection", lexer.pos);
      }
      let start = startTok;
      for (let i = 0; i < countTok; i++) {
        const offset = parser.item();
        const gen = parser.item();
        const type = parser.item();
        if (typeof offset !== "number" || typeof gen !== "number" || !isKeyword(type)) {
          throw new PdfSyntaxError("malformed xref entry", lexer.pos);
        }
        // a common writer bug numbers the first subsection from 1 instead of 0
        if (i === 0 && start === 1 && offset === 0 && gen === 65535 && type.word === "f") start = 0;
        const num = start + i;
        if (entries.has(num)) continue;
        entries.set(num, type.word === "n" && offset > 0 ? { _tag: "Offset", offset, gen } : { _tag: "Free" });
      }
    }
    const trailer = parser.object();
    if (!isDict(trailer)) throw new PdfSyntaxError("trailer is not a dictionary", lexer.pos);
    return { entries, trailer };
  }

  private readXrefStream(offset: number): { entries: Map<number, XrefEntry>; trailer: PdfDict } {
    const { object } = this.parserAt(offset).indirect();
    if (!isStream(object) || !isName(object.dict.entries.get("Type"), "XRef")) {
      throw new PdfSyntaxError("expected an xref table or stream", offset);
    }
    const dict = object.dict;
    const w = dict.entries.get("W");
    if (!isArray(w) || w.items.length < 3) throw new PdfSyntaxError("xref stream without /W", offset);
    const widths = w.items.map((x) => (typeof x === "number" ? x : 0));
    const size = typeof dict.entries.get("Size") === "number" ? (dict.entries.get("Size") as number) : 0;
    const indexObj = dict.entries.get("Index");
    const index = isArray(indexObj) ? indexObj.items.map((x) => (typeof x === "number" ? x : 0)) : [0, size];
    const data = decodeFilters(dict, object.data).data;
    const rowLength = widths[0]! + widths[1]! + widths[2]!;
    const field = (pos: number, width: number): number => {
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + data[pos + i]!;
      return v;
    };
    const entries = new Map<number, XrefEntry>();
    let pos = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      const start = index[s]!;
      const count = index[s + 1]!;
      for (let i = 0; i < count && pos + rowLength <= data.length; i++, pos += rowLength) {
        const type = widths[0] === 0 ? 1 : field(pos, widths[0]!);
        const f2 = field(pos + widths[0]!, widths[1]!);
        const f3 = field(pos + widths[0]! + widths[1]!, widths[2]!);
        const num = start + i;
        if (entries.has(num)) continue;
        if (type === 1) entries.set(num, { _tag: "Offset", offset: f2, gen: f3 });
        else if (type === 2) entries.set(num, { _tag: "Compressed", stream: f2, index: f3 });
        else entries.set(num, { _tag: "Free" });
      }
    }
    return { entries, trailer: dict };
  }

  // ==========================================================================
  // Reconstruction
  // ==========================================================================

  /** Rebuild the cross-reference data by scanning the whole file. */
  private rebuild(): { xref: Map<number, XrefEntry>; trailer: PdfDict } {
    const bytes = this.bytes;
    const xref = new Map<number, XrefEntry>();
    const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 0x30 && c <= 0x39;
    for (let at = indexOf(bytes, OBJ); at >= 0; at = indexOf(bytes, OBJ, at + 3)) {
      // `obj` must end a token: `n g obj` followed by a delimiter
      const after = bytes[at + 3];
      if (after !== undefined && !isWhitespace(after) && after !== 0x3c && after !== 0x5b && after !== 0x2f && after !== 0x25 && after !== 0x28) continue;
      let p = at - 1;
      if (!isWhitespace(bytes[p] ?? 0x41)) continue;
      while (p >= 0 && isWhitespace(bytes[p]!)) p--;
      const genEnd = p + 1;
      while (p >= 0 && isDigit(bytes[p])) p--;
      if (p + 1 === genEnd || !isWhitespace(bytes[p] ?? 0x41)) continue;
      const gen = Number(String.fromCharCode(...bytes.subarray(p + 1, genEnd)));
      while (p >= 0 && isWhitespace(bytes[p]!)) p--;
      const numEnd = p + 1;
      while (p >= 0 && isDigit(bytes[p])) p--;
      if (p + 1 === numEnd) continue;
      if (p >= 0 && !isWhitespace(bytes[p]!) && bytes[p] !== 0x3e && bytes[p] !== 0x29 && bytes[p] !== 0x5d && bytes[p] !== 0x7d) continue;
      const num = Number(String.fromCharCode(...bytes.subarray(p + 1, numEnd)));
      xref.set(num, { _tag: "Offset", offset: p + 1, gen }); // later definitions win
    }

    const previous = this.xref;
    this.xref = xref;
    this.cache.clear();
    this.objectStreams.clear();

    const trailers: PdfDict[] = [];
    for (let at = indexOf(bytes, TRAILER); at >= 0; at = indexOf(bytes, TRAILER, at + TRAILER.length)) {
      try {
        const t = new Parser(new Lexer(bytes, at + TRAILER.length)).object();
        if (isDict(t)) trailers.unshift(t);
      } catch {
        // not a trailer after all
      }
    }
    // members of object streams, and xref streams' trailer dictionaries
    for (const [num] of [...xref]) {
      const o = this.get(num);
      if (!isStream(o)) continue;
      if (isName(o.dict.entries.get("Type"), "ObjStm")) {
        try {
          const n = typeof o.dict.entries.get("N") === "number" ? (o.dict.entries.get("N") as number) : 0;
          const header = new Parser(new Lexer(this.decode(o).data));
          for (let i = 0; i < n; i++) {
            const objNum = header.object();
            header.object();
            if (typeof objNum === "number" && !xref.has(objNum)) xref.set(objNum, { _tag: "Compressed", stream: num, index: i });
          }
        } catch {
          // skip an undecodable object stream
        }
      } else if (isName(o.dict.entries.get("Type"), "XRef")) {
        trailers.unshift(o.dict);
      }
    }
    let trailer = mergeTrailers(trailers);
    if (!isDict(this.resolve(trailer.entries.get("Root")))) {
      // find the catalog ourselves
      for (const [num] of xref) {
        const o = this.get(num);
        if (isDict(o) && isName(o.entries.get("Type"), "Catalog")) {
          const entries = new Map(trailer.entries);
          entries.set("Root", { _tag: "Ref", num, gen: 0 });
          trailer = pdfDict(entries);
          break;
        }
      }
    }
    this.xref = previous;
    this.cache.clear();
    return { xref, trailer };
  }

  // ==========================================================================
  // Pages
  // ==========================================================================

  /** The document's pages, in order, with inherited attributes resolved. */
  pages(): PdfPage[] {
    const out: PdfPage[] = [];
    const visited = new Set<PdfDict>();
    const walk = (node: PdfObject | undefined, inherited: { resources?: PdfDict | undefined; mediaBox?: PdfObject | undefined; rotate?: number | undefined }, depth: number): void => {
      const ref = isRef(node) ? node : undefined;
      const dict = dictOf(this.resolve(node));
      if (dict === undefined || visited.has(dict) || depth > 64) return;
      visited.add(dict);
      const resources = this.lookupDict(dict, "Resources") ?? inherited.resources;
      const mediaBox = dict.entries.get("MediaBox") ?? inherited.mediaBox;
      const rotate = this.lookupNumber(dict, "Rotate") ?? inherited.rotate;
      const kids = this.lookupArray(dict, "Kids");
      const type = this.lookupName(dict, "Type");
      if (type === "Pages" || (type !== "Page" && kids !== undefined)) {
        for (const kid of kids?.items ?? []) walk(kid, { resources, mediaBox, rotate }, depth + 1);
        return;
      }
      out.push({
        dict,
        ref,
        resources: resources ?? pdfDict(),
        mediaBox: this.box(mediaBox),
        rotate: (((rotate ?? 0) % 360) + 360) % 360,
      });
    };
    walk(this.catalog.entries.get("Pages"), {}, 0);
    return out;
  }

  private box(o: PdfObject | undefined): readonly [number, number, number, number] {
    const a = this.resolve(o);
    if (!isArray(a) || a.items.length < 4) return DEFAULT_MEDIA_BOX;
    const [x0, y0, x1, y1] = a.items.slice(0, 4).map((v) => {
      const n = this.resolve(v);
      return typeof n === "number" ? n : 0;
    }) as [number, number, number, number];
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
  }
}

/** Merge trailers, newest first: an older trailer only fills keys the newer ones lack. */
const mergeTrailers = (trailers: ReadonlyArray<PdfDict>): PdfDict => {
  const entries = new Map<string, PdfObject>();
  for (const t of trailers) {
    for (const [k, v] of t.entries) {
      if (k === "Prev" || k === "XRefStm" || k === "Type" || k === "W" || k === "Index" || k === "Filter" || k === "DecodeParms" || k === "Length") continue;
      if (!entries.has(k)) entries.set(k, v);
    }
  }
  return pdfDict(entries);
};
