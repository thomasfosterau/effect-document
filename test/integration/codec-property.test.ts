/**
 * The stack-safe Document codec agrees with the Schema codec (#191): on random
 * documents of every family, it encodes to the same JSON (key order included)
 * and decodes that JSON to the same document.
 */

import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { assert, describe, test } from "vite-plus/test";
import {
  decodeDocumentResult,
  Document,
  encodeDocumentResult,
  Profiles,
} from "@thomasfosterau/effect-document";
import { arbitraryDocument, type Family } from "../arbitrary.ts";

const toJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** A result as text: its JSON (so key order counts), or its failure. */
const json = <A, E>(r: Result.Result<A, E>): string =>
  Result.match(r, { onSuccess: toJson, onFailure: (e) => `failed: ${String(e)}` });

const agrees = (doc: Document): boolean => {
  const ours = encodeDocumentResult(doc);
  const theirs = Schema.encodeUnknownResult(Document)(doc);
  if (json(ours) !== json(theirs) || Result.isFailure(theirs)) return false;
  const back = decodeDocumentResult(theirs.success);
  const expected = Schema.decodeUnknownResult(Document)(theirs.success);
  // compare the decoded documents by their (Schema) encoding, which is total over valid documents
  return (
    Result.isSuccess(back) &&
    Result.isSuccess(expected) &&
    back.success instanceof Document &&
    json(Schema.encodeUnknownResult(Document)(back.success)) ===
      json(Schema.encodeUnknownResult(Document)(expected.success))
  );
};

describe("the stack-safe Document codec agrees with the Schema codec (#191)", () => {
  const families: ReadonlyArray<Family> = ["prose", "sheet", "deck"];
  test.each(families)(
    "%s documents",
    async (family) => {
      const result = await Effect.runPromise(
        Arbitrary.checkEffect(
          arbitraryDocument(Profiles.Full, family),
          (doc) => Effect.sync(() => agrees(doc)),
          { runs: 100, seed: 191, size: 10 },
        ),
      );
      assert.strictEqual(Arbitrary.formatCheckFailure(result), undefined);
      // (generous: the deck documents are large, and coverage instrumentation slows them)
    },
    120_000,
  );
});
