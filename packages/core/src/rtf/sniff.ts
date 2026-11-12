/** Recognising RTF content for `detect` (#188): text that opens with `{\rtf`. */

import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { contentToText, type Sniffer } from "../index.ts";

/** The RTF sniffer: certain when the content, after a BOM and white space, opens with `{\rtf`. */
export const sniffRtf: Sniffer = (content) => {
  const head = (
    Predicate.isTagged(content, "Text")
      ? content.text.slice(0, 64)
      : contentToText({
          _tag: "Bytes",
          bytes: content.bytes.subarray(0, 64),
        })
  )
    .replace(/^﻿/, "")
    .trimStart();
  return head.startsWith("{\\rtf")
    ? Option.some({ confidence: 0.99, evidence: "opens with {\\rtf" })
    : Option.none();
};
