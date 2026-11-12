/**
 * Inherited lists in real decks (#82): Apache POI's `45545_Comment.pptx` and
 * `45541_Footer.pptx` state no bullet on any paragraph (their bullets come from
 * the master's `bodyStyle`), so a reader that sees only explicit bullets finds
 * no list in them. Skips when the corpus is not fetched (`vp run corpora:fetch`).
 */
import { layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { strFromU8, unzipSync } from "fflate";
import { assert, describe, expect } from "vite-plus/test";
import { type Block, bytes } from "@thomasfosterau/effect-document";
import { makePptxReader } from "../../packages/core/src/ooxml/pptx/index.ts";

const POI_COMMIT = "064406bd5a2ac5b7e38f060882ffe4b48cc16615";

/** The list items under `blocks`, nested ones included. */
const itemCount = (blocks: ReadonlyArray<Block>): number =>
  blocks.reduce(
    (n, b) =>
      Predicate.isTagged(b, "BulletList") || Predicate.isTagged(b, "OrderedList")
        ? n + b.items.reduce((m, item) => m + 1 + itemCount(item), 0)
        : n,
    0,
  );

layer(NodeServices.layer)((it) => {
  describe("PPTX inheritance on real decks (#82)", () => {
    it.effect.each(["45545_Comment.pptx", "45541_Footer.pptx"])(
      "%s: lists that only the master states are read",
      (name, ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const file = path.join(
            yield* path.fromFileUrl(new URL("../../", import.meta.url)),
            ".corpora/apache-poi",
            POI_COMMIT,
            "test-data/slideshow",
            name,
          );
          ctx.skip(!(yield* fs.exists(file)));
          const data = yield* fs.readFile(file);
          // none of the slides states a bullet of its own
          const explicit = Rec.toEntries(unzipSync(data))
            .filter(([part]) => /^ppt\/slides\/slide\d+\.xml$/.test(part))
            .map(([, xml]) => strFromU8(xml))
            .filter((xml) => /<a:bu(Char|AutoNum|Blip)/.test(xml));
          expect(explicit).toEqual([]);
          const doc = yield* makePptxReader().read(bytes(data));
          const deck = doc.blocks.find((b) => Predicate.isTagged(b, "SlideShow"));
          assert(deck !== undefined, "expected a slide show");
          const items = deck.slides.flatMap((s) =>
            s.shapes.map((sh) =>
              Predicate.isTagged(sh, "Placeholder") || Predicate.isTagged(sh, "TextBox")
                ? itemCount(sh.content)
                : 0,
            ),
          );
          expect(items.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
          expect(deck.slides.map((s) => s.layout)).toContain("Title and Content");
        }),
    );
  });
});
