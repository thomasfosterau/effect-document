/**
 * Mutation fuzzing (#135): every reader, fed seeded mutations of a valid file
 * of its format, ends in `Success` or a typed `ParseError`, never a defect.
 * Zip-based formats are mutated inside an entry (the XML or IWA), not in the
 * zip's own bytes, so the corruption reaches the reader rather than the CRC
 * check. A failing case names its format, seed and mutation, so it replays.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";
import {
  blocksToText,
  bulletList,
  bytes,
  cell,
  type Content,
  document,
  type Document,
  header,
  link,
  para,
  type ParseError,
  slide,
  slideShow,
  str,
  strong,
  table,
  text,
  textBox,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Keynote } from "@thomasfosterau/effect-document/iwork";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

/**
 * How many mutations each format gets on every test run: enough to catch a
 * regression cheaply (about 4 s in all). A longer run (3,000 a format) found
 * nothing more when the suite was added.
 */
const RUNS = 150;

/** A draw below `below` from a seeded Lehmer generator, so a failing seed replays. */
type Rng = (below: number) => number;

const rng = (seed: number): Rng => {
  let state = (seed % 2147483646) + 1;
  return (below) => {
    state = (state * 48271) % 2147483647;
    return state % below;
  };
};

/** A mutated input and what was done to it. */
interface Mutation {
  readonly out: Uint8Array;
  readonly what: string;
}

/** A slice length at `at`: 1 to 64 bytes, within `b`. */
const sliceLength = (b: Uint8Array, at: number, r: Rng): number =>
  1 + r(Math.max(1, Math.min(64, b.length - at)));

/** The mutations: flip bits, truncate, insert junk, duplicate a slice, delete a slice. */
const MUTATIONS: ReadonlyArray<(b: Uint8Array, at: number, r: Rng) => Mutation> = [
  (b, _, r) => {
    const flips = 1 + r(8);
    const out = Arr.makeBy(flips, () => [r(Math.max(1, b.length)), 1 << r(8)] as const).reduce(
      (acc, [i, bit]) => {
        acc[i] = (acc[i] ?? 0) ^ bit;
        return acc;
      },
      b.slice(),
    );
    return { out, what: `flip ${flips}` };
  },
  (b, at) => ({ out: b.slice(0, at), what: `truncate at ${at}` }),
  (b, at, r) => {
    const junk = Uint8Array.from({ length: 1 + r(16) }, () => r(256));
    return {
      out: Uint8Array.from([...b.subarray(0, at), ...junk, ...b.subarray(at)]),
      what: `insert ${junk.length} at ${at}`,
    };
  },
  (b, at, r) => {
    const len = sliceLength(b, at, r);
    return {
      out: Uint8Array.from([...b.subarray(0, at + len), ...b.subarray(at)]),
      what: `duplicate ${len} at ${at}`,
    };
  },
  (b, at, r) => {
    const len = sliceLength(b, at, r);
    return {
      out: Uint8Array.from([...b.subarray(0, at), ...b.subarray(at + len)]),
      what: `delete ${len} at ${at}`,
    };
  },
];

/** One seeded mutation of `b`. */
const mutate = (b: Uint8Array, r: Rng): Mutation => {
  const at = r(Math.max(1, b.length));
  const pick = MUTATIONS[r(MUTATIONS.length)] ?? MUTATIONS[0];
  return pick === undefined ? { out: b, what: "none" } : pick(b, at, r);
};

/** One seeded mutation inside one entry of a zip, re-zipped. */
const mutateZip = (b: Uint8Array, r: Rng): Mutation => {
  const files = unzipSync(b);
  const names = Object.getOwnPropertyNames(files).filter((n) => !n.endsWith("/"));
  const name = names[r(names.length)] ?? "";
  const inner = mutate(files[name] ?? new Uint8Array(), r);
  return { out: zipSync({ ...files, [name]: inner.out }), what: `${name}: ${inner.what}` };
};

/** Content's bytes. */
const bytesOf = (c: Content): Uint8Array =>
  Predicate.isTagged(c, "Bytes") ? c.bytes : strToU8(c.text);

interface Case {
  readonly format: string;
  readonly read: (c: Content) => Effect.Effect<Document, ParseError>;
  /** A valid file of the format; a failure to make it is a defect of the test. */
  readonly sample: Effect.Effect<Uint8Array, never, FileSystem.FileSystem | Path.Path>;
  /** Whether to mutate inside a zip entry. */
  readonly zip: boolean;
  /** Whether the reader takes text. */
  readonly asText: boolean;
}

const PROSE = document([
  header(1, [str("Title")]),
  para([
    str("Some "),
    strong([str("bold")]),
    str(" text and "),
    link([str("a link")], "https://example.com"),
  ]),
  bulletList([[para([str("one")])], [para([str("two")])]]),
  table({ headers: ["A", "B"], rows: [[[para([str("1")])], [para([str("2")])]]] }),
]);
const SHEET = document([
  worksheet("S", [
    [cell.text("h"), cell.number(1)],
    [cell.boolean(true), cell.text("x")],
  ]),
]);
const DECK = document([
  slideShow([slide([textBox([para([str("Slide one")])])]), slide([textBox([para([str("two")])])])]),
]);

/** A vendored iWork fixture. */
const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFile(
      yield* path.fromFileUrl(
        new URL(`../../packages/core/test/iwork/fixtures/${name}`, import.meta.url),
      ),
    );
  }).pipe(Effect.orDie);

const CASES: ReadonlyArray<Case> = [
  {
    format: "csv",
    read: Csv.makeCsvReader().read,
    sample: Effect.succeed(strToU8('a,b,"c ""q"""\n1,2.5,true\n,x,"multi\nline"\n')),
    zip: false,
    asText: true,
  },
  {
    format: "rtf",
    read: Rtf.makeRtfReader().read,
    sample: Effect.orDie(Effect.map(Rtf.makeRtfWriter().write(trustAs(PROSE)), bytesOf)),
    zip: false,
    asText: true,
  },
  {
    format: "pdf",
    read: Pdf.makePdfReader().read,
    sample: Effect.orDie(Effect.map(Pdf.makePdfWriter().write(trustAs(PROSE)), bytesOf)),
    zip: false,
    asText: false,
  },
  {
    format: "docx",
    read: Docx.makeDocxReader().read,
    sample: Effect.orDie(Effect.map(Docx.makeDocxWriter().write(trustAs(PROSE)), bytesOf)),
    zip: true,
    asText: false,
  },
  {
    format: "xlsx",
    read: Xlsx.makeXlsxReader().read,
    sample: Effect.orDie(Effect.map(Xlsx.makeXlsxWriter().write(trustAs(SHEET)), bytesOf)),
    zip: true,
    asText: false,
  },
  {
    format: "pptx",
    read: Pptx.makePptxReader().read,
    sample: Effect.orDie(Effect.map(Pptx.makePptxWriter().write(trustAs(DECK)), bytesOf)),
    zip: true,
    asText: false,
  },
  {
    format: "keynote",
    read: Keynote.makeKeynoteReader().read,
    sample: fixture("simple-oneslide.key"),
    zip: true,
    asText: false,
  },
];

/** The defect, if reading one seeded mutation of `sample` dies, described so it replays. */
const defectAt = (c: Case, sample: Uint8Array, seed: number) => {
  const r = rng(seed);
  const { out, what } = c.zip ? mutateZip(sample, r) : mutate(sample, r);
  const input = c.asText ? text(new TextDecoder().decode(out)) : bytes(out);
  return Effect.map(Effect.exit(Effect.suspend(() => c.read(input))), (exit) =>
    Exit.isFailure(exit) && Cause.hasDies(exit.cause)
      ? [`seed ${seed} (${what}): ${Cause.pretty(exit.cause).split("\n").slice(0, 3).join(" | ")}`]
      : [],
  );
};

describe("mutation fuzzing (#135)", () => {
  test.each(CASES)(
    "$format: every mutated input reads or fails with a ParseError",
    async (c) => {
      const defects = await Effect.runPromise(
        Effect.gen(function* () {
          const sample = yield* c.sample;
          const found = yield* Effect.forEach(
            Arr.range(0, RUNS - 1),
            (seed) => defectAt(c, sample, seed),
            {
              concurrency: 1,
            },
          );
          return found.flat();
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(defects).toEqual([]);
    },
    120_000,
  );
});

/** A DOCX whose document part declares a billion-laughs entity chain and uses it. */
const BILLION_LAUGHS = (() => {
  const levels = Arr.makeBy(10, (i) =>
    i === 0 ? `<!ENTITY lol0 "lol">` : `<!ENTITY lol${i} "${`&lol${i - 1};`.repeat(10)}">`,
  ).join("");
  const xml = `<?xml version="1.0"?><!DOCTYPE w:document [${levels}]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lol9;</w:t></w:r></w:p></w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(xml),
  });
})();

describe("known-bad inputs (#135)", () => {
  test("billion-laughs XML is never expanded: it fails or reads small, quickly", async () => {
    const started = performance.now();
    const exit = await Effect.runPromiseExit(Docx.makeDocxReader().read(bytes(BILLION_LAUGHS)));
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    // a failure reads as nothing; a success must not hold the 3 × 10⁹ characters an expansion would
    const textLength = Exit.match(exit, {
      onSuccess: (doc) => blocksToText(doc.blocks).length,
      onFailure: () => 0,
    });
    expect(textLength).toBeLessThan(100_000);
  });
});
