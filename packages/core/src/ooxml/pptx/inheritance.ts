/**
 * PPTX style inheritance (#82): the list structure and run marks a shape
 * inherits instead of repeating on every paragraph.
 *
 * Most text in a real deck states no bullet of its own. A paragraph's
 * properties come from the first level of this chain that sets them: its own
 * `a:pPr` / `a:rPr`, the shape's `a:lstStyle`, the matching layout
 * placeholder's `a:lstStyle`, the matching master placeholder's, the master's
 * `p:txStyles` (title, body or other style, by the shape's kind) and
 * `p:defaultTextStyle` of `ppt/presentation.xml`. Each level of a list style
 * (`a:lvl1pPr` ... `a:lvl9pPr`) is keyed by the paragraph's `lvl`.
 *
 * This module parses and merges those styles; the reader resolves a shape's
 * nine-level table once and reads every paragraph against it. Layouts and
 * masters are loaded through the relationships and cached for the whole read
 * (a deck's slides share a handful), as is each layout placeholder's merged
 * table.
 */

import * as Arr from "effect/Array";
import { constFalse } from "effect/Function";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { Diagnostic } from "../../index.ts";
import { findChild, getAttr, type OpcReader, type XmlElement } from "../shared/index.ts";

/** The marks a run carries, which the schema keeps: bold, italic, underline, strike. */
export interface Fmt {
  readonly b: boolean;
  readonly i: boolean;
  readonly u: boolean;
  readonly strike: boolean;
}

/** A paragraph's bullet: none (`buNone`, which cancels an inherited one), a character or picture, or auto-numbering from `startAt`. */
export interface Bu {
  readonly kind: "none" | "bullet" | "ordered";
  /** `buAutoNum@startAt`, for an ordered bullet that says where it starts. */
  readonly startAt: Option.Option<number>;
}

/** What one level of a list style sets; a field that is `None` is inherited from the next style down the chain. */
interface Level {
  readonly bu: Option.Option<Bu>;
  /** `marL` in EMU. */
  readonly marL: Option.Option<number>;
  readonly b: Option.Option<boolean>;
  readonly i: Option.Option<boolean>;
  readonly u: Option.Option<boolean>;
  readonly strike: Option.Option<boolean>;
}

/** A list style: the nine levels it may set, `None` for one it does not. */
type Levels = ReadonlyArray<Option.Option<Level>>;

/** A level once the whole chain has been applied: the bullet (`None` for none), margin and the marks of a run with no `a:rPr` of its own. */
export interface ResolvedLevel {
  readonly bu: Option.Option<Bu>;
  readonly marL: Option.Option<number>;
  readonly fmt: Fmt;
}

/** A shape's nine resolved levels, indexed by the paragraph's `lvl`. */
export type ResolvedLevels = ReadonlyArray<ResolvedLevel>;

const LEVEL_COUNT = 9;

/** `lvl1pPr` ... `lvl9pPr`, by level index. */
const LEVEL_NAMES = Arr.makeBy(LEVEL_COUNT, (n) => `lvl${n + 1}pPr`);

const NO_LEVEL: Option.Option<Level> = Option.none();
const NO_MARKS: Fmt = { b: false, i: false, u: false, strike: false };

/** A level that sets nothing, for a table index out of range (never read: `lvl` is clamped to 0-8). */
export const EMPTY_LEVEL: ResolvedLevel = {
  bu: Option.none(),
  marL: Option.none(),
  fmt: NO_MARKS,
};

/** An attribute of `el`, if it has one. */
const attrOf = (el: XmlElement, name: string): Option.Option<string> =>
  Option.fromUndefinedOr(getAttr(el, name));

/** An integer attribute of `el` (if given), if it has a valid one. */
export const intAttr = (name: string, el?: XmlElement): Option.Option<number> =>
  el === undefined
    ? Option.none()
    : Option.filter(
        Option.map(attrOf(el, name), (v) => Number.parseInt(v, 10)),
        (n) => !Number.isNaN(n),
      );

/** The kind of bullet an `a:pPr` child sets, if it is a bullet element other than `buAutoNum`. */
const buKind = (name: string): Option.Option<Bu["kind"]> =>
  name === "buChar" || name === "buBlip"
    ? Option.some("bullet")
    : name === "buNone"
      ? Option.some("none")
      : Option.none();

/** The bullet an `a:pPr` (or `a:lvlNpPr`) sets, if it sets one; `buAutoNum` wins over `buChar`, as it always has. */
export const buOf = (pPr?: XmlElement): Option.Option<Bu> => {
  if (pPr === undefined) return Option.none();
  const auto = findChild(pPr, "buAutoNum");
  if (auto !== undefined)
    return Option.some({ kind: "ordered", startAt: intAttr("startAt", auto) });
  return Option.map(
    Arr.findFirst(pPr.children, (c) => buKind(c.name)),
    (kind): Bu => ({ kind, startAt: Option.none() }),
  );
};

const levelOf = (pPr: XmlElement): Level => {
  const rPr = Option.fromUndefinedOr(findChild(pPr, "defRPr"));
  const mark = (name: string, on: (v: string) => boolean) =>
    Option.map(
      Option.flatMap(rPr, (r) => attrOf(r, name)),
      on,
    );
  return {
    bu: buOf(pPr),
    marL: intAttr("marL", pPr),
    b: mark("b", (v) => v === "1" || v === "true"),
    i: mark("i", (v) => v === "1" || v === "true"),
    // any underline but `none`, any strike but `noStrike`
    u: mark("u", (v) => v !== "none"),
    strike: mark("strike", (v) => v !== "noStrike"),
  };
};

/** The list style held by an `a:lstStyle` (or a master's `p:titleStyle`, `p:bodyStyle`, `p:otherStyle`, or `p:defaultTextStyle`); `None` when absent or empty. */
const parseLevels = (el?: XmlElement): Option.Option<Levels> => {
  if (el === undefined) return Option.none();
  const levels: Levels = LEVEL_NAMES.map((name) =>
    Option.map(Option.fromUndefinedOr(el.children.find((c) => c.name === name)), levelOf),
  );
  return levels.some(Option.isSome) ? Option.some(levels) : Option.none();
};

/** `near` if it is set, else `far`. */
const pick = <A>(near: Option.Option<A>, far: Option.Option<A>): Option.Option<A> =>
  Option.isSome(near) ? near : far;

const mergeLevel = (near: Option.Option<Level>, far: Option.Option<Level>): Option.Option<Level> =>
  Option.isNone(near) || Option.isNone(far)
    ? pick(near, far)
    : Option.some({
        bu: pick(near.value.bu, far.value.bu),
        marL: pick(near.value.marL, far.value.marL),
        b: pick(near.value.b, far.value.b),
        i: pick(near.value.i, far.value.i),
        u: pick(near.value.u, far.value.u),
        strike: pick(near.value.strike, far.value.strike),
      });

/** `near` laid over `far`, field by field: a field `near` sets wins, the rest is `far`'s. */
const mergeLevels = (
  near: Option.Option<Levels>,
  far: Option.Option<Levels>,
): Option.Option<Levels> =>
  Option.isNone(near) || Option.isNone(far)
    ? pick(near, far)
    : Option.some(near.value.map((level, n) => mergeLevel(level, far.value[n] ?? NO_LEVEL)));

/** The chain's styles merged, nearest first. */
const mergeChain = (chain: ReadonlyArray<Option.Option<Levels>>): Option.Option<Levels> =>
  Arr.reduceRight(chain, Option.none<Levels>(), (far, near) => mergeLevels(near, far));

const finalize = (levels: Option.Option<Levels>): ResolvedLevels =>
  Arr.makeBy(LEVEL_COUNT, (n): ResolvedLevel => {
    const l = Option.flatMap(levels, (ls) => ls[n] ?? NO_LEVEL);
    return {
      bu: Option.filter(
        Option.flatMap(l, (x) => x.bu),
        (bu) => bu.kind !== "none",
      ),
      marL: Option.flatMap(l, (x) => x.marL),
      fmt: Option.match(l, {
        onNone: () => NO_MARKS,
        onSome: (x) => ({
          b: Option.getOrElse(x.b, constFalse),
          i: Option.getOrElse(x.i, constFalse),
          u: Option.getOrElse(x.u, constFalse),
          strike: Option.getOrElse(x.strike, constFalse),
        }),
      }),
    };
  });

/** A merged style and its resolved form, built once and shared by every shape that inherits exactly it. */
interface Base {
  readonly levels: Option.Option<Levels>;
  readonly resolved: ResolvedLevels;
}

const baseOf = (levels: Option.Option<Levels>): Base => ({ levels, resolved: finalize(levels) });

/** A placeholder of a layout or master: its type, `idx` and own list style. */
interface PlaceholderEntry {
  readonly type: string;
  readonly idx: Option.Option<number>;
  readonly lst: Option.Option<Levels>;
  /** What a slide shape matching this placeholder inherits, built on first use. */
  base: Option.Option<Base>;
}

/** The base of `entry`, built by `make` the first time it is asked for. */
const baseFor = (entry: PlaceholderEntry, make: () => Base): Base => {
  if (Option.isSome(entry.base)) return entry.base.value;
  const base = make();
  entry.base = Option.some(base);
  return base;
};

/** The ST_PlaceholderType families a placeholder may stand in for: a centred title for a title, a subtitle or object for the body. */
const phFamily = (type: string): string =>
  type === "ctrTitle" ? "title" : type === "subTitle" || type === "obj" ? "body" : type;

/** The placeholder a `<p:sp>` is, if it is one. */
const placeholderEntry = (sp: XmlElement): Option.Option<PlaceholderEntry> => {
  const nvSpPr = findChild(sp, "nvSpPr");
  const nvPr = nvSpPr === undefined ? undefined : findChild(nvSpPr, "nvPr");
  const ph = nvPr === undefined ? undefined : findChild(nvPr, "ph");
  if (ph === undefined) return Option.none();
  const txBody = findChild(sp, "txBody");
  return Option.some({
    // A <p:ph> without a type is an "obj" placeholder (ST_PlaceholderType default).
    type: getAttr(ph, "type") ?? "obj",
    idx: intAttr("idx", ph),
    lst: parseLevels(txBody === undefined ? undefined : findChild(txBody, "lstStyle")),
    base: Option.none(),
  });
};

/** Add `entry` under `key` unless an earlier placeholder holds it. */
const addFirst = <K>(
  map: MutableHashMap.MutableHashMap<K, PlaceholderEntry>,
  key: K,
  entry: PlaceholderEntry,
): void => {
  if (!MutableHashMap.has(map, key)) MutableHashMap.set(map, key, entry);
};

/** The placeholders of a layout or master, found by `idx`, by exact type and by type family. */
class PlaceholderIndex {
  private readonly byIdx = MutableHashMap.empty<number, PlaceholderEntry>();
  private readonly byType = MutableHashMap.empty<string, PlaceholderEntry>();
  private readonly byFamily = MutableHashMap.empty<string, PlaceholderEntry>();

  constructor(shapes: ReadonlyArray<XmlElement>) {
    Arr.getSomes(shapes.map(placeholderEntry)).forEach((entry) => {
      Option.map(entry.idx, (idx) => addFirst(this.byIdx, idx, entry));
      addFirst(this.byType, entry.type, entry);
      addFirst(this.byFamily, phFamily(entry.type), entry);
    });
  }

  /**
   * The placeholder a shape of `type` and `idx` inherits from: the one with
   * the same `idx` if the shape has one, else the first of the same type,
   * else the first of the same family (ECMA-376 §19.3.1.36 gives the
   * attributes, not an algorithm; this is PowerPoint's order as the other
   * readers implement it).
   */
  find(type: string, idx: Option.Option<number>): Option.Option<PlaceholderEntry> {
    return Option.firstSomeOf([
      Option.flatMap(idx, (i) => MutableHashMap.get(this.byIdx, i)),
      MutableHashMap.get(this.byType, type),
      MutableHashMap.get(this.byFamily, phFamily(type)),
    ]);
  }
}

type StyleKind = "titleStyle" | "bodyStyle" | "otherStyle";

/** Which master text style a shape of `type` (`None` for a non-placeholder) takes. */
const styleKind = (type: Option.Option<string>): StyleKind =>
  Option.match(type, {
    onNone: (): StyleKind => "otherStyle",
    onSome: (t): StyleKind =>
      t === "dt" || t === "ftr" || t === "sldNum"
        ? "otherStyle"
        : t === "title" || t === "ctrTitle"
          ? "titleStyle"
          : "bodyStyle",
  });

/**
 * The `<p:sp>` shapes of a shape tree in document order, descending into
 * groups. The traversal is an unfold over an explicit stack, so a deeply
 * nested group tree cannot overflow the call stack.
 */
export const shapeElements = (spTree: XmlElement): XmlElement[] =>
  Arr.unfold(spTree.children.toReversed(), (stack) =>
    Option.map(Option.fromUndefinedOr(stack.pop()), (el) => {
      if (el.name === "grpSp") el.children.toReversed().forEach((c) => stack.push(c));
      return [el, stack] as const;
    }),
  ).filter((el) => el.name === "sp");

const shapesOf = (root: XmlElement): XmlElement[] => {
  const cSld = findChild(root, "cSld");
  const spTree = cSld === undefined ? undefined : findChild(cSld, "spTree");
  return spTree === undefined ? [] : shapeElements(spTree);
};

interface MasterInfo {
  readonly index: PlaceholderIndex;
  readonly styles: Readonly<Record<StyleKind, Option.Option<Levels>>>;
  /** What a shape with no placeholder on a layout or master inherits, by master style. */
  readonly bases: MutableHashMap.MutableHashMap<StyleKind, Base>;
}

interface LayoutInfo {
  readonly name: Option.Option<string>;
  readonly index: PlaceholderIndex;
  readonly master: Option.Option<MasterInfo>;
  /** What a shape with no matching placeholder inherits when the layout has no master, by master style. */
  readonly bases: MutableHashMap.MutableHashMap<StyleKind, Base>;
}

/** What a slide's shapes inherit from: its layout (with the layout's master), if it has one. */
export interface SlideStyles {
  /** The layout's `p:cSld@name`, if the slide has a layout that names itself. */
  readonly layoutName: Option.Option<string>;
  /**
   * The nine resolved levels of a shape: a placeholder of `type` and `idx`
   * (`None` type for a text box) with its own `a:lstStyle`, if any.
   */
  readonly levelsFor: (
    type: Option.Option<string>,
    idx: Option.Option<number>,
    lstStyle: Option.Option<XmlElement>,
  ) => ResolvedLevels;
}

const REL_LAYOUT = "/slideLayout";
const REL_MASTER = "/slideMaster";

/** The base cached in `cache` under `key`, built by `chain` the first time. */
const cachedBase = (
  cache: MutableHashMap.MutableHashMap<StyleKind, Base>,
  key: StyleKind,
  chain: () => ReadonlyArray<Option.Option<Levels>>,
): Base => {
  const found = MutableHashMap.get(cache, key);
  if (Option.isSome(found)) return found.value;
  const base = baseOf(mergeChain(chain()));
  MutableHashMap.set(cache, key, base);
  return base;
};

/**
 * The inheritance of one read: loads each slide's layout and master through
 * the relationships, once per part, and reports what is missing as
 * diagnostics (a deck that lacks a layout or master reads without the styles
 * they hold, as it did before #82).
 */
export class Inheritance {
  private readonly defaults: Option.Option<Levels>;
  private readonly masters = MutableHashMap.empty<string, Option.Option<MasterInfo>>();
  private readonly layouts = MutableHashMap.empty<string, Option.Option<LayoutInfo>>();
  private readonly reported = MutableHashMap.empty<string, true>();
  /** What a shape of a slide with no layout inherits, by master style. */
  private readonly orphanBases = MutableHashMap.empty<StyleKind, Base>();
  /** The diagnostics found so far, in order. */
  readonly diagnostics: Diagnostic[] = [];

  private readonly pkg: OpcReader;

  constructor(pkg: OpcReader, presentation: XmlElement) {
    this.pkg = pkg;
    this.defaults = parseLevels(findChild(presentation, "defaultTextStyle"));
  }

  private report(code: string, part: string, detail: string): void {
    const key = `${code}\0${part}`;
    if (MutableHashMap.has(this.reported, key)) return;
    MutableHashMap.set(this.reported, key, true);
    this.diagnostics.push({
      format: "pptx",
      stage: "read",
      code: `pptx.${code}`,
      severity: "dropped-formatting",
      path: [part],
      detail,
    });
  }

  /** A part's XML, or why it is not available: a parse failure is a diagnostic, never an error. */
  private load(code: string, part: string, owner: string): Option.Option<XmlElement> {
    const parsed = Result.try({
      try: () => this.pkg.xml(part),
      catch: (cause) => cause,
    });
    if (Result.isFailure(parsed)) {
      this.report(
        code,
        owner,
        `${part} could not be read, so ${owner} inherits no list styles from it: ${String(parsed.failure)}`,
      );
      return Option.none();
    }
    const root = Option.fromNullishOr(parsed.success);
    if (Option.isNone(root))
      this.report(code, owner, `${part} is missing, so ${owner} inherits no list styles from it`);
    return root;
  }

  /** The target of `owner`'s relationship of type `.../suffix`, if it has one. */
  private target(owner: string, suffix: string): Option.Option<string> {
    const rels = Result.try({ try: () => this.pkg.rels(owner), catch: (cause) => cause });
    return Result.isFailure(rels)
      ? Option.none()
      : Option.map(
          Arr.findFirst(rels.success, (r) => !r.external && r.type.endsWith(suffix)),
          (r) => r.target,
        );
  }

  private master(path: string, owner: string): Option.Option<MasterInfo> {
    const known = MutableHashMap.get(this.masters, path);
    if (Option.isSome(known)) return known.value;
    const info = Option.map(this.load("masterUnreadable", path, owner), (root): MasterInfo => {
      const txStyles = findChild(root, "txStyles");
      const style = (name: StyleKind) =>
        parseLevels(txStyles === undefined ? undefined : findChild(txStyles, name));
      return {
        index: new PlaceholderIndex(shapesOf(root)),
        styles: {
          titleStyle: style("titleStyle"),
          bodyStyle: style("bodyStyle"),
          otherStyle: style("otherStyle"),
        },
        bases: MutableHashMap.empty(),
      };
    });
    MutableHashMap.set(this.masters, path, info);
    return info;
  }

  private layout(path: string, owner: string): Option.Option<LayoutInfo> {
    const known = MutableHashMap.get(this.layouts, path);
    if (Option.isSome(known)) return known.value;
    const info = Option.map(this.load("layoutUnreadable", path, owner), (root): LayoutInfo => {
      const masterPath = this.target(path, REL_MASTER);
      if (Option.isNone(masterPath))
        this.report(
          "masterMissing",
          path,
          `${path} has no slide master relationship, so its slides inherit no master styles`,
        );
      const cSld = findChild(root, "cSld");
      return {
        name: Option.filter(
          Option.flatMap(Option.fromUndefinedOr(cSld), (c) => attrOf(c, "name")),
          (name) => name !== "",
        ),
        index: new PlaceholderIndex(shapesOf(root)),
        master: Option.flatMap(masterPath, (m) => this.master(m, path)),
        bases: MutableHashMap.empty(),
      };
    });
    MutableHashMap.set(this.layouts, path, info);
    return info;
  }

  /** The styles the slide at `slidePath` inherits, loading its layout and master the first time each is needed. */
  forSlide(slidePath: string): SlideStyles {
    const layoutPath = this.target(slidePath, REL_LAYOUT);
    if (Option.isNone(layoutPath))
      this.report(
        "layoutMissing",
        slidePath,
        `${slidePath} has no slide layout relationship, so it inherits no list styles`,
      );
    const layout = Option.flatMap(layoutPath, (l) => this.layout(l, slidePath));
    return {
      layoutName: Option.flatMap(layout, (l) => l.name),
      levelsFor: (type, idx, lst) => this.levelsFor(layout, type, idx, lst),
    };
  }

  /** What a shape of `kind` inherits when no placeholder of its layout or master matches it. */
  private plainBase(
    layout: Option.Option<LayoutInfo>,
    master: Option.Option<MasterInfo>,
    kind: StyleKind,
    txStyle: Option.Option<Levels>,
  ): Base {
    const cache = Option.isSome(master)
      ? master.value.bases
      : Option.isSome(layout)
        ? layout.value.bases
        : this.orphanBases;
    return cachedBase(cache, kind, () => [txStyle, this.defaults]);
  }

  private levelsFor(
    layout: Option.Option<LayoutInfo>,
    type: Option.Option<string>,
    idx: Option.Option<number>,
    own: Option.Option<XmlElement>,
  ): ResolvedLevels {
    const kind = styleKind(type);
    const master = Option.flatMap(layout, (l) => l.master);
    const txStyle = Option.flatMap(master, (m) => m.styles[kind]);
    const layoutPh = Option.flatMap(type, (t) =>
      Option.flatMap(layout, (l) => l.index.find(t, idx)),
    );
    const masterPh = Option.flatMap(type, (t) =>
      Option.flatMap(master, (m) => m.index.find(t, idx)),
    );
    const base = Option.isSome(layoutPh)
      ? // the layout placeholder's merged chain is the same for every slide using it
        baseFor(layoutPh.value, () =>
          baseOf(
            mergeChain([
              layoutPh.value.lst,
              // the master placeholder the *layout's* placeholder matches, not the slide's
              Option.flatMap(
                Option.flatMap(master, (m) =>
                  m.index.find(layoutPh.value.type, layoutPh.value.idx),
                ),
                (e) => e.lst,
              ),
              txStyle,
              this.defaults,
            ]),
          ),
        )
      : Option.isSome(masterPh)
        ? baseFor(masterPh.value, () =>
            baseOf(mergeChain([masterPh.value.lst, txStyle, this.defaults])),
          )
        : this.plainBase(layout, master, kind, txStyle);
    const lst = Option.flatMap(own, (e) => parseLevels(e));
    return Option.isNone(lst) ? base.resolved : finalize(mergeLevels(lst, base.levels));
  }
}
