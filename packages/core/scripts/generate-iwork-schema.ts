/**
 * Generates `src/iwork/schema.generated.ts` from the vendored `.proto`
 * snapshot in `vendor/iwork-protos/` (provenance: `PROVENANCE.md` there).
 *
 * Run from the repository root:
 *
 *     vpx packages/core/scripts/generate-iwork-schema.ts
 *
 * The iWork readers read protobuf by field number and find messages by type
 * id. Both come from Apple's app binaries, as reverse-engineered by
 * keynote-parser and numbers-parser, so instead of keeping them in comments
 * the readers take them from the generated module: `TYPE_IDS` (message ->
 * its type ids, from the registries), `FIELDS` (message -> field name ->
 * number) and `ENUMS` (enum -> value name -> number), for the messages in
 * {@link WANTED_TYPE_IDS}, {@link WANTED_FIELDS} and {@link WANTED_ENUMS}.
 *
 * {@link generateIworkSchema} is the pure part (file path -> text, in and
 * out), so a test can check that the committed module is what the snapshot
 * generates; `main` reads the vendor directory and writes the module. The
 * output is already in the form `vp fmt` leaves it in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse";

/** The Keynote registry: type id -> message name, from keynote-parser (JSON). */
export const KEYNOTE_REGISTRY = "keynote-parser-14.5/registry.json";

/** The Numbers registry: type id -> message name, from numbers-parser (a Python dict literal). */
export const NUMBERS_MAPPING = "numbers-parser/mapping.py";

/**
 * The messages whose type ids the readers match on. Each must be defined in
 * the snapshot and appear in the registry of the source that defines it.
 */
export const WANTED_TYPE_IDS: ReadonlyArray<string> = [
  "KN.DocumentArchive",
  "KN.PlaceholderArchive",
  "KN.ShowArchive",
  "KN.SlideArchive",
  "KN.SlideNodeArchive",
  "TN.DocumentArchive",
  "TN.SheetArchive",
  "TSP.PackageMetadata",
  "TSWP.ShapeInfoArchive",
  "TSWP.StorageArchive",
];

/** The messages whose field numbers the readers use (nested messages by full name). */
export const WANTED_FIELDS: ReadonlyArray<string> = [
  "KN.DocumentArchive",
  "KN.ShowArchive",
  "KN.SlideNodeArchive",
  "KN.SlideTreeArchive",
  "TN.DocumentArchive",
  "TN.SheetArchive",
  "TSP.ArchiveInfo",
  "TSP.ComponentDataReference",
  "TSP.ComponentExternalReference",
  "TSP.ComponentInfo",
  "TSP.DataInfo",
  "TSP.MessageInfo",
  "TSP.PackageMetadata",
  "TSP.Reference",
  "TSWP.StorageArchive",
];

/** The enums whose values the readers use, by full name. */
export const WANTED_ENUMS: ReadonlyArray<string> = ["TSWP.StorageArchive.KindType"];

/** A field of a message: its name and number. */
interface FieldDecl {
  readonly name: string;
  readonly number: number;
}

/** An enum: its name and its values. */
interface EnumDecl {
  readonly name: string;
  readonly values: ReadonlyArray<FieldDecl>;
}

/** A message with the fields and the messages and enums nested in it. */
interface MessageDecl {
  readonly name: string;
  readonly fields: ReadonlyArray<FieldDecl>;
  readonly messages: ReadonlyArray<MessageDecl>;
  readonly enums: ReadonlyArray<EnumDecl>;
}

/** One parsed statement of a file or message body. */
type Item =
  | { readonly _tag: "Field"; readonly field: FieldDecl }
  | { readonly _tag: "Message"; readonly message: MessageDecl }
  | { readonly _tag: "Enum"; readonly enum: EnumDecl }
  | { readonly _tag: "Package"; readonly name: string }
  | { readonly _tag: "Skip" };

/** A parsed `.proto` file. */
interface ProtoFile {
  readonly package: string;
  readonly messages: ReadonlyArray<MessageDecl>;
  readonly enums: ReadonlyArray<EnumDecl>;
}

// ---------------------------------------------------------------------------
// The grammar: the proto2 subset the snapshot uses. Anything else is a parse
// error (never a silent skip), so a refresh cannot drop a field unnoticed.
// ---------------------------------------------------------------------------

const NAME_CHARS = [Token.range("a", "z"), Token.range("A", "Z"), Token.range("0", "9"), "_", "."];
const OPTION_NAME_CHARS = [...NAME_CHARS, "(", ")"];
const OPTION_VALUE_CHARS = [...NAME_CHARS, "-", "+"];

const lineComment = Parser.seq(Token.literal("//"), Token.takeTill("\n"));
const blockComment = Parser.seq(Token.literal("/*"), Token.takeUntil("*/"), Token.literal("*/"));
const space = Parser.asVoid(
  Parser.repeat(
    Parser.alt(Token.takeWhile([" ", "\t", "\r", "\n"], { min: 1 }), lineComment, blockComment),
  ),
);

/** A parser that also skips the whitespace and comments after it. */
const lexeme = <A, E>(parser: Parser.Parser<A, E>): Parser.Parser<A, E> =>
  Parser.terminated(parser, space);

const sym = (symbol: string) => lexeme(Token.literal(symbol));
const word = lexeme(Token.takeWhile(NAME_CHARS, { min: 1 }));
const keyword = (name: string) =>
  lexeme(Parser.terminated(Token.literal(name), Parser.not(Token.oneOf(NAME_CHARS))));
const integer = lexeme(Ascii.decInt);
const stringLiteral = lexeme(
  Parser.delimited(Token.literal('"'), Token.takeTill('"\\\n'), Token.literal('"')),
);

const skip: Item = { _tag: "Skip" };
const toSkip = <A, E>(parser: Parser.Parser<A, E>): Parser.Parser<Item, E> =>
  Parser.as(parser, skip);

/** `[ name = value, ... ]` after a field or enum value; its contents are not used. */
const bracketOptions = Parser.optional(
  Parser.delimited(
    sym("["),
    Parser.separated(
      Parser.seq(
        lexeme(Token.takeWhile(OPTION_NAME_CHARS, { min: 1 })),
        sym("="),
        Parser.alt(stringLiteral, lexeme(Token.takeWhile(OPTION_VALUE_CHARS, { min: 1 }))),
      ),
      sym(","),
      { min: 1 },
    ),
    sym("]"),
  ),
);

/** `option name = value;`, in a file, message, enum or oneof. */
const optionStatement = toSkip(
  Parser.seq(
    keyword("option"),
    Parser.cut(
      Parser.seq(
        lexeme(Token.takeWhile(OPTION_NAME_CHARS, { min: 1 })),
        sym("="),
        Parser.alt(stringLiteral, lexeme(Token.takeWhile(OPTION_VALUE_CHARS, { min: 1 }))),
        sym(";"),
      ),
    ),
  ),
);

const emptyStatement = toSkip(sym(";"));

/** `map<K, V>` or a (possibly qualified) type name. */
const typeReference = Parser.alt(
  Parser.seq(keyword("map"), sym("<"), word, sym(","), word, sym(">")),
  word,
);

/** `type name = number [options];` after the label, if any. */
const fieldBody = Parser.map(
  Parser.seq(typeReference, word, sym("="), integer, bracketOptions, sym(";")),
  ([, name, , number]): Item => ({ _tag: "Field", field: { name, number } }),
);

const label = Parser.alt(keyword("optional"), keyword("required"), keyword("repeated"));
const labelledField = Parser.preceded(label, fieldBody);

/** `reserved` and `extensions` ranges: `1, 2 to 5, 9 to max` or names. */
const rangeEnd = Parser.alt(integer, keyword("max"));
const rangeList = Parser.separated(
  Parser.alt(
    Parser.seq(integer, Parser.optional(Parser.preceded(keyword("to"), rangeEnd))),
    stringLiteral,
  ),
  sym(","),
  { min: 1 },
);
const rangeStatement = (name: string) =>
  toSkip(Parser.seq(keyword(name), Parser.cut(Parser.seq(rangeList, bracketOptions, sym(";")))));

const enumValue = Parser.map(
  Parser.seq(word, sym("="), integer, bracketOptions, sym(";")),
  ([name, , number]): Item => ({ _tag: "Field", field: { name, number } }),
);

const enumItem: Parser.Parser<Item, string> = Parser.map(
  Parser.preceded(
    keyword("enum"),
    Parser.cut(
      Parser.seq(
        word,
        sym("{"),
        Parser.repeat(
          Parser.alt(optionStatement, rangeStatement("reserved"), emptyStatement, enumValue),
        ),
        sym("}"),
      ),
    ),
  ),
  ([name, , items]): Item => ({
    _tag: "Enum",
    enum: { name, values: items.flatMap((i) => (Predicate.isTagged(i, "Field") ? [i.field] : [])) },
  }),
);

const oneofItem: Parser.Parser<ReadonlyArray<Item>, string> = Parser.preceded(
  keyword("oneof"),
  Parser.cut(
    Parser.delimited(
      Parser.seq(word, sym("{")),
      Parser.repeat(Parser.alt(optionStatement, emptyStatement, fieldBody)),
      sym("}"),
    ),
  ),
);

/** The statements of a message body; `extend` blocks are parsed but not kept. */
const messageBody: Parser.Parser<ReadonlyArray<Item>, string> = Parser.suspend(() =>
  Parser.map(
    Parser.repeat(
      Parser.alt(
        Parser.map(messageItem, (item): ReadonlyArray<Item> => [item]),
        Parser.map(enumItem, (item): ReadonlyArray<Item> => [item]),
        Parser.map(extendItem, (item): ReadonlyArray<Item> => [item]),
        oneofItem,
        Parser.map(
          Parser.alt(
            optionStatement,
            rangeStatement("extensions"),
            rangeStatement("reserved"),
            emptyStatement,
            labelledField,
          ),
          (item): ReadonlyArray<Item> => [item],
        ),
      ),
    ),
    (groups) => groups.flat(),
  ),
);

const messageItem: Parser.Parser<Item, string> = Parser.map(
  Parser.preceded(
    keyword("message"),
    Parser.cut(Parser.seq(word, Parser.delimited(sym("{"), messageBody, sym("}")))),
  ),
  ([name, items]): Item => ({ _tag: "Message", message: buildMessage(name, items) }),
);

const extendItem: Parser.Parser<Item, string> = toSkip(
  Parser.preceded(
    keyword("extend"),
    Parser.cut(Parser.seq(word, Parser.delimited(sym("{"), messageBody, sym("}")))),
  ),
);

const statement = <A, E>(parser: Parser.Parser<A, E>) =>
  Parser.preceded(parser, Parser.cut(sym(";")));

const topItem: Parser.Parser<Item, string> = Parser.alt(
  toSkip(Parser.seq(keyword("syntax"), Parser.cut(Parser.seq(sym("="), stringLiteral, sym(";"))))),
  Parser.map(
    Parser.preceded(keyword("package"), Parser.cut(Parser.terminated(word, sym(";")))),
    (name): Item => ({ _tag: "Package", name }),
  ),
  toSkip(
    statement(
      Parser.seq(
        keyword("import"),
        Parser.optional(Parser.alt(keyword("public"), keyword("weak"))),
        stringLiteral,
      ),
    ),
  ),
  optionStatement,
  messageItem,
  enumItem,
  extendItem,
  emptyStatement,
);

const protoFile = Parser.complete(
  Parser.preceded(space, Parser.terminated(Parser.repeat(topItem), Parser.eof)),
);

const itemsOf = <T extends Item["_tag"]>(items: ReadonlyArray<Item>, tag: T) =>
  items.filter((i): i is Extract<Item, { _tag: T }> => Predicate.isTagged(i, tag));

function buildMessage(name: string, items: ReadonlyArray<Item>): MessageDecl {
  return {
    name,
    fields: itemsOf(items, "Field").map((i) => i.field),
    messages: itemsOf(items, "Message").map((i) => i.message),
    enums: itemsOf(items, "Enum").map((i) => i.enum),
  };
}

/** The line, column and following text of an offset, for an error message. */
const locate = (source: string, offset: number) => {
  const before = source.slice(0, offset).split("\n");
  const rest = source.slice(offset).split("\n")[0] ?? "";
  return `${before.length}:${(before.at(-1) ?? "").length + 1} near ${JSON.stringify(rest.slice(0, 60))}`;
};

/**
 * Parse one `.proto` file. Throws an `Error` naming `file`, the line and
 * column and the text there for anything outside the supported grammar.
 */
export const parseProto = (file: string, source: string): ProtoFile => {
  const items = Result.getOrThrowWith(
    Parser.parse(protoFile, source),
    (e) => new Error(`${file}:${locate(source, e.offset)}: unrecognised proto construct`),
  );
  const packages = itemsOf(items, "Package");
  if (packages.length !== 1) throw new Error(`${file}: expected one package statement`);
  return {
    package: packages[0]?.name ?? "",
    messages: itemsOf(items, "Message").map((i) => i.message),
    enums: itemsOf(items, "Enum").map((i) => i.enum),
  };
};

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/** Add an `id -> name` entry as the name's id list. */
const addId = (ids: Map<string, Array<number>>, name: string, id: number) => {
  ids.set(name, [...(ids.get(name) ?? []), id]);
};

/** The Keynote registry: a JSON object of type id to message name. */
const parseKeynoteRegistry = (text: string): Map<string, Array<number>> => {
  const parsed: unknown = JSON.parse(text);
  if (!Predicate.isObject(parsed) || Array.isArray(parsed)) {
    throw new Error(`${KEYNOTE_REGISTRY}: expected an object`);
  }
  const ids = new Map<string, Array<number>>();
  for (const [id, name] of Object.entries(parsed)) {
    if (!Predicate.isString(name) || !/^\d+$/.test(id)) {
      throw new Error(`${KEYNOTE_REGISTRY}: bad entry ${JSON.stringify(id)}`);
    }
    addId(ids, name, Number(id));
  }
  return ids;
};

const MAPPING_ENTRY = /^\s*"(\d+)":\s*"([A-Za-z0-9_.]+)",?\s*$/;

/**
 * The Numbers registry: the `"<id>": "<Name>",` lines of the
 * `TSPRegistryMapping = { ... }` literal in numbers-parser's `mapping.py`.
 * Any other line inside the literal is an error.
 */
const parseNumbersMapping = (text: string): Map<string, Array<number>> => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("TSPRegistryMapping = {"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("}"));
  if (start < 0 || end < 0) throw new Error(`${NUMBERS_MAPPING}: no TSPRegistryMapping literal`);
  const ids = new Map<string, Array<number>>();
  for (const [offset, line] of lines.slice(start + 1, end).entries()) {
    if (line.trim() === "") continue;
    const match = MAPPING_ENTRY.exec(line);
    if (match === null) {
      throw new Error(`${NUMBERS_MAPPING}:${start + offset + 2}: unrecognised entry ${line}`);
    }
    addId(ids, match[2] ?? "", Number(match[1]));
  }
  return ids;
};

// ---------------------------------------------------------------------------
// Resolution and emission
// ---------------------------------------------------------------------------

/** A message or enum with its full name and the directory of the source that defines it. */
interface Defined<T> {
  readonly source: string;
  readonly decl: T;
}

const collect = (
  source: string,
  prefix: string,
  message: MessageDecl,
  messages: Map<string, Defined<MessageDecl>>,
  enums: Map<string, Defined<EnumDecl>>,
) => {
  const full = `${prefix}.${message.name}`;
  if (messages.has(full)) throw new Error(`${source}: message ${full} is defined twice`);
  const numbers = new Set<number>();
  const names = new Set<string>();
  for (const field of message.fields) {
    if (numbers.has(field.number) || names.has(field.name)) {
      throw new Error(`${source}: ${full} repeats field ${field.name} = ${field.number}`);
    }
    numbers.add(field.number);
    names.add(field.name);
  }
  messages.set(full, { source, decl: message });
  for (const nested of message.messages) collect(source, full, nested, messages, enums);
  for (const e of message.enums) enums.set(`${full}.${e.name}`, { source, decl: e });
};

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keyOrder = Order.mapInput(
  Order.make(byCodeUnit),
  (entry: readonly [string, unknown]) => entry[0],
);

const sorted = <T>(entries: Iterable<readonly [string, T]>): Array<readonly [string, T]> =>
  Arr.sort(Array.from(entries), keyOrder);

const member = (name: string, value: string) => `${name}: ${value}`;
const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
const object = (entries: ReadonlyArray<string>): string =>
  entries.length === 0 ? "{}" : `{\n${entries.map((e) => `${indent(e)},\n`).join("")}}`;

/** A key, quoted when it is not an identifier (what `vp fmt` leaves of a mixed object). */
const quoted = (name: string) => JSON.stringify(name);

const HEADER = `/**
 * GENERATED FILE - do not edit.
 *
 * The iWork protobuf type ids, field numbers and enum values the readers use,
 * generated from the vendored \`.proto\` snapshot in \`vendor/iwork-protos/\`
 * (keynote-parser and numbers-parser; see \`PROVENANCE.md\` there) by
 *
 *     vpx packages/core/scripts/generate-iwork-schema.ts
 *
 * Refresh the snapshot, rerun the command and commit both;
 * \`test/iwork/schema-generated.test.ts\` fails while they disagree.
 */
`;

const section = (doc: string, name: string, entries: ReadonlyArray<readonly [string, string]>) =>
  `\n/** ${doc} */\nexport const ${name} = ${object(
    sorted(entries).map(([key, value]) => member(quoted(key), value)),
  )} as const;\n`;

/**
 * Generate the text of `schema.generated.ts` from the snapshot: `files` maps
 * each file's path under `vendor/iwork-protos/` (`keynote-parser-14.5/KNArchives.proto`,
 * the registries included) to its text. Throws an `Error` naming the file for
 * anything it cannot parse, and for a wanted message, enum or type id the
 * snapshot does not define.
 */
export const generateIworkSchema = (files: Readonly<Record<string, string>>): string => {
  const messages = new Map<string, Defined<MessageDecl>>();
  const enums = new Map<string, Defined<EnumDecl>>();
  for (const [file, text] of sorted(Object.entries(files))) {
    if (!file.endsWith(".proto")) continue;
    const proto = parseProto(file, text);
    for (const message of proto.messages) {
      collect(path.dirname(file), proto.package, message, messages, enums);
    }
    for (const e of proto.enums) enums.set(`${proto.package}.${e.name}`, { source: file, decl: e });
  }
  const registries = new Map<string, Map<string, Array<number>>>([
    [path.dirname(KEYNOTE_REGISTRY), parseKeynoteRegistry(files[KEYNOTE_REGISTRY] ?? "")],
    [path.dirname(NUMBERS_MAPPING), parseNumbersMapping(files[NUMBERS_MAPPING] ?? "")],
  ]);

  const message = (name: string): Defined<MessageDecl> => {
    const found = messages.get(name);
    if (found === undefined) throw new Error(`the snapshot does not define message ${name}`);
    return found;
  };
  const typeIds = WANTED_TYPE_IDS.map((name) => {
    const ids = registries.get(message(name).source)?.get(name);
    if (ids === undefined) throw new Error(`no registry lists a type id for ${name}`);
    return [name, `[${Arr.sort(ids, Order.Number).join(", ")}]`] as const;
  });
  const fields = WANTED_FIELDS.map(
    (name) =>
      [
        name,
        object(
          sorted(message(name).decl.fields.map((f) => [f.name, String(f.number)] as const)).map(
            ([n, v]) => member(n, v),
          ),
        ),
      ] as const,
  );
  const enumValues = WANTED_ENUMS.map((name) => {
    const found = enums.get(name);
    if (found === undefined) throw new Error(`the snapshot does not define enum ${name}`);
    const values = sorted(found.decl.values.map((v) => [v.name, String(v.number)] as const));
    return [name, object(values.map(([n, v]) => member(n, v)))] as const;
  });

  return (
    HEADER +
    section(
      "The type ids (`MessageInfo.type`) of each message, from the registries.",
      "TYPE_IDS",
      typeIds,
    ) +
    section("The field numbers of each message, by field name.", "FIELDS", fields) +
    section("The values of each enum, by value name.", "ENUMS", enumValues)
  );
};

/** The vendored snapshot's directory, `vendor/iwork-protos` beside this script's package. */
const vendorDir = fileURLToPath(new URL("../vendor/iwork-protos/", import.meta.url));

/** The generated module's path. */
const outputFile = fileURLToPath(new URL("../src/iwork/schema.generated.ts", import.meta.url));

/** Every file of the snapshot (`.proto`, `.json`, `.py`), by path under the vendor directory. */
const readSnapshot = (): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(vendorDir, { recursive: true, encoding: "utf8" })
      .filter((p) => /\.(proto|json|py)$/.test(p))
      .map((p) => [p.split(path.sep).join("/"), fs.readFileSync(path.join(vendorDir, p), "utf8")]),
  );

/** Read the snapshot and write the generated module. */
export const main = (): void => {
  fs.writeFileSync(outputFile, generateIworkSchema(readSnapshot()));
  process.stdout.write(`wrote ${path.relative(process.cwd(), outputFile)}\n`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
