/**
 * Schema validation of OOXML writer output (#134): every XML part the DOCX,
 * XLSX and PPTX writers produce, for a sample of every feature their writers
 * accept, is validated with `xmllint` against the ECMA-376 transitional
 * schemas (the `ecma-376-schemas` corpus, `vp run corpora:fetch`).
 *
 * Skipped locally when the schemas are not fetched or `xmllint` is missing;
 * under CI (`CI` set) either is a failure, so the check can't silently stop
 * running.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { unzipSync } from "fflate";
import { describe, expect, test } from "vite-plus/test";
import type { Feature } from "@thomasfosterau/effect-document";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-ooxml";
import { type AnyWriter, type Family, writeSamples } from "../samples.ts";
import { DCTERMS_XSD, DC_XSD, XML_XSD } from "./xsd-stubs.ts";

/** The schema, under the ECMA-376 `ref/xsd` directory, for each root-element namespace. */
const SCHEMAS = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "wml.xsd",
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main": "sml.xsd",
  "http://schemas.openxmlformats.org/presentationml/2006/main": "pml.xsd",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "dml-main.xsd",
  "http://schemas.openxmlformats.org/package/2006/relationships": "opc-xsd/opc-relationships.xsd",
  "http://schemas.openxmlformats.org/package/2006/content-types": "opc-xsd/opc-contentTypes.xsd",
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties":
    "opc-xsd/opc-coreProperties.xsd",
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties":
    "shared-documentPropertiesExtended.xsd",
} satisfies Record<string, string>;

type Namespace = keyof typeof SCHEMAS;
const NAMESPACES: ReadonlyArray<string> = Rec.keys(SCHEMAS);
const isNamespace = (ns: string): ns is Namespace => NAMESPACES.includes(ns);

/**
 * Errors the ECMA schemas report on output Office itself writes, with why
 * each is accepted. Every other error fails.
 */
const KNOWN_DIVERGENCES: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
  {
    // sml.xsd types <t> as a bare ST_Xstring, but Excel writes
    // xml:space="preserve" on it, and it is the only way to keep a shared
    // string's leading or trailing spaces.
    pattern:
      /Element '\{http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main\}t', attribute '\{http:\/\/www\.w3\.org\/XML\/1998\/namespace\}space': The attribute .* is not allowed\./,
    why: "xml:space on SpreadsheetML <t>",
  },
];

/** The writers checked, each with the family its feature samples are built for. */
const WRITERS: ReadonlyArray<{
  readonly id: string;
  readonly writer: AnyWriter;
  readonly family: Family;
}> = [
  { id: "docx", writer: Docx.makeDocxWriter(), family: "prose" },
  { id: "xlsx", writer: Xlsx.makeXlsxWriter(), family: "sheet" },
  { id: "pptx", writer: Pptx.makePptxWriter(), family: "deck" },
];

const Manifest = Schema.Struct({
  corpora: Schema.Array(Schema.Struct({ id: Schema.String, commit: Schema.String })),
});

/** The fetched ECMA-376 schema directory and whether `xmllint` runs, or why the check can't run. */
const environment = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
    yield* fs.readFileString(path.join(root, "corpora.json")),
  );
  const pin = Arr.findFirst(manifest.corpora, (c) => c.id === "ecma-376-schemas");
  const dir = Option.map(pin, (c) => path.join(root, ".corpora", c.id, c.commit, "ref", "xsd"));
  const fetched = Option.isSome(dir) && (yield* fs.exists(path.join(dir.value, "wml.xsd")));
  const xmllint = yield* spawner.exitCode(ChildProcess.make("xmllint", ["--version"])).pipe(
    Effect.map((code) => code === 0),
    Effect.orElseSucceed(() => false),
  );
  const ci = Option.isSome(yield* Config.option(Config.String("CI")));
  const missing = [
    ...(fetched ? [] : ["the ECMA-376 schemas (run `vp run corpora:fetch`)"]),
    ...(xmllint ? [] : ["xmllint (libxml2-utils)"]),
  ];
  return { schemas: Option.getOrElse(dir, () => ""), missing, ci };
}).pipe(Effect.provide(NodeServices.layer));

const { schemas, missing, ci } = await Effect.runPromise(environment);

/** The namespace of a part's root element, from its start tag. */
const rootNamespace = (xml: string): Option.Option<string> => {
  const tag = /<(?![?!])(?:([\w.-]+):)?[\w.-]+([^>]*)>/.exec(xml);
  if (tag === null) return Option.none();
  const prefix = tag[1];
  const attrs = tag[2] ?? "";
  const xmlns = new RegExp(`xmlns${prefix === undefined ? "" : `:${prefix}`}="([^"]+)"`).exec(
    attrs,
  );
  return Option.fromNullishOr(xmlns?.[1]);
};

/** A driver schema: the `xml:` (and for core properties, Dublin Core) stand-ins, then the namespace's own schema. */
const driver = (dir: string, ns: Namespace, stubs: string): string => `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:import namespace="http://www.w3.org/XML/1998/namespace" schemaLocation="${stubs}/xml.xsd"/>
  <xs:import namespace="http://purl.org/dc/elements/1.1/" schemaLocation="${stubs}/dc.xsd"/>
  <xs:import namespace="http://purl.org/dc/terms/" schemaLocation="${stubs}/dcterms.xsd"/>
  <xs:import namespace="${ns}" schemaLocation="${dir}/${SCHEMAS[ns]}"/>
</xs:schema>
`;

interface Part {
  /** `<feature>/<part path>`, for messages. */
  readonly name: string;
  readonly xml: string;
}

/** The XML parts (`.xml`, `.rels`) of one written package, named `<feature>/<part path>`. */
const xmlParts = (feature: Feature, bytes: Uint8Array): ReadonlyArray<Part> =>
  Arr.filterMap(Rec.toEntries(unzipSync(bytes)), ([path, data]) =>
    /\.(xml|rels)$/.test(path)
      ? Result.succeed({ name: `${feature}/${path}`, xml: new TextDecoder().decode(data) })
      : Result.failVoid,
  );

/**
 * Every XML part of every feature sample the writer accepts, grouped by its
 * root element's namespace; parts with no schema here are listed apart.
 */
const partsOf = ({ writer, family }: (typeof WRITERS)[number]) =>
  Effect.map(writeSamples(writer, family), (samples) => {
    const parts = samples.flatMap(({ feature, bytes }) => xmlParts(feature, bytes));
    const unknown = Arr.filterMap(parts, (part) => {
      const ns = rootNamespace(part.xml);
      return Option.isSome(ns) && isNamespace(ns.value)
        ? Result.failVoid
        : Result.succeed(`${part.name} (${Option.getOrElse(ns, () => "no namespace")})`);
    });
    const byNamespace = Arr.groupBy(
      Arr.filter(parts, (part) => Option.exists(rootNamespace(part.xml), isNamespace)),
      (part) => Option.getOrElse(rootNamespace(part.xml), () => ""),
    );
    return { byNamespace, unknown };
  });

/** Validates parts against one namespace's schema; the errors left after the known divergences. */
const validate = (ns: Namespace, parts: ReadonlyArray<Part>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "ooxml-xsd-" });
      yield* fs.writeFileString(path.join(tmp, "xml.xsd"), XML_XSD);
      yield* fs.writeFileString(path.join(tmp, "dc.xsd"), DC_XSD);
      yield* fs.writeFileString(path.join(tmp, "dcterms.xsd"), DCTERMS_XSD);
      const schema = path.join(tmp, "driver.xsd");
      yield* fs.writeFileString(schema, driver(schemas, ns, tmp));
      const files = yield* Effect.forEach(
        parts,
        (part, i) => {
          const file = path.join(tmp, `${i}.xml`);
          return Effect.as(fs.writeFileString(file, part.xml), [file, part.name] as const);
        },
        { concurrency: 8 },
      );
      const output = yield* spawner.string(
        ChildProcess.make("xmllint", [
          "--nonet",
          "--noout",
          "--schema",
          schema,
          ...files.map(([f]) => f),
        ]),
        { includeStderr: true },
      );
      // name the parts, not the scratch files, in what is reported
      const named = files.reduce((text, [file, name]) => text.replaceAll(file, name), output);
      return (
        named
          .split("\n")
          // the per-file "fails to validate" verdicts follow from these lines, so a
          // part whose only errors are known divergences is not failed
          .filter((line) => /Schemas (validity|parser) error|failed to compile/.test(line))
          .filter((line) => !KNOWN_DIVERGENCES.some((d) => d.pattern.test(line)))
      );
    }),
  );

describe.skipIf(!ci && !Arr.isReadonlyArrayEmpty(missing))(
  "OOXML output validates against ECMA-376 (#134)",
  () => {
    test("the validators are available", () => {
      expect(missing).toEqual([]);
    });

    test.each(WRITERS)("$id: every part of every feature sample", async (entry) => {
      const errors = await Effect.runPromise(
        Effect.gen(function* () {
          const { byNamespace, unknown } = yield* partsOf(entry);
          const invalid = yield* Effect.forEach(
            Rec.toEntries(byNamespace),
            ([ns, parts]) => (isNamespace(ns) ? validate(ns, parts) : Effect.succeed([])),
            { concurrency: 1 },
          );
          return [...unknown.map((u) => `no schema for ${u}`), ...invalid.flat()];
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      expect(errors).toEqual([]);
    });
  },
);
