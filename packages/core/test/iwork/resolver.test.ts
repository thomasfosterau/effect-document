import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import { assert, describe, expect, test } from "vite-plus/test";
import { decodeComponent, type IworkBundle, openBundle } from "../../src/iwork/bundle.ts";
import { codecError } from "../../src/iwork/errors.ts";
import { dataInfoOf, METADATA_COMPONENT, readPackageMetadata } from "../../src/iwork/metadata.ts";
import { makeObjectResolver, referenceAt } from "../../src/iwork/resolver.ts";
import { inShowOrder, showOrder } from "../../src/iwork/show.ts";
import { KN_SLIDE_ARCHIVE } from "../../src/iwork/registry.ts";
import { parseMessage } from "../../src/iwork/protobuf.ts";
import { loadFixtures } from "./fixture.ts";
import { lenField, varintField } from "./encode.ts";

const fixture = await loadFixtures([
  "simple-oneslide.key",
  "test-1.numbers",
  "simple-oneslide.iwa",
]);

/** The opened fixture bundle. */
const bundleOf = (name: string): IworkBundle => {
  const opened = openBundle(fixture(name));
  assert(Result.isSuccess(opened), `could not open ${name}`);
  return opened.success;
};

/** A bundle of the given components and nothing else. */
const bundleWith = (components: Record<string, Uint8Array>): IworkBundle => ({
  components,
  entries: Rec.keys(components),
  readEntry: (path) => Effect.fail(codecError("Io", `no entry ${path}`)),
});

/** Success, or a failed test. */
const ok = <A, E>(r: Result.Result<A, E>): A => {
  assert(Result.isSuccess(r), "expected success");
  return r.success;
};

describe("package metadata (#101)", () => {
  test("lists a Keynote package's components and data files", () => {
    const bundle = bundleOf("simple-oneslide.key");
    const metadata = ok(readPackageMetadata(bundle));
    assert(Option.isSome(metadata));
    const { components, datas, fileFormatVersion } = metadata.value;
    expect(fileFormatVersion).toBe("3.2.13");
    expect(components).toHaveLength(19);
    // every listed component is in the package, at the path the locator names
    expect(components.every((c) => bundle.components[c.path] !== undefined)).toBe(true);
    expect(components.find((c) => c.identifier === 7915n)?.path).toBe("Index/MasterSlide-7915.iwa");
    expect(datas).toHaveLength(22);
    // a stored data file is at its file name; a theme's stock image is not in the package
    expect(Option.flatMap(dataInfoOf(metadata.value, 227n), (d) => d.path)).toEqual(
      Option.some("Data/mt-E2298BC6-2981-4132-B2DD-DF3EFA1F2546-227.jpg"),
    );
    expect(bundle.entries).toContain("Data/mt-E2298BC6-2981-4132-B2DD-DF3EFA1F2546-227.jpg");
    expect(Option.flatMap(dataInfoOf(metadata.value, 8n), (d) => d.path)).toEqual(Option.none());
  });

  test("reads a Numbers package's version and every component path", () => {
    const bundle = bundleOf("test-1.numbers");
    const metadata = ok(readPackageMetadata(bundle));
    assert(Option.isSome(metadata));
    expect(metadata.value.fileFormatVersion).toBe("11.0.3");
    expect(metadata.value.readVersion).toEqual([2, 4, 0]);
    expect(metadata.value.components).toHaveLength(96);
    expect(metadata.value.components.every((c) => bundle.components[c.path] !== undefined)).toBe(
      true,
    );
  });

  test("is None for a package without Index/Metadata.iwa", () => {
    const bundle = bundleWith({ "Index/Document.iwa": fixture("simple-oneslide.iwa") });
    expect(ok(readPackageMetadata(bundle))).toEqual(Option.none());
  });

  test("a malformed metadata component fails, located at it", () => {
    const failed = readPackageMetadata(
      bundleWith({ [METADATA_COMPONENT]: new Uint8Array([0, 9, 0, 0, 1]) }),
    );
    assert(Result.isFailure(failed));
    expect(failed.failure.component).toBe(METADATA_COMPONENT);
  });
});

describe("object resolver (#101)", () => {
  test("resolves a component's root by decoding that component only", () => {
    const resolver = ok(makeObjectResolver(bundleOf("simple-oneslide.key")));
    const slide = ok(resolver.resolve(8060n));
    assert(Option.isSome(slide));
    expect(slide.value.messages.some((m) => KN_SLIDE_ARCHIVE.has(m.type))).toBe(true);
    expect(resolver.decoded()).toEqual(["Index/Slide-8060.iwa"]);
  });

  test("caches: a second lookup decodes nothing more", () => {
    const resolver = ok(makeObjectResolver(bundleOf("simple-oneslide.key")));
    ok(resolver.resolve(7915n));
    const before = resolver.decoded();
    ok(resolver.resolve(7915n));
    expect(resolver.decoded()).toEqual(before);
  });

  test("finds an object no hint names by scanning, and says None for one nowhere", () => {
    const bundle = bundleOf("simple-oneslide.key");
    const resolver = ok(makeObjectResolver(bundle));
    // object 1 is the document root inside Index/Document.iwa, which no reference hints at
    expect(Option.isSome(ok(resolver.resolve(1n)))).toBe(true);
    expect(ok(resolver.resolve(999_999_999n))).toEqual(Option.none());
    expect(resolver.decoded()).toHaveLength(Rec.keys(bundle.components).length);
  });

  test("works without metadata, by scanning", () => {
    const bundle = bundleWith({ "Index/Slide.iwa": fixture("simple-oneslide.iwa") });
    const resolver = ok(makeObjectResolver(bundle));
    expect(resolver.metadata).toEqual(Option.none());
    const last = ok(decodeComponent(bundle, "Index/Slide.iwa")).at(-1);
    assert(last !== undefined);
    expect(ok(resolver.resolve(last.identifier))).toEqual(Option.some(last));
  });
});

describe("referenceAt (#101)", () => {
  test("reads the identifier of a TSP.Reference field", () => {
    const message = parseMessage(new Uint8Array(lenField(3, varintField(1, 8060))));
    expect(referenceAt(message, 3)).toEqual(Option.some(8060n));
    expect(referenceAt(message, 4)).toEqual(Option.none());
  });
});

describe("Keynote show order (#99)", () => {
  test("a real deck's slide tree names its slide", () => {
    expect(ok(showOrder(bundleOf("simple-oneslide.key")))).toEqual(Option.some([8060n]));
  });

  test("is None without a document root to start from", () => {
    expect(
      ok(showOrder(bundleWith({ "Index/Slide.iwa": fixture("simple-oneslide.iwa") }))),
    ).toEqual(Option.none());
  });

  test("sorts slide components by their slide's place, unlisted ones last", () => {
    const paths = [
      "Index/Slide-1.iwa",
      "Index/Slide-2.iwa",
      "Index/Slide-2-2.iwa",
      "Index/Slide-3.iwa",
    ];
    expect(inShowOrder(paths, [3n, 2n])).toEqual([
      "Index/Slide-3.iwa",
      "Index/Slide-2.iwa",
      "Index/Slide-2-2.iwa",
      "Index/Slide-1.iwa",
    ]);
  });
});
