/**
 * Corpus smoke mode (#133): every reader over every file of its format in the
 * fetched corpora (`corpora.json`, fetched by `vp run corpora:fetch` into
 * `.corpora/`). A reader may reject a file with a `ParseError`; it must never
 * die (a defect, #127) or hang past the timeout. The suite skips when no
 * corpus has been fetched. Read rates per format, and every rejected file with
 * its reason, go to `.corpora/report.json` and the console.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { bytes, type Content, type ParseError } from "@thomasfosterau/effect-document";
import { makeCsvReader } from "@thomasfosterau/effect-csv";
import { Keynote, Numbers, Pages } from "@thomasfosterau/effect-iwork";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-ooxml";
import { makePdfReader } from "@thomasfosterau/effect-pdf";
import { makeRtfReader } from "@thomasfosterau/effect-rtf";

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

/** Every corpus file, from the corpora fetched at their pins. */
const corpusFiles = Effect.gen(function* () {
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
  return { root, files: Arr.flatten(perCorpus) };
}).pipe(Effect.provide(NodeServices.layer));

const { root, files } = await Effect.runPromise(corpusFiles);

/** Files read and rejected, per format. */
const counts: Record<string, { read: number; rejected: number }> = {};
/** The files a reader rejected, and why: candidates for a reader fix or a known-bad note. */
const rejections: Array<{ readonly file: string; readonly reason: string }> = [];

const reasonOf = (cause: Cause.Cause<unknown>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => Cause.pretty(cause),
    onSome: (e) => (Predicate.hasProperty(e, "reason") ? String(e.reason) : String(e)),
  });

describe.skipIf(Arr.isReadonlyArrayEmpty(files))("corpus smoke", () => {
  test.each(files)("$name", async ({ name, path, format }) => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const reader: AnyReader = READERS[format]();
        const data = yield* fs.readFile(path);
        return yield* reader.read(bytes(data)).pipe(Effect.timeout(TIMEOUT));
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const tally = (counts[format] ??= { read: 0, rejected: 0 });
    if (Exit.isSuccess(exit)) {
      tally.read++;
      return;
    }
    const cause = exit.cause;
    // a defect is a reader bug; a timeout is a hang
    expect(Cause.hasDies(cause), Cause.pretty(cause)).toBe(false);
    expect(Option.exists(Cause.findErrorOption(cause), Cause.isTimeoutError), "timed out").toBe(
      false,
    );
    tally.rejected++;
    rejections.push({ file: name, reason: reasonOf(cause) });
  });

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const formats = Rec.map(counts, ({ read, rejected }) => ({
          files: read + rejected,
          read,
          rejected,
          readRate: Math.round((read / (read + rejected)) * 1000) / 1000,
        }));
        yield* Console.table(formats);
        const report = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
          formats,
          rejections: Arr.sort(
            rejections,
            Order.mapInput(Order.String, (r: { readonly file: string }) => r.file),
          ),
        });
        yield* fs.writeFileString(path.join(root, ".corpora", "report.json"), `${report}\n`);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
