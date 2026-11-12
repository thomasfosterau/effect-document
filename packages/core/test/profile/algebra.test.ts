import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { describe, expect, test } from "vite-plus/test";
import {
  CellRichText,
  document,
  header,
  link,
  para,
  str,
  strong,
  worksheet,
} from "../../src/schema/index.ts";
import {
  defineProfile,
  extendProfile,
  intersectProfiles,
  isSubProfile,
  profileOf,
  Profiles,
  unionProfiles,
  withoutFeatures,
} from "../../src/profile/index.ts";

const Prose = defineProfile("prose", ["block.para", "inline.str", "inline.strong"]);
const Headed = defineProfile("headed", ["block.para", "block.header", "inline.str"], {
  notWithin: [{ feature: "inline.strong", within: "block.header", reason: "bold headings" }],
});

describe("profile algebra (#126)", () => {
  test("a union allows what either side allows, keeping only shared rules", () => {
    const Both = unionProfiles("both", Prose, Headed);
    expect(Arr.sort([...Both.features], Order.String)).toEqual(
      Arr.sort(["block.header", "block.para", "inline.str", "inline.strong"], Order.String),
    );
    // Prose allows Strong anywhere, so the union can't keep Headed's rule
    expect(Both.notWithin).toEqual([]);
    expect(Both.is(document([header(1, [strong([str("x")])])]))).toBe(true);
  });

  test("an intersection allows only what both allow, under every rule of either", () => {
    const Common = intersectProfiles("common", Prose, Headed);
    expect(Arr.sort([...Common.features], Order.String)).toEqual(
      Arr.sort(["block.para", "inline.str"], Order.String),
    );
    expect(Common.notWithin).toEqual(Headed.notWithin);
  });

  test("without drops the features and the rules about them", () => {
    const NoHeaders = withoutFeatures("no-headers", Headed, ["block.header"] as const);
    expect(NoHeaders.features.has("block.header")).toBe(false);
    expect(NoHeaders.notWithin).toEqual([]);
    expect(NoHeaders.is(document([header(1, [str("x")])]))).toBe(false);
  });

  test("without attr.id drops every per-node id facet; extend attr.id adds them", () => {
    const Ids = defineProfile("ids", ["block.header", "inline.str", "attr.id"]);
    expect(Ids.features.has("attr.id.header")).toBe(true);
    const NoIds = withoutFeatures("no-ids", Ids, ["attr.id"] as const);
    expect([...NoIds.features].some((f) => f.startsWith("attr.id"))).toBe(false);
    expect(
      extendProfile("ids-again", NoIds, ["attr.id"] as const).features.has("attr.id.header"),
    ).toBe(true);
  });

  test("extend adds features and keeps the rules", () => {
    const More = extendProfile("more", Headed, ["inline.strong", "inline.emph"] as const);
    expect(More.features.has("inline.emph")).toBe(true);
    expect(More.notWithin).toEqual(Headed.notWithin);
  });

  test("isSubProfile compares features and the rules that bite", () => {
    expect(isSubProfile(Profiles.Csv, Profiles.Spreadsheet)).toBe(true);
    expect(isSubProfile(Profiles.Spreadsheet, Profiles.Csv)).toBe(false);
    // Prose allows Strong everywhere; Headed's rule about Strong only bites if Prose had headers
    expect(isSubProfile(defineProfile("p", ["block.para", "inline.str"]), Headed)).toBe(true);
    const HeadedBold = extendProfile("hb", withoutFeatures("h", Headed, []), [
      "inline.strong",
    ] as const);
    const Loose = defineProfile("loose", [
      "block.para",
      "block.header",
      "inline.str",
      "inline.strong",
    ]);
    // Loose lacks Headed's rule, so it accepts a bold heading Headed (+strong) refuses
    expect(isSubProfile(Loose, HeadedBold)).toBe(false);
    expect(isSubProfile(HeadedBold, Loose)).toBe(true);
  });

  test("profileOf is the smallest profile a document conforms to", () => {
    const doc = document([para([str("a"), strong([str("b")])])]);
    const Own = profileOf(doc);
    expect(Arr.sort([...Own.features], Order.String)).toEqual([
      "block.para",
      "inline.str",
      "inline.strong",
    ]);
    expect(Own.is(doc)).toBe(true);
    expect(isSubProfile(Own, Prose)).toBe(true);
    expect(isSubProfile(Own, Headed)).toBe(false);
  });
});

const TITLES = {
  feature: "block.header",
  within: "shape.placeholder",
  where: { field: "kind", oneOf: ["title", "ctrTitle"] },
  reason: "titles only",
} as const;
const UNSCOPED = {
  feature: "block.header",
  within: "shape.placeholder",
  reason: "any placeholder",
} as const;
const LEVELS = {
  feature: "block.header",
  field: "level",
  oneOf: [1, 2],
  reason: "two levels",
} as const;
const Deck = defineProfile(
  "deck",
  ["deck.slideShow", "shape.placeholder", "block.header", "inline.str"],
  {
    onlyWithin: [TITLES],
    fieldValues: [LEVELS],
  },
);
const LooseDeck = defineProfile(
  "loose-deck",
  ["deck.slideShow", "shape.placeholder", "block.header", "inline.str"],
  { onlyWithin: [UNSCOPED] },
);

describe("profile algebra over onlyWithin and fieldValues rules (#126)", () => {
  test("a rule's condition is part of its identity: a union keeps only identical rules", () => {
    expect(unionProfiles("same", Deck, Deck).onlyWithin).toEqual([TITLES]);
    expect(unionProfiles("same", Deck, Deck).fieldValues).toEqual([LEVELS]);
    const Either = unionProfiles("either", Deck, LooseDeck);
    expect(Either.onlyWithin).toEqual([]);
    expect(Either.fieldValues).toEqual([]);
  });

  test("an intersection keeps every rule once", () => {
    const Both = intersectProfiles("both", Deck, LooseDeck);
    expect(Both.onlyWithin).toEqual([TITLES, UNSCOPED]);
    expect(Both.fieldValues).toEqual([LEVELS]);
    expect(intersectProfiles("self", Deck, Deck).onlyWithin).toEqual([TITLES]);
  });

  test("a profile with fewer rules is not a sub-profile of one with more", () => {
    expect(isSubProfile(Deck, LooseDeck)).toBe(false);
    expect(isSubProfile(intersectProfiles("both", Deck, LooseDeck), LooseDeck)).toBe(true);
    expect(isSubProfile(LooseDeck, Deck)).toBe(false);
  });
});

describe("whole rules (#67)", () => {
  const Cells = defineProfile(
    "cells",
    ["sheet.worksheet", "cell.richText", "inline.str", "inline.link"] as const,
    {
      whole: [{ feature: "inline.link", within: "cell.richText", reason: "whole cells only" }],
    },
  );
  const partly = document([
    worksheet("S", [
      [new CellRichText({ runs: [str("a"), link([str("b")], "https://example.com")] })],
    ]),
  ]);
  const wholly = document([
    worksheet("S", [[new CellRichText({ runs: [link([str("ab")], "https://example.com")] })]]),
  ]);

  test("conformance: a link that is a rich cell's only run conforms; one over part of it doesn't", () => {
    expect(Cells.is(wholly)).toBe(true);
    expect(Cells.is(partly)).toBe(false);
  });

  test("the algebra keeps a whole rule as it keeps the others", () => {
    const Loose = defineProfile("loose", [...Cells.features]);
    expect(unionProfiles("u", Cells, Loose).whole).toEqual([]);
    expect(intersectProfiles("i", Cells, Loose).whole).toEqual(Cells.whole);
    expect(withoutFeatures("w", Cells, ["inline.link"] as const).whole).toEqual([]);
    expect(extendProfile("e", Cells, ["inline.emph"] as const).whole).toEqual(Cells.whole);
    // Loose accepts a partial link Cells refuses
    expect(isSubProfile(Cells, Loose)).toBe(true);
    expect(isSubProfile(Loose, Cells)).toBe(false);
  });
});
