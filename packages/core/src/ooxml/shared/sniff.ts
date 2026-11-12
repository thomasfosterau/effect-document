/**
 * Recognising an OOXML package for `detect` (#188): a zip whose main part,
 * found through `_rels/.rels` as the readers find it, has one of a format's
 * content types. Opened under the readers' zip limits, and never throws.
 */

import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { type Content, contentToBytes, type Sniff } from "../../index.ts";
import { OpcReader } from "./opc.ts";

/** What one OOXML format's main part looks like. */
export interface OpcSignature {
  /** The format's name, for the evidence. */
  readonly name: string;
  /** The conventional main part, used when `_rels/.rels` names none (`word/document.xml`). */
  readonly fallback: string;
  /** The main part's content types that mean this format. */
  readonly contentTypes: ReadonlyArray<string>;
}

/** Whether `bytes` opens as a zip: a local file header, or an empty archive's end record. */
const isZip = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);

/**
 * How well `content` matches `signature`: certain when the main part's
 * declared type is one of the format's, likelier than not when the package
 * declares no types but holds the conventional main part.
 */
export const sniffOpc = (content: Content, signature: OpcSignature): Option.Option<Sniff> => {
  const bytes = contentToBytes(content);
  if (!isZip(bytes)) return Option.none();
  const verdict = Result.try({
    try: (): Option.Option<Sniff> => {
      const pkg = new OpcReader(bytes);
      const main = pkg.rootTarget("/officeDocument", signature.fallback).replace(/^\//, "");
      const type = pkg.contentType(main);
      if (type !== undefined)
        return signature.contentTypes.includes(type)
          ? Option.some({
              confidence: 0.98,
              evidence: `ZIP with ${main} (${signature.name} main part)`,
            })
          : Option.none();
      return pkg.bytes(main) === null
        ? Option.none()
        : Option.some({
            confidence: 0.7,
            evidence: `ZIP with ${main} but no declared content types`,
          });
    },
    catch: () => undefined,
  });
  return Result.isSuccess(verdict) ? verdict.success : Option.none();
};
