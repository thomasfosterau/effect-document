import * as Effect from "effect/Effect";
import { zipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";
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
import { loadFixtures } from "./fixture.ts";

const fixture = await loadFixtures(["simple-oneslide.key", "test-1.numbers"]);

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
  Effect.runSync(Effect.map(collectDiagnostics(read), ([, found]) => found));

describe("iWork fileFormatVersion (#101)", () => {
  test("the fixtures' versions are known: no diagnostic", () => {
    expect(
      diagnosticsOf(Keynote.makeKeynoteReader().read(bytes(fixture("simple-oneslide.key")))),
    ).toEqual([]);
    expect(
      diagnosticsOf(Numbers.makeNumbersReader().read(bytes(fixture("test-1.numbers")))),
    ).toEqual([]);
  });

  test("a version outside the known range is a notice, and the read goes on", () => {
    const read = Numbers.makeNumbersReader().read(bytes(numbersOf([99, 0, 1])));
    const [doc, found] = Effect.runSync(collectDiagnostics(read));
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
  });

  test("a version inside the range, or none, reports nothing", () => {
    expect(diagnosticsOf(Numbers.makeNumbersReader().read(bytes(numbersOf([26, 4, 0]))))).toEqual(
      [],
    );
    expect(diagnosticsOf(Numbers.makeNumbersReader().read(bytes(numbersOf([]))))).toEqual([]);
  });

  test("Pages has no known range yet, so is not checked", () => {
    const pages = zipSync({
      "Index/Document.iwa": chunk(new Uint8Array(record(1, [{ type: 1, payload: [] }]))),
      "Index/Metadata.iwa": metadataIwa([99]),
    });
    expect(diagnosticsOf(Pages.makePagesReader().read(bytes(pages)))).toEqual([]);
  });
});
