import { describe, expect, test } from "vite-plus/test";
import { AttrPolicy, policyFeatures, usedAttrFeatures } from "../../src/schema/index.ts";

describe("usedAttrFeatures", () => {
  test("reports only the populated facets", () => {
    expect(usedAttrFeatures(undefined)).toEqual([]);
    expect(usedAttrFeatures({})).toEqual([]);
    expect(usedAttrFeatures({ classes: [], data: {} })).toEqual([]);
    expect(
      usedAttrFeatures({
        id: "x",
        classes: ["a"],
        data: { k: "v" },
        style: { font: { bold: true } },
      }),
    ).toEqual(["attr.id", "attr.classes", "attr.keyValue", "attr.style"]);
  });
});

describe("policyFeatures", () => {
  test("lists the facets each built-in policy permits", () => {
    expect(policyFeatures(AttrPolicy.none)).toEqual([]);
    expect(policyFeatures(AttrPolicy.basic)).toEqual(["attr.id", "attr.classes"]);
    expect(policyFeatures(AttrPolicy.rich)).toEqual([
      "attr.id",
      "attr.classes",
      "attr.keyValue",
      "attr.style",
    ]);
  });
});
