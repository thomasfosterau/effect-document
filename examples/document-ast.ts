/**
 * Working with the universal document schema and the profile/subset system.
 *
 * Run with: bun run examples/document-ast.ts
 */

import { Effect, Schema } from "effect";
import {
  Document, Profiles, cell, document, header, narrow, para, str, strong, worksheet,
} from "@thomasfosterau/effect-document";

const program = Effect.gen(function* () {
  // --- Build a prose document by hand ------------------------------------
  const doc = document(
    [
      header(1, [str("Quarterly Report")]),
      para([str("Sales were "), strong([str("up 12%")]), str(" this quarter.")]),
    ],
    { title: "Q2 Report", author: "effect-document" }
  );

  // --- The whole schema is JSON-serializable via Effect Schema ------------
  const json = yield* Schema.encode(Document)(doc);
  console.log("=== Document as JSON (pandoc -t json equivalent) ===");
  console.log(JSON.stringify(json, null, 2).slice(0, 400), "...\n");
  const decoded = yield* Schema.decodeUnknown(Document)(json);
  console.log("Decoded blocks:", decoded.blocks.map((b) => b._tag).join(", "), "\n");

  // --- Profiles: which subset does a document conform to? ----------------
  console.log("Conforms to Markdown profile?", Profiles.Markdown.is(doc));
  console.log("Conforms to CSV profile?     ", Profiles.Csv.is(doc), "\n");

  // --- A spreadsheet is part of the same schema --------------------------
  const sheetDoc = document([
    worksheet(
      "Sales",
      [
        [cell.text("North"), cell.number(42000), cell.date(new Date("2026-06-30"))],
        [cell.text("South"), cell.number(38500), cell.date(new Date("2026-06-30"))],
      ],
      ["region", "revenue", "as_of"]
    ),
  ]);

  // --- Narrowing to the CSV subset is lossy, and says exactly what's lost --
  const { document: csvDoc, loss } = narrow(sheetDoc, Profiles.Csv);
  console.log("=== Narrowing a spreadsheet (with dates) to the CSV subset ===");
  console.log("Now conforms to CSV?", Profiles.Csv.is(csvDoc));
  for (const entry of loss.entries) {
    console.log(`  ${entry.action}: ${entry.feature} - ${entry.detail}`);
  }
});

Effect.runPromise(program);
