/**
 * Working with the document AST - the Pandoc-style intermediate
 * representation that all formats convert through.
 *
 * Run with: bun run examples/document-ast.ts
 */

import { Effect, Schema } from "effect";
import {
  Document,
  Heading,
  Paragraph,
  Space,
  Str,
  Strong,
  cell,
  contentToText,
  document,
  documentToWorkbook,
  sheet,
  str,
  workbookOf,
  workbookToDocument,
  Csv,
} from "@thomasfosterau/effect-document";

const program = Effect.gen(function* () {
  // --- Build a document by hand ------------------------------------------
  const doc = document(
    [
      new Heading({ level: 1, content: [str("Quarterly Report")] }),
      new Paragraph({
        content: [
          str("Sales were"),
          new Space(),
          new Strong({ content: [str("up 12%")] }),
          new Space(),
          str("this quarter."),
        ],
      }),
    ],
    { title: "Q2 Report", author: "effect-document" }
  );

  // --- The AST is JSON-serializable via Effect Schema ---------------------
  const json = yield* Schema.encode(Document)(doc);
  console.log("=== Document AST as JSON (pandoc -t json equivalent) ===");
  console.log(JSON.stringify(json, null, 2).slice(0, 600), "...\n");

  // ...and can be decoded back
  const decoded = yield* Schema.decodeUnknown(Document)(json);
  console.log("Decoded blocks:", decoded.blocks.map((b) => b._tag).join(", "), "\n");

  // --- Bridge between the tabular and document layers ---------------------
  const workbook = workbookOf(
    sheet(
      "Sales",
      [
        [cell.str("North"), cell.num(42000)],
        [cell.str("South"), cell.num(38500)],
      ],
      ["region", "revenue"]
    )
  );

  // Workbook -> Document (sheets become Table blocks)
  const docFromWorkbook = yield* workbookToDocument(workbook);
  console.log(
    "=== Workbook -> Document blocks ===\n",
    docFromWorkbook.blocks.map((b) => b._tag).join(", "),
    "\n"
  );

  // Document -> Workbook (Table blocks become sheets) -> CSV
  const workbookAgain = yield* documentToWorkbook(docFromWorkbook);
  const csvOut = yield* Csv.format.writer!.writeWorkbook!(workbookAgain);
  console.log("=== ...and back out as CSV ===");
  console.log(contentToText(csvOut));
});

Effect.runPromise(program);
