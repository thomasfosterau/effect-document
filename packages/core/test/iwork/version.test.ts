import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { zipSync } from "fflate";
import { describe, expect } from "vite-plus/test";
import {
  bytes,
  collectDiagnostics,
  lossReport,
  type ParseError,
} from "@thomasfosterau/effect-document";
import { chunk } from "../../src/iwork/iwa.ts";
import * as Keynote from "../../src/iwork/keynote.ts";
import * as Numbers from "../../src/iwork/numbers.ts";
import * as Pages from "../../src/iwork/pages.ts";
import { TSP_PACKAGE_METADATA } from "../../src/iwork/registry.ts";
import { lenField, record, varint, varintField } from "./encode.ts";
import { fixture } from "./fixture.ts";

/** `TSP.PackageMetadata`'s `file_format_version` (#101): field 7, packed varints. */
const metadataIwa = (version: ReadonlyArray<number>): Uint8Array =>
  chunk(
    new Uint8Array(
      record(1, [{ type: TSP_PACKAGE_METADATA, payload: lenField(7, version.flatMap(varint)) }]),
    ),
  );

/** A one-sheet Numbers package whose metadata gives `version`. */
const numbersOf = (version: ReadonlyArray<number>): Uint8Array =>
  zipSync({
    "Index/Document.iwa": chunk(
      new Uint8Array([
        ...record(10, [{ type: 2, payload: lenField(1, [83]) }]),
        ...record(1, [{ type: 1, payload: lenField(1, varintField(1, 10)) }]),
      ]),
    ),
    "Index/Metadata.iwa": metadataIwa(version),
  });

/** The diagnostics a read reports. */
const diagnosticsOf = (read: Effect.Effect<unknown, ParseError>) =>
  Effect.map(collectDiagnostics(read), ([, found]) => found);

layer(NodeServices.layer)((it) => {
  describe("iWork fileFormatVersion (#101)", () => {
    it.effect("the fixtures' versions are known: no diagnostic", () =>
      Effect.gen(function* () {
        expect(
          yield* diagnosticsOf(
            Keynote.makeKeynoteReader().read(bytes(yield* fixture("simple-oneslide.key"))),
          ),
        ).toEqual([]);
        expect(
          yield* diagnosticsOf(
            Numbers.makeNumbersReader().read(bytes(yield* fixture("test-1.numbers"))),
          ),
        ).toEqual([]);
      }),
    );

    it.effect("a version outside the known range is a notice, and the read goes on", () =>
      Effect.gen(function* () {
        const read = Numbers.makeNumbersReader().read(bytes(numbersOf([99, 0, 1])));
        const [doc, found] = yield* collectDiagnostics(read);
        expect(doc.blocks).toHaveLength(1);
        expect(found).toEqual([
          {
            format: "numbers",
            stage: "read",
            code: "iwork.unknownFormatVersion",
            severity: "notice",
            path: [],
            detail:
              "fileFormatVersion 99.0.1 is outside the versions this reader is known to read (majors 11 to 26); reading it anyway",
          },
        ]);
        // a notice loses nothing
        expect(lossReport([], found).isLossless).toBe(true);
      }),
    );

    it.effect("a version inside the range, or none, reports nothing", () =>
      Effect.gen(function* () {
        expect(
          yield* diagnosticsOf(Numbers.makeNumbersReader().read(bytes(numbersOf([26, 4, 0])))),
        ).toEqual([]);
        expect(
          yield* diagnosticsOf(Numbers.makeNumbersReader().read(bytes(numbersOf([])))),
        ).toEqual([]);
      }),
    );

    it.effect("Pages has no known range yet, so is not checked", () =>
      Effect.gen(function* () {
        const pages = zipSync({
          "Index/Document.iwa": chunk(new Uint8Array(record(1, [{ type: 1, payload: [] }]))),
          "Index/Metadata.iwa": metadataIwa([99]),
        });
        expect(yield* diagnosticsOf(Pages.makePagesReader().read(bytes(pages)))).toEqual([]);
      }),
    );
  });
});
