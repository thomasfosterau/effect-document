/**
 * Interoperability with independent implementations (#134): what our writers
 * produce must open in other tools.
 *
 * - LibreOffice (headless) converts the DOCX, XLSX, PPTX and RTF sample of
 *   every feature each writer accepts to PDF; a crash, a missing PDF or one
 *   without the sample's text fails.
 * - `qpdf --check` passes on every PDF sample, and `pdftotext` finds every
 *   word of the sample's text in it.
 * - `pandoc` reads every DOCX sample and finds every word of its text.
 *
 * The tools are not dependencies: this suite runs in CI's optional `interop`
 * job, which installs them. Elsewhere a missing tool skips its tests, unless
 * `INTEROP=1` asks for all of them (the job sets it).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect, test } from "vite-plus/test";
import { blocksToText, type Document } from "@thomasfosterau/effect-document";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-ooxml";
import { makePdfWriter } from "@thomasfosterau/effect-pdf";
import { makeRtfWriter } from "@thomasfosterau/effect-rtf";
import { type AnyWriter, type Family, type WrittenSample, writeSamples } from "../samples.ts";

/** The external tools, each with the arguments that print its version. */
const TOOLS = {
  soffice: ["--version"],
  qpdf: ["--version"],
  pdftotext: ["-v"],
  pandoc: ["--version"],
} satisfies Record<string, ReadonlyArray<string>>;
type Tool = keyof typeof TOOLS;

/** Which tools run here, and whether every one is required (`INTEROP` set). */
const environment = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const found = yield* Effect.forEach(
    Rec.keys(TOOLS),
    (tool) =>
      spawner.exitCode(ChildProcess.make(tool, TOOLS[tool])).pipe(
        Effect.map((code) => [tool, code === 0] as const),
        Effect.orElseSucceed(() => [tool, false] as const),
      ),
    { concurrency: "unbounded" },
  );
  const required = Option.isSome(yield* Config.option(Config.String("INTEROP")));
  const available: ReadonlyArray<Tool> = found.filter(([, ok]) => ok).map(([tool]) => tool);
  return { available, required };
}).pipe(Effect.provide(NodeServices.layer));

const { available, required } = await Effect.runPromise(environment);
const skip = (...tools: ReadonlyArray<Tool>): boolean =>
  !required && !tools.every((t) => available.includes(t));

/** The words of a document's text, for checking another tool recovered it. */
const wordsOf = (doc: Document): ReadonlyArray<string> =>
  Arr.dedupe(
    blocksToText(doc.blocks)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w !== ""),
  );

/** The sample's words missing from `text`, as `<feature>: <word>` messages. */
const missingWords = (sample: WrittenSample, text: string): ReadonlyArray<string> =>
  wordsOf(sample.doc)
    // case-blind: spreadsheet applications show booleans as TRUE / FALSE
    .filter((word) => !text.toLowerCase().includes(word.toLowerCase()))
    .map((word) => `${sample.feature}: "${word}" missing`);

/** Run a tool, returning its standard output and error together. */
const run = (tool: Tool, args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make(tool, args), { includeStderr: true }),
  );

/** Write each sample to `dir` as `<feature>.<extension>`, returning the paths in order. */
const writeFiles = (dir: string, extension: string, samples: ReadonlyArray<WrittenSample>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.forEach(
      samples,
      (sample) => {
        const file = path.join(dir, `${sample.feature}.${extension}`);
        return Effect.as(fs.writeFile(file, sample.bytes), file);
      },
      { concurrency: 8 },
    );
  });

/** Run an Effect needing the Node services and a scope, as a test does. */
const runTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)));

/** The office formats LibreOffice is asked to open, with the writer and family each sample is made for. */
const OFFICE: ReadonlyArray<{
  readonly extension: string;
  readonly writer: AnyWriter;
  readonly family: Family;
}> = [
  { extension: "docx", writer: Docx.makeDocxWriter(), family: "prose" },
  { extension: "xlsx", writer: Xlsx.makeXlsxWriter(), family: "sheet" },
  { extension: "pptx", writer: Pptx.makePptxWriter(), family: "deck" },
  { extension: "rtf", writer: makeRtfWriter(), family: "prose" },
];

describe.skipIf(skip("soffice", "pdftotext"))("LibreOffice opens our output", () => {
  test.each(OFFICE)(
    "$extension: every feature sample converts to a PDF with its text",
    async ({ extension, writer, family }) => {
      const problems = await runTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: `interop-${extension}-` });
          const samples = yield* writeSamples(writer, family);
          // LibreOffice given no files waits for input instead of exiting
          if (Arr.isReadonlyArrayEmpty(samples)) return [`${extension}: no samples written`];
          const files = yield* writeFiles(dir, extension, samples);
          const out = path.join(dir, "pdf");
          // one LibreOffice process for the whole batch; a separate profile
          // directory keeps it from colliding with a running instance
          yield* run("soffice", [
            `-env:UserInstallation=file://${path.join(dir, "profile")}`,
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            out,
            ...files,
          ]);
          const perSample = yield* Effect.forEach(
            samples,
            (sample) =>
              Effect.gen(function* () {
                const pdf = path.join(out, `${sample.feature}.pdf`);
                if (!(yield* fs.exists(pdf))) return [`${sample.feature}: no PDF`];
                const text = yield* run("pdftotext", ["-layout", pdf, "-"]);
                return missingWords(sample, text);
              }),
            { concurrency: 4 },
          );
          return perSample.flat();
        }),
      );
      expect(problems).toEqual([]);
    },
    180_000,
  );
});

describe.skipIf(skip("qpdf", "pdftotext"))("PDF output passes qpdf and pdftotext", () => {
  test("every feature sample is a valid PDF holding its text", async () => {
    const problems = await runTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "interop-pdf-" });
        const samples = yield* writeSamples(makePdfWriter(), "prose");
        const files = yield* writeFiles(dir, "pdf", samples);
        const perSample = yield* Effect.forEach(
          Arr.zip(samples, files),
          ([sample, file]) =>
            Effect.gen(function* () {
              const check = yield* run("qpdf", ["--check", file]);
              const checked = /No syntax or stream encoding errors found/.test(check)
                ? []
                : [`${sample.feature}: qpdf --check: ${check.trim()}`];
              const text = yield* run("pdftotext", [file, "-"]);
              return [...checked, ...missingWords(sample, text)];
            }),
          { concurrency: 4 },
        );
        return perSample.flat();
      }),
    );
    expect(problems).toEqual([]);
  });
});

describe.skipIf(skip("pandoc"))("pandoc reads our DOCX", () => {
  test("every feature sample's text comes back", async () => {
    const problems = await runTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "interop-pandoc-" });
        const samples = yield* writeSamples(Docx.makeDocxWriter(), "prose");
        const files = yield* writeFiles(dir, "docx", samples);
        const perSample = yield* Effect.forEach(
          Arr.zip(samples, files),
          ([sample, file]) =>
            Effect.map(run("pandoc", ["--from", "docx", "--to", "plain", file]), (text) =>
              missingWords(sample, text),
            ),
          { concurrency: 4 },
        );
        return perSample.flat();
      }),
    );
    expect(problems).toEqual([]);
  });
});
