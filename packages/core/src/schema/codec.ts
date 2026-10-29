/**
 * A stack-safe wire codec for {@link Document} (#191).
 *
 * `Schema.encodeUnknownSync(Document)` and its decode twin recurse through the
 * schema once per level of the value, several frames per level, so a document
 * a few hundred levels deep overflows the call stack and fails with a defect
 * rather than a `SchemaError`. This codec walks the tree with an explicit work
 * list instead, so its depth is bounded by memory, not by the stack.
 *
 * It agrees with the Schema codec: each node's own fields (its attributes,
 * text, numbers, dates, …) are encoded and decoded by a `Schema.Struct` of the
 * node class's non-recursive fields, and each node is built with its class
 * constructor, which runs the class's checks (a heading's level, a sheet's
 * ascending rows). Only the recursive fields (the blocks, inlines, shapes,
 * cells and rows a node holds) are walked here.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
import {
  Block,
  BlockQuote,
  BulletList,
  CellBlank,
  CellBoolean,
  CellDate,
  CellError,
  CellFormula,
  CellNumber,
  CellRichText,
  CellText,
  Citation,
  Cite,
  Code,
  CodeBlock,
  DefinitionItem,
  DefinitionList,
  Div,
  Emph,
  Figure,
  Header,
  HorizontalRule,
  Image,
  IndexedCell,
  Inline,
  LineBlock,
  LineBreak,
  Link,
  Math,
  Note,
  OrderedList,
  Para,
  Picture,
  Placeholder,
  Plain,
  Quoted,
  RawBlock,
  RawInline,
  Shape,
  SheetCell,
  SheetRow,
  Slide,
  SlideShow,
  SmallCaps,
  SoftBreak,
  Space,
  Span,
  Str,
  Strikeout,
  Strong,
  Subscript,
  Superscript,
  Table,
  TableCell,
  TableRow,
  TableShape,
  TextBox,
  Underline,
  Worksheet,
} from "./ast.ts";
import { Document, type DocumentEncoded } from "./document.ts";

// ============================================================================
// The node classes and their recursive fields
// ============================================================================

/** A node class: its constructor (which runs its checks), its schema and its fields. */
type NodeClass = Schema.Top & {
  new (props: any, options?: Schema.MakeOptions): object;
  readonly fields: Schema.Struct.Fields;
};

/** The unions a recursive field can hold a member of. */
type UnionName = "Inline" | "Block" | "Shape" | "SheetCell";

/** What a recursive field holds: a member of one of the unions, or one record class (by its kind). */
type Ref = UnionName | Kind;

/** A recursive field: a single node (`0`), an array of them (`1`) or an array of arrays (`2`). */
interface Child {
  readonly key: string;
  readonly depth: 0 | 1 | 2;
  readonly ref: Ref;
  readonly optional: boolean;
}

/** A node class, the struct of its own (non-recursive) fields, and its recursive fields. */
interface Kind {
  readonly cls: NodeClass;
  /** Decode the node's own fields from its JSON form. */
  readonly decodeOwn: (input: unknown) => Result.Result<Own, Schema.SchemaError>;
  /** Encode the node's own fields to their JSON form. */
  readonly encodeOwn: (input: unknown) => Result.Result<Own, Schema.SchemaError>;
  readonly children: ReadonlyArray<Child>;
  /** The class's tag, for a member of a union. */
  readonly tag: string | undefined;
  /** Whether a recursive field carries a check the constructor must run (a sheet's ascending rows). */
  readonly checked: boolean;
  /** Each field in the class's order, with its index in `children` (`-1` for an own field). */
  readonly order: ReadonlyArray<readonly [string, number]>;
}

const one = (key: string, ref: Ref): Child => ({ key, depth: 0, ref, optional: false });
const many = (key: string, ref: Ref, optional = false): Child => ({
  key,
  depth: 1,
  ref,
  optional,
});
const manyMany = (key: string, ref: Ref): Child => ({ key, depth: 2, ref, optional: false });

const inlines = (key: string): Child => many(key, "Inline");
const blocks = (key: string): Child => many(key, "Block");

/** A node's own (non-recursive) fields, decoded or encoded. */
type Own = Readonly<Record<string, unknown>>;

/** A tagged class's tag, read from its `_tag` field's literal (`undefined` for a record class). */
const tagOf = (cls: NodeClass): string | undefined => {
  const ast = cls.fields["_tag"]?.ast;
  return ast !== undefined && SchemaAST.isLiteral(ast) ? String(ast.literal) : undefined;
};

const kind = (cls: NodeClass, children: ReadonlyArray<Child> = []): Kind => {
  const ownFields = Rec.filter(cls.fields, (_, key) => !children.some((c) => c.key === key));
  // SAFETY: the node fields are plain data schemas with no services, so the
  // struct of a subset of them decodes and encodes records without context.
  // oxlint-disable-next-line effect/no-chained-type-assertions, effect/avoid-any -- `Rec.filter` widens the fields to `Schema.Struct.Fields`, whose services are `unknown`; the node classes' fields need none, which the types can't carry through the filter
  const own = Schema.Struct(ownFields) as unknown as Schema.Codec<Own, Own>;
  return {
    cls,
    decodeOwn: Schema.decodeUnknownResult(own),
    encodeOwn: Schema.encodeUnknownResult(own),
    children,
    tag: tagOf(cls),
    checked: children.some((c) => Arr.isReadonlyArrayNonEmpty(cls.fields[c.key]?.ast.checks ?? [])),
    order: Rec.keys(cls.fields).map(
      (key) => [key, children.findIndex((c) => c.key === key)] as const,
    ),
  };
};

// The record classes, before the unions that use them.
const CITATION = kind(Citation, [inlines("prefix"), inlines("suffix")]);
const DEFINITION_ITEM = kind(DefinitionItem, [inlines("term"), manyMany("definitions", "Block")]);
const TABLE_CELL = kind(TableCell, [blocks("content")]);
const TABLE_ROW = kind(TableRow, [many("cells", TABLE_CELL)]);
const TABLE = kind(Table, [
  many("caption", "Inline", true),
  many("head", TABLE_ROW),
  many("body", TABLE_ROW),
  many("foot", TABLE_ROW),
]);
const INDEXED_CELL = kind(IndexedCell, [one("cell", "SheetCell")]);
const SHEET_ROW = kind(SheetRow, [many("cells", INDEXED_CELL)]);
const SLIDE = kind(Slide, [many("shapes", "Shape"), many("notes", "Block", true)]);
const DOCUMENT = kind(Document, [blocks("blocks")]);

const INLINE_KINDS: ReadonlyArray<Kind> = [
  kind(Str),
  kind(Space),
  kind(SoftBreak),
  kind(LineBreak),
  kind(Emph, [inlines("content")]),
  kind(Strong, [inlines("content")]),
  kind(Underline, [inlines("content")]),
  kind(Strikeout, [inlines("content")]),
  kind(Superscript, [inlines("content")]),
  kind(Subscript, [inlines("content")]),
  kind(SmallCaps, [inlines("content")]),
  kind(Quoted, [inlines("content")]),
  kind(Cite, [many("citations", CITATION), inlines("content")]),
  kind(Code),
  kind(Math),
  kind(RawInline),
  kind(Link, [inlines("content")]),
  kind(Image, [inlines("alt")]),
  kind(Note, [blocks("content")]),
  kind(Span, [inlines("content")]),
];

const BLOCK_KINDS: ReadonlyArray<Kind> = [
  kind(Plain, [inlines("content")]),
  kind(Para, [inlines("content")]),
  kind(LineBlock, [manyMany("lines", "Inline")]),
  kind(CodeBlock),
  kind(RawBlock),
  kind(BlockQuote, [blocks("content")]),
  kind(OrderedList, [manyMany("items", "Block")]),
  kind(BulletList, [manyMany("items", "Block")]),
  kind(DefinitionList, [many("items", DEFINITION_ITEM)]),
  kind(Header, [inlines("content")]),
  kind(HorizontalRule),
  kind(Figure, [blocks("caption"), blocks("content")]),
  kind(Div, [blocks("content")]),
  TABLE,
  kind(Worksheet, [many("rows", SHEET_ROW)]),
  kind(SlideShow, [many("slides", SLIDE)]),
];

const SHAPE_KINDS: ReadonlyArray<Kind> = [
  kind(TextBox, [blocks("content")]),
  kind(Picture),
  kind(TableShape, [one("table", TABLE)]),
  kind(Placeholder, [blocks("content")]),
];

const CELL_KINDS: ReadonlyArray<Kind> = [
  kind(CellText),
  kind(CellNumber),
  kind(CellBoolean),
  kind(CellDate),
  kind(CellError),
  kind(CellBlank),
  kind(CellFormula),
  kind(CellRichText, [inlines("runs")]),
];

/** A union: its schema (for issues) and its members. */
interface Union {
  readonly schema: Schema.Top;
  readonly members: ReadonlyArray<Kind>;
}

const UNIONS: Readonly<Record<UnionName, Union>> = {
  Inline: { schema: Inline, members: INLINE_KINDS },
  Block: { schema: Block, members: BLOCK_KINDS },
  Shape: { schema: Shape, members: SHAPE_KINDS },
  SheetCell: { schema: SheetCell, members: CELL_KINDS },
};

/** The member of a union with the given tag, if any (a union has at most 20 members). */
const memberOf = (name: UnionName, tag: unknown): Kind | undefined =>
  Predicate.isString(tag) ? UNIONS[name].members.find((k) => k.tag === tag) : undefined;

/** The schema a value in a `ref` position must satisfy, for an issue. */
const refSchema = (ref: Ref): Schema.Top =>
  Predicate.isString(ref) ? UNIONS[ref].schema : ref.cls;

// ============================================================================
// The walk
// ============================================================================

/**
 * Where a node sits: the keys from its parent, linked to the parent's path.
 * Linked rather than copied, so a deep document's paths take linear space;
 * {@link keysOf} spells one out only for an issue.
 */
type Path = { readonly up: Path; readonly keys: ReadonlyArray<PropertyKey> } | undefined;

const down = (path: Path, ...keys: ReadonlyArray<PropertyKey>): Path => ({ up: path, keys });

/** A path's keys, root first. */
const keysOf = (path: Path): ReadonlyArray<PropertyKey> =>
  Arr.reverse(
    Arr.unfold(path, (p) =>
      p === undefined ? Option.none() : Option.some([p.keys, p.up] as const),
    ),
  ).flat();

const at = (path: Path, issue: SchemaIssue.Issue): SchemaIssue.Issue =>
  path === undefined ? issue : new SchemaIssue.Pointer(keysOf(path), issue);

/** A value still to visit, in a recursive position. */
interface Work {
  readonly value: unknown;
  readonly ref: Ref;
  readonly path: Path;
}

/**
 * A field absent from its node (an optional one; a required one is an issue).
 * A symbol, so no field value (a cell's `-1`, say) can be mistaken for it.
 */
const ABSENT: unique symbol = Symbol("absent");

/**
 * Where a recursive field's nodes go: the index of each node in the walk
 * (shaped like the field: one, an array or an array of arrays), {@link ABSENT},
 * or `undefined` for an optional field present as `undefined`.
 */
type Template =
  | number
  | ReadonlyArray<number>
  | ReadonlyArray<ReadonlyArray<number>>
  | typeof ABSENT
  | undefined;

/** A node met by the walk: its kind, where it sits, its own fields and a template per recursive field. */
interface Frame {
  readonly kind: Kind;
  readonly path: Path;
  readonly own: Own;
  readonly templates: ReadonlyArray<Template>;
}

/** How a walk reads and builds one node, encoding or decoding. */
interface Direction {
  /** The kind of a value in a `ref` position, or the issue when it isn't one. */
  readonly kindOf: (value: unknown, ref: Ref) => Kind | SchemaIssue.Issue;
  /** The node's own fields, encoded or decoded. */
  readonly own: (kind: Kind, value: unknown) => Result.Result<Own, Schema.SchemaError>;
  /** The finished node from its own fields and its recursive fields' values (`ABSENT` where absent). */
  readonly build: (
    kind: Kind,
    own: Own,
    children: ReadonlyArray<Filled>,
  ) => Result.Result<Built, SchemaIssue.Issue>;
}

/** What a walk has found so far: the first issue, if any (an object, so the closures can set it). */
interface WalkState {
  failure: SchemaIssue.Issue | undefined;
}

/** A finished node: a class instance when decoding, a JSON record when encoding. */
type Built = object;

/** A recursive field's finished value, shaped like its template. */
type Filled =
  | Built
  | undefined
  | typeof ABSENT
  | ReadonlyArray<Built | undefined>
  | ReadonlyArray<ReadonlyArray<Built | undefined>>;

/**
 * Walk `root` breadth first, then build the nodes from the deepest up. A
 * node's children are always met after it, so building in reverse order of
 * meeting finds every child already built. Nothing recurses.
 */
const walk = (
  root: unknown,
  rootRef: Ref,
  direction: Direction,
): Result.Result<Built | undefined, SchemaIssue.Issue> => {
  const work: Array<Work> = [{ value: root, ref: rootRef, path: undefined }];
  const frames: Array<Frame> = [];
  const state: WalkState = { failure: undefined };
  const fail = (issue: SchemaIssue.Issue): undefined => {
    state.failure = issue;
    return undefined;
  };

  const queue = (value: unknown, ref: Ref, path: Path): number =>
    work.push({ value, ref, path }) - 1;
  /** The array a recursive field holds at `path`, or `undefined` after recording the issue. */
  const array = (value: unknown, ref: Ref, path: Path): ReadonlyArray<unknown> | undefined =>
    Array.isArray(value)
      ? value
      : fail(at(path, new SchemaIssue.InvalidType(Schema.Array(refSchema(ref)).ast, value)));

  /** Queue one recursive field's nodes, returning its template. */
  const field = (node: Own, child: Child, path: Path): Template => {
    const fieldPath = down(path, child.key);
    if (!(child.key in node))
      return child.optional ? ABSENT : fail(at(fieldPath, new SchemaIssue.MissingKey(undefined)));
    const value = node[child.key];
    if (value === undefined && child.optional) return undefined;
    if (child.depth === 0) return queue(value, child.ref, fieldPath);
    const outer = array(value, child.ref, fieldPath);
    if (outer === undefined) return undefined;
    if (child.depth === 1) return outer.map((v, i) => queue(v, child.ref, down(fieldPath, i)));
    return outer.map((inner, i) => {
      const vs = array(inner, child.ref, down(fieldPath, i)) ?? [];
      return vs.map((v, j) => queue(v, child.ref, down(fieldPath, i, j)));
    });
  };

  /** Visit a queued value: resolve its kind, read its own fields, queue its children. */
  const visit = ({ value, ref, path }: Work): void => {
    const k = direction.kindOf(value, ref);
    if (SchemaIssue.isIssue(k)) return void fail(at(path, k));
    const own = direction.own(k, value);
    if (Result.isFailure(own)) return void fail(at(path, own.failure.issue));
    // SAFETY: `own` succeeded, so `value` is an object (a struct accepts nothing else).
    const node = value as Own;
    const templates = k.children.map((child) => field(node, child, path));
    frames.push({ kind: k, path, own: own.success, templates });
  };

  // visit until the work list is exhausted or a node fails
  Arr.unfold(0, (i) => {
    const item = work[i];
    if (item === undefined || state.failure !== undefined) return Option.none();
    visit(item);
    return Option.some([undefined, i + 1] as const);
  });
  if (state.failure !== undefined) return Result.fail(state.failure);

  // build from the deepest up: a frame's children have larger indexes
  const built: Array<Built> = [];
  const fill = (t: Template): Filled =>
    t === undefined || t === ABSENT
      ? t
      : Predicate.isNumber(t)
        ? built[t]
        : t.map((u) => (Predicate.isNumber(u) ? built[u] : u.map((v) => built[v])));
  Arr.unfold(frames.length - 1, (i) => {
    const frame = frames[i];
    if (frame === undefined || state.failure !== undefined) return Option.none();
    const node = direction.build(frame.kind, frame.own, frame.templates.map(fill));
    if (Result.isFailure(node)) fail(at(frame.path, node.failure));
    else built[i] = node.success;
    return Option.some([undefined, i - 1] as const);
  });
  return state.failure !== undefined ? Result.fail(state.failure) : Result.succeed(built[0]);
};

// ============================================================================
// Decoding and encoding
// ============================================================================

/** The issue a class constructor threw, from the error carrying it as its cause. */
const constructorIssue = (e: unknown): SchemaIssue.Issue =>
  Predicate.isError(e) && SchemaIssue.isIssue(e.cause)
    ? e.cause
    : new SchemaIssue.InvalidValue({ message: String(e) });

const decoding: Direction = {
  kindOf: (value, ref) => {
    if (!Predicate.isString(ref)) return ref;
    const k = Predicate.isObject(value) ? memberOf(ref, value["_tag"]) : undefined;
    return k ?? new SchemaIssue.InvalidType(UNIONS[ref].schema.ast, value);
  },
  own: (k, value) => k.decodeOwn(value),
  build: (k, own, children) => {
    const props = {
      ...own,
      ...Rec.fromEntries(
        k.children.flatMap((child, j) => {
          const value = children[j];
          return value === ABSENT ? [] : [[child.key, value] as const];
        }),
      ),
    };
    // The own fields are already decoded and checked, and the walk built each
    // child as its position's class, so only a check on a recursive field
    // (a sheet's ascending rows) is left for the constructor to run.
    if (!k.checked) return Result.succeed(new k.cls(props, { disableChecks: true }));
    return Result.mapError(
      Result.try({ try: () => new k.cls(props), catch: (e) => e }),
      constructorIssue,
    );
  },
};

const encoding: Direction = {
  kindOf: (value, ref) => {
    // as Schema's encode does: the value must be an instance of its position's class
    const k = Predicate.isString(ref)
      ? Predicate.isObject(value)
        ? memberOf(ref, value["_tag"])
        : undefined
      : ref;
    return k !== undefined && value instanceof k.cls
      ? k
      : new SchemaIssue.InvalidType(refSchema(ref).ast, value);
  },
  own: (k, value) => k.encodeOwn(value),
  build: (k, own, children) => {
    // the class's field order, as Schema's encode writes it
    const fields = k.order.flatMap(([key, j]) => {
      const value = j >= 0 ? children[j] : key in own ? own[key] : ABSENT;
      return value === ABSENT ? [] : [[key, value] as const];
    });
    return Result.succeed(Rec.fromEntries(fields));
  },
};

/**
 * Decode a document from its plain-JSON form, as `Schema.decodeUnknownResult(Document)`
 * does, without recursing: any nesting depth decodes. Fails with a
 * `SchemaError` whose issue points at the offending node.
 */
export const decodeDocumentResult = (input: unknown): Result.Result<Document, Schema.SchemaError> =>
  Result.mapBoth(walk(input, DOCUMENT, decoding), {
    onFailure: (issue) => new Schema.SchemaError(issue),
    // SAFETY: the root frame is built with the `Document` constructor.
    onSuccess: (doc) => doc as Document,
  });

/**
 * Encode a document to its plain-JSON form, as `Schema.encodeUnknownResult(Document)`
 * does, without recursing: any nesting depth encodes. Fails with a
 * `SchemaError` only for a value that isn't a well-formed `Document`.
 */
export const encodeDocumentResult = (
  document: Document,
): Result.Result<DocumentEncoded, Schema.SchemaError> =>
  Result.mapBoth(walk(document, DOCUMENT, encoding), {
    onFailure: (issue) => new Schema.SchemaError(issue),
    // SAFETY: the root is encoded field by field with `Document`'s own and recursive fields.
    onSuccess: (json) => json as DocumentEncoded,
  });

/** {@link decodeDocumentResult} as an `Effect`, failing with a `SchemaError`. */
export const decodeDocument = (input: unknown): Effect.Effect<Document, Schema.SchemaError> =>
  Effect.suspend(() => Effect.fromResult(decodeDocumentResult(input)));

/** {@link encodeDocumentResult} as an `Effect`, failing with a `SchemaError`. */
export const encodeDocument = (
  document: Document,
): Effect.Effect<DocumentEncoded, Schema.SchemaError> =>
  Effect.suspend(() => Effect.fromResult(encodeDocumentResult(document)));
