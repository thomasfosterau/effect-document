/**
 * The generated iWork schema (`src/iwork/schema.generated.ts`) is what the
 * vendored `.proto` snapshot generates, and the generator's parser rejects
 * what it does not understand.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import { describe, expect, test } from "vite-plus/test";
import {
  generateIworkSchema,
  KEYNOTE_REGISTRY,
  NUMBERS_MAPPING,
  parseProto,
} from "../../scripts/generate-iwork-schema.ts";

const read = (relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(yield* path.fromFileUrl(new URL(relative, import.meta.url)));
  });

const snapshotFiles = [
  "keynote-parser-14.5/TSPMessages.proto",
  "keynote-parser-14.5/TSPArchiveMessages.proto",
  "keynote-parser-14.5/KNArchives.proto",
  "keynote-parser-14.5/TSWPArchives.proto",
  KEYNOTE_REGISTRY,
  "numbers-parser/TNArchives.proto",
  NUMBERS_MAPPING,
];

/** The vendored snapshot's files by name, and the committed generated module, read once for the suite. */
class Snapshot extends Context.Service<
  Snapshot,
  { readonly files: Record<string, string>; readonly committed: string }
>()("test/Snapshot") {
  static readonly layer = Layer.effect(
    Snapshot,
    Effect.gen(function* () {
      const entries = yield* Effect.forEach(
        snapshotFiles,
        (name) =>
          Effect.map(read(`../../vendor/iwork-protos/${name}`), (text) => [name, text] as const),
        { concurrency: "unbounded" },
      );
      const committed = yield* read("../../src/iwork/schema.generated.ts");
      return { files: Rec.fromEntries(entries), committed };
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}

const proto = (body: string) => `syntax = "proto2";\npackage P;\n${body}`;

layer(Snapshot.layer)((it) => {
  describe("generated iWork schema", () => {
    it.effect("is what the vendored snapshot generates", () =>
      Effect.gen(function* () {
        const { files, committed } = yield* Snapshot;
        expect(generateIworkSchema(files)).toBe(committed);
      }),
    );

    it.effect("is deterministic", () =>
      Effect.gen(function* () {
        const { files } = yield* Snapshot;
        expect(generateIworkSchema(files)).toBe(generateIworkSchema(files));
      }),
    );

    it.effect("fails naming the registry that lacks a wanted type id", () =>
      Effect.gen(function* () {
        const { files } = yield* Snapshot;
        expect(() => generateIworkSchema({ ...files, [KEYNOTE_REGISTRY]: "{}" })).toThrow(
          /no registry lists a type id/,
        );
      }),
    );

    it.effect("rejects a malformed Numbers mapping entry, with its line", () =>
      Effect.gen(function* () {
        const { files } = yield* Snapshot;
        const broken = files[NUMBERS_MAPPING]?.replace(
          '"2": "TN.SheetArchive",',
          "2 => TN.SheetArchive",
        );
        expect(() => generateIworkSchema({ ...files, [NUMBERS_MAPPING]: broken ?? "" })).toThrow(
          /mapping\.py:\d+: unrecognised entry/,
        );
      }),
    );
  });

  describe("proto parser", () => {
    test("reads fields, nested messages and enums, comments, oneofs, and skips extensions", () => {
      const file = parseProto(
        "a.proto",
        proto(`// line
/* block */
message M {
  option deprecated = true;
  optional int32 a = 1 [default = -1]; // trailing
  repeated .P.N b = 2 [packed = true, deprecated = true];
  extensions 100 to 536870911;
  reserved 5, 7 to 9;
  oneof choice { string c = 3; map<string, int32> d = 4; }
  message N { required bool e = 1; }
  enum E { X = 0; Y = -1; }
  extend .Q.R { optional int32 z = 100; }
}
extend .Q.R { optional int32 y = 200; }
`),
      );
      expect(file.package).toBe("P");
      const [m] = file.messages;
      expect(m?.fields.map((f) => [f.name, f.number])).toEqual([
        ["a", 1],
        ["b", 2],
        ["c", 3],
        ["d", 4],
      ]);
      expect(m?.messages[0]?.fields).toEqual([{ name: "e", number: 1 }]);
      expect(m?.enums[0]?.values).toEqual([
        { name: "X", number: 0 },
        { name: "Y", number: -1 },
      ]);
    });

    test.each([
      ["a group", "message M { optional group G = 1 { optional int32 a = 1; } }"],
      ["a service", "service S {}"],
      ["a field with no number", "message M { optional int32 a; }"],
      ["a string escape", 'option java_package = "a\\"b";'],
      ["an unclosed message", "message M { optional int32 a = 1;"],
    ])("throws naming the file and position for %s", (_, body) => {
      expect(() => parseProto("bad.proto", proto(body))).toThrow(/^bad\.proto:\d+:\d+ near /);
    });

    it.effect("rejects a message that repeats a field number", () =>
      Effect.gen(function* () {
        const { files } = yield* Snapshot;
        expect(() =>
          generateIworkSchema({
            ...files,
            "keynote-parser-14.5/TSPMessages.proto": proto(
              "message Reference { optional int32 a = 1; optional int32 b = 1; }",
            ).replace("package P", "package TSP"),
          }),
        ).toThrow(/repeats field/);
      }),
    );
  });
});
