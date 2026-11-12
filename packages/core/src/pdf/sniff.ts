/**
 * Recognising PDF content for `detect` (#188): the `%PDF-` header, which
 * readers accept anywhere in the first kilobyte (junk before it is common),
 * or, without one, an object definition opening the file, which the reader
 * reads too (#173).
 */

import * as Option from "effect/Option";
import { contentToBytes, type Sniffer } from "../index.ts";
import { opensWithObject } from "./cos/file.ts";

/** How far into the input the `%PDF-` header may start. */
const HEADER_WINDOW = 1024;
const HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Whether `bytes` holds the PDF header at `at`. */
const headerAt = (bytes: Uint8Array, at: number): boolean =>
  HEADER.every((b, i) => bytes[at + i] === b);

/**
 * The PDF sniffer: certain when the `%PDF-` header opens the first kilobyte;
 * fairly sure (0.9, above any text guess) when it doesn't but an object
 * definition does, as a headerless PDF the reader still opens.
 */
export const sniffPdf: Sniffer = (content) => {
  const bytes = contentToBytes(content);
  const limit = Math.min(HEADER_WINDOW, bytes.length - HEADER.length + 1);
  const at = Array.from({ length: Math.max(0, limit) }, (_, i) => i).find((i) =>
    headerAt(bytes, i),
  );
  if (at !== undefined)
    return Option.some({
      confidence: at === 0 ? 0.99 : 0.95,
      evidence: at === 0 ? "%PDF- header" : `%PDF- header at byte ${at}`,
    });
  return opensWithObject(bytes)
    ? Option.some({
        confidence: 0.9,
        evidence: "an object definition opens it, with no %PDF- header",
      })
    : Option.none();
};
