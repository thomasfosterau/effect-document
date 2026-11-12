/**
 * Corpus smoke mode (#133): every reader over every file of its format in the
 * fetched corpora (`corpora.json`, fetched by `vp run corpora:fetch` into
 * `.corpora/`). A reader may reject a file with a `ParseError`; it must never
 * die (a defect, #127) or hang past the timeout. The suite skips when no
 * corpus has been fetched. Read rates per format, and every rejected file with
 * its reason, go to `.corpora/report.json` and the console.
 */
import { layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import { bytes, type Content, detect, type ParseError } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { makeCsvReader } from "@thomasfosterau/effect-document/csv";
import { Keynote, Numbers, Pages } from "@thomasfosterau/effect-document/iwork";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import { makePdfReader } from "@thomasfosterau/effect-document/pdf";
import * as Rtf from "@thomasfosterau/effect-document/rtf";
import { makeRtfReader } from "@thomasfosterau/effect-document/rtf";

/** What the smoke run needs of a reader, whatever its profile. */
interface AnyReader {
  readonly read: (input: Content) => Effect.Effect<unknown, ParseError>;
}

/** The reader for each file extension the corpora hold. */
const READERS = {
  csv: makeCsvReader,
  xlsx: Xlsx.makeXlsxReader,
  docx: Docx.makeDocxReader,
  pptx: Pptx.makePptxReader,
  pdf: makePdfReader,
  rtf: makeRtfReader,
  numbers: Numbers.makeNumbersReader,
  pages: Pages.makePagesReader,
  key: Keynote.makeKeynoteReader,
} satisfies Record<string, () => AnyReader>;

type Format = keyof typeof READERS;

/** Every format `detect` chooses among (#188), and the one each extension should be detected as. */
const DETECTABLE = [
  Csv.format,
  Csv.tsvFormat,
  Xlsx.format,
  Docx.format,
  Pptx.format,
  Pdf.format,
  Rtf.format,
  Numbers.format,
  Pages.format,
  Keynote.format,
];
const EXPECTED_FORMAT: Record<Format, string> = {
  csv: "csv",
  xlsx: "xlsx",
  docx: "docx",
  pptx: "pptx",
  pdf: "pdf",
  rtf: "rtf",
  numbers: "numbers",
  pages: "pages",
  key: "keynote",
};

const FORMATS: ReadonlyArray<string> = Rec.keys(READERS);
const isFormat = (extension: string): extension is Format => FORMATS.includes(extension);

/** How long one read may take before it counts as a hang. */
const TIMEOUT = Duration.seconds(20);

const Manifest = Schema.Struct({
  corpora: Schema.Array(Schema.Struct({ id: Schema.String, commit: Schema.String })),
});

interface CorpusFile {
  /** `<corpus>/<path inside it>`, the test's name. */
  readonly name: string;
  readonly path: string;
  readonly format: Format;
}

/** The files with a known extension in one corpus directory, sorted by path. */
const filesIn = (id: string, dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = Arr.sort(yield* fs.readDirectory(dir, { recursive: true }), Order.String);
    const found = yield* Effect.forEach(
      entries,
      (entry) => {
        const format = path.extname(entry).slice(1).toLowerCase();
        const full = path.join(dir, entry);
        if (!isFormat(format)) return Effect.succeed(Option.none<CorpusFile>());
        // iWork packages saved as directories are skipped: readers take bytes
        return Effect.map(fs.stat(full), (info) =>
          info.type === "File"
            ? Option.some<CorpusFile>({ name: `${id}/${entry}`, path: full, format })
            : Option.none(),
        );
      },
      { concurrency: 16 },
    );
    return Arr.getSomes(found);
  });

/**
 * Whether the dialect `Csv.sniffDialect` finds in `text`'s sample agrees with
 * a scan of the whole text in that dialect: the scan succeeds, and the share
 * of its rows at their most common width is at least the sniff's confidence
 * (the share of sampled lines it saw at that width). The reason when not.
 */
const dialectAgreement = (text: string) =>
  Effect.gen(function* () {
    const sniffed = yield* Csv.sniffDialect(text);
    if (Option.isNone(sniffed)) return Option.some("no dialect sniffed");
    const { options, confidence } = sniffed.value;
    const scanned = yield* Effect.option(
      Csv.scanCsv(text, options.dialect, { skipRows: options.skipRows }),
    );
    if (Option.isNone(scanned))
      return Option.some("the whole-file scan in the sniffed dialect failed");
    const widths = scanned.value.rows.map((row) => row.length);
    const modal = Math.max(0, ...widths.map((w) => widths.filter((x) => x === w).length));
    const even = Arr.isReadonlyArrayEmpty(widths) ? 1 : modal / widths.length;
    return even + 1e-9 >= confidence
      ? Option.none()
      : Option.some(
          `separator ${options.dialect.separator === "\t" ? "tab" : `"${options.dialect.separator}"`}: ${Math.round(even * 100)}% of the whole file's rows at one width, the sample ${Math.round(confidence * 100)}%`,
        );
  });

/** The tallies a smoke run keeps, written to `.corpora/report.json` when the suite ends. */
interface Tallies {
  /** Files read and rejected, per format. */
  readonly counts: Record<string, { read: number; rejected: number }>;
  /** Files `detect` ranked right first, per format (#188). */
  readonly detected: Record<string, number>;
  /** The files `detect` did not rank as their format first: what it ranked first instead, if anything. */
  readonly misdetections: Array<{ readonly file: string; readonly detected: string }>;
  /** The files a reader rejected, and why: candidates for a reader fix or a known-bad note. */
  readonly rejections: Array<{ readonly file: string; readonly reason: string }>;
  /** CSV files whose sniffed dialect (from the sample) a scan of the whole file agrees with, and those where it doesn't: no dialect sniffed, the whole-file scan failing, or its rows less even than the sample promised (#188 §3). */
  readonly dialects: {
    agreed: number;
    readonly disagreements: Array<{ readonly file: string; readonly reason: string }>;
  };
}

/**
 * Every corpus file, from the corpora fetched at their pins, with the tallies
 * of the run. Releasing the layer (the end of the suite) prints the read rates
 * and writes the report, unless no corpus has been fetched.
 */
class Corpus extends Context.Service<
  Corpus,
  { readonly files: ReadonlyArray<CorpusFile>; readonly tallies: Tallies }
>()("test/Corpus") {
  static readonly layer = Layer.effect(
    Corpus,
    Effect.fn("Corpus.layer")(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
      const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
        yield* fs.readFileString(path.join(root, "corpora.json")),
      );
      const perCorpus = yield* Effect.forEach(
        manifest.corpora,
        (corpus) => {
          const dir = path.join(root, ".corpora", corpus.id, corpus.commit);
          return Effect.flatMap(fs.exists(path.join(dir, ".fetched")), (fetched) =>
            fetched ? filesIn(corpus.id, dir) : Effect.succeed([]),
          );
        },
        { concurrency: 1 },
      );
      const files = Arr.flatten(perCorpus);
      const tallies: Tallies = {
        counts: {},
        detected: {},
        misdetections: [],
        rejections: [],
        dialects: { agreed: 0, disagreements: [] },
      };
      const report = Effect.fn("Corpus.report")(function* () {
        const formats = Rec.map(tallies.counts, ({ read, rejected }, format) => ({
          files: read + rejected,
          read,
          rejected,
          readRate: Math.round((read / (read + rejected)) * 1000) / 1000,
          detectRate:
            Math.round(((tallies.detected[format] ?? 0) / (read + rejected)) * 1000) / 1000,
        }));
        yield* Console.table(formats);
        const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
          formats,
          rejections: Arr.sort(
            tallies.rejections,
            Order.mapInput(Order.String, (r: { readonly file: string }) => r.file),
          ),
          misdetections: Arr.sort(
            tallies.misdetections,
            Order.mapInput(Order.String, (r: { readonly file: string }) => r.file),
          ),
          dialects: tallies.dialects,
        });
        yield* fs.writeFileString(path.join(root, ".corpora", "report.json"), `${json}\n`);
      });
      yield* Effect.addFinalizer(() =>
        Arr.isReadonlyArrayEmpty(files) ? Effect.void : Effect.orDie(report()),
      );
      return { files, tallies };
    })(),
  );
}

const reasonOf = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => Cause.pretty(cause),
    onSome: (e) => (Predicate.hasProperty(e, "reason") ? String(e.reason) : String(e)),
  });

/** How long one format's files may take in all. */
const TEST_TIMEOUT = Duration.toMillis(Duration.minutes(30));

/**
 * Reads one corpus file, tallies the outcome, and gives the problem found
 * with it, if any: a defect is a reader bug, a timeout a hang.
 */
const smoke = (tallies: Tallies, { name, path, format }: CorpusFile) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const reader: AnyReader = READERS[format]();
        const data = yield* fs.readFile(path);
        // detection never fails: a wrong guess is recorded, not a test failure
        const [best] = yield* detect(bytes(data), { formats: DETECTABLE });
        if (best?.format.id === EXPECTED_FORMAT[format])
          tallies.detected[format] = (tallies.detected[format] ?? 0) + 1;
        else tallies.misdetections.push({ file: name, detected: best?.format.id ?? "nothing" });
        if (format === "csv") {
          const disagreement = yield* dialectAgreement(new TextDecoder().decode(data));
          if (Option.isSome(disagreement))
            tallies.dialects.disagreements.push({ file: name, reason: disagreement.value });
          else tallies.dialects.agreed++;
        }
        return yield* reader.read(bytes(data)).pipe(Effect.timeout(TIMEOUT));
      }),
    );
    const tally = (tallies.counts[format] ??= { read: 0, rejected: 0 });
    if (Exit.isSuccess(exit)) {
      tally.read++;
      return [];
    }
    const cause = exit.cause;
    tally.rejected++;
    tallies.rejections.push({ file: name, reason: reasonOf(cause) });
    if (Cause.hasDies(cause)) return [`${name}: a defect: ${Cause.pretty(cause)}`];
    if (Option.exists(Cause.findErrorOption(cause), Cause.isTimeoutError))
      return [`${name}: timed out`];
    return [];
  });

layer(Corpus.layer.pipe(Layer.provideMerge(NodeServices.layer)))("corpus smoke", (it) => {
  it.effect.each(Rec.keys(READERS))(
    "every .%s file reads or fails with a ParseError, without a defect or a hang",
    (format, ctx) =>
      Effect.gen(function* () {
        const { files, tallies } = yield* Corpus;
        const ofFormat = files.filter((file) => file.format === format);
        ctx.skip(Arr.isReadonlyArrayEmpty(ofFormat));
        const problems = yield* Effect.forEach(ofFormat, (file) => smoke(tallies, file), {
          concurrency: 1,
        });
        expect(problems.flat()).toEqual([]);
      }),
    TEST_TIMEOUT,
  );
});
