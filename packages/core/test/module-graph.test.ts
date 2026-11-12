/**
 * The import graph of each entry point, walked through `src/`: which of the
 * package's dependencies a consumer loads by importing that subpath. The core
 * entries reach none of `fflate`, `@thomasfosterau/effect-ext` (only
 * `/encoding` does) and the optional `@thomasfosterau/effect-parse` peer, so a
 * consumer who uses no format bundles none of them and needs no effect-parse
 * installed; `/pdf*` needs no effect-parse.
 * `scripts/check-dist-imports.mjs` checks the same of the built `dist/`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as R from "effect/Record";
import { describe, expect, it } from "vite-plus/test";
import { options } from "../vite.config.ts";

/** Block comments and `//` line comments, so a doc comment's example is not an import. */
const comment = /\/\*[\s\S]*?\*\/|(?<=^|\s)\/\/.*$/gm;
const specifier =
  /(?:^|[\s;}])(?:import|export)\s[^"';]*?from\s*"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)|^\s*import\s*"([^"]+)"/gm;

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`). */
const packageOf = (spec: string): string =>
  Arr.join(Arr.take(spec.split("/"), spec.startsWith("@") ? 2 : 1), "/");

/** Every package reachable from `entry` (a path relative to the package root). */
const externals = Effect.fn("externals")(function* (entry: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.dirname(yield* path.fromFileUrl(new URL(".", import.meta.url)));
  const seen = new Set<string>();
  const found = new Set<string>();
  const visit = (file: string): Effect.Effect<void, PlatformError.PlatformError> =>
    seen.has(file)
      ? Effect.void
      : Effect.gen(function* () {
          seen.add(file);
          const text = (yield* fs.readFileString(file)).replace(comment, "");
          const specs = Arr.flatMap([...text.matchAll(specifier)], (match) =>
            Option.toArray(Option.fromNullishOr(match[1] ?? match[2] ?? match[3])),
          );
          const relative = Arr.filter(specs, (spec) => spec.startsWith("."));
          for (const spec of Arr.filter(specs, (s) => !s.startsWith("."))) {
            found.add(packageOf(spec));
          }
          yield* Effect.forEach(relative, (spec) => visit(path.resolve(path.dirname(file), spec)), {
            concurrency: 1,
            discard: true,
          });
        });
  yield* visit(path.resolve(root, entry));
  return Arr.sort(
    Arr.filter([...found], (name) => name !== "effect"),
    Order.String,
  );
});

const graph = await Effect.runPromise(
  Effect.forEach(
    R.toEntries(options.entries),
    ([key, file]) => Effect.map(externals(file), (reached) => [key, reached] as const),
    { concurrency: 1 },
  ).pipe(Effect.provide(NodeServices.layer)),
).then((entries) => new Map(entries));

const coreEntries = ["index", "schema", "profile", "profiles", "io"];

describe("module graph", () => {
  it("covers every entry point", () => {
    expect([...graph.keys()]).toEqual(Object.keys(options.entries));
  });

  it.each(coreEntries)("%s reaches no dependency (fflate, effect-parse, effect-ext)", (key) => {
    expect(graph.get(key)).toEqual([]);
  });

  it.each(["pdf", "pdf/cos"])("%s reaches no effect-parse", (key) => {
    expect(graph.get(key)).not.toContain("@thomasfosterau/effect-parse");
  });

  it("reaches only the dependencies each subpath needs", () => {
    const parse = "@thomasfosterau/effect-parse";
    expect(Object.fromEntries(graph)).toEqual({
      index: [],
      schema: [],
      profile: [],
      profiles: [],
      io: [],
      csv: [parse],
      rtf: [parse],
      encoding: ["@thomasfosterau/effect-ext"],
      ooxml: [parse, "fflate"],
      "ooxml/xlsx": [parse, "fflate"],
      "ooxml/docx": [parse, "fflate"],
      "ooxml/pptx": [parse, "fflate"],
      pdf: ["fflate"],
      "pdf/cos": ["fflate"],
      iwork: [parse, "fflate"],
      "iwork/pages": [parse, "fflate"],
      "iwork/numbers": [parse, "fflate"],
      "iwork/keynote": [parse, "fflate"],
      "iwork/codec": [parse, "fflate"],
    });
  });
});
