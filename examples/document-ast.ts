/**
 * Working with the universal document schema and the profile/subset system.
 *
 * Run with: vp exec tsx examples/document-ast.ts (after `vp run -r build`)
 */

import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Document,
  Profiles,
  cell,
  document,
  header,
  narrow,
  para,
  str,
  strong,
  worksheet,
} from "@thomasfosterau/effect-document";

/** The schema round-trips through JSON; pretty-printed for display. */
const DocumentJson = Schema.fromJsonString(Document, { space: 2 });

const program = Effect.fn("document-ast")(function* () {
  // --- Build a prose document by hand ------------------------------------
  const doc = document(
    [
      header(1, [str("Quarterly Report")]),
      para([str("Sales were "), strong([str("up 12%")]), str(" this quarter.")]),
    ],
    { title: "Q2 Report", author: "effect-document" },
  );

  // --- The whole schema is JSON-serializable via Effect Schema ------------
  const json = yield* Schema.encodeEffect(DocumentJson)(doc);
  yield* Console.log("=== Document as JSON (pandoc -t json equivalent) ===");
  yield* Console.log(json.slice(0, 400), "...\n");
  const decoded = yield* Schema.decodeEffect(DocumentJson)(json);
  yield* Console.log("Decoded blocks:", decoded.blocks.map((b) => b._tag).join(", "), "\n");

  // --- Profiles: which subset does a document conform to? ----------------
  yield* Console.log("Conforms to Markdown profile?", Profiles.Markdown.is(doc));
  yield* Console.log("Conforms to CSV profile?     ", Profiles.Csv.is(doc), "\n");

  // --- A spreadsheet is part of the same schema --------------------------
  const asOf = DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-30"));
  const sheetDoc = document([
    worksheet(
      "Sales",
      [
        [cell.text("North"), cell.number(42000), cell.date(asOf)],
        [cell.text("South"), cell.number(38500), cell.date(asOf)],
      ],
      ["region", "revenue", "as_of"],
    ),
  ]);

  // --- Narrowing to the CSV subset is lossy, and says exactly what's lost --
  const { document: csvDoc, loss } = narrow(sheetDoc, Profiles.Csv);
  yield* Console.log("=== Narrowing a spreadsheet (with dates) to the CSV subset ===");
  yield* Console.log("Now conforms to CSV?", Profiles.Csv.is(csvDoc));
  yield* Effect.forEach(
    loss.entries,
    (entry) => Console.log(`  ${entry.action}: ${entry.feature} - ${entry.detail}`),
    { concurrency: 1 },
  );
});

Effect.runPromise(program());
