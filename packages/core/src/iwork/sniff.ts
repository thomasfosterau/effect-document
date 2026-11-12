/**
 * Recognising an iWork package for `detect` (#188), and which app made it:
 * the bundle opens under the readers' zip limits, and the root object of
 * `Index/Document.iwa` (identifier 1) says Pages (`TP.DocumentArchive`) or
 * Keynote / Numbers, which share a type id (#99) and are told apart by
 * Keynote's `Slide-*.iwa` components.
 */

import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import { contentToBytes, type Content, type Sniff, type Sniffer } from "../index.ts";
import { decodeIwa } from "./archive.ts";
import { openBundle } from "./bundle.ts";
import { KN_DOCUMENT_ARCHIVE, TP_DOCUMENT_ARCHIVE } from "./registry.ts";

/** The iWork app a package comes from. */
type IworkApp = "pages" | "keynote" | "numbers";

/** A Keynote slide or master-slide component. */
const SLIDE_COMPONENT = /^Index\/(?:Master)?Slide-\d+(?:-\d+)?\.iwa$/;

/** The app `content` comes from, with the reason, or none when it isn't an iWork package. */
const iworkApp = (content: Content): Option.Option<{ app: IworkApp; why: string }> => {
  const bytes = contentToBytes(content);
  // a zip's local file header: anything else isn't worth opening
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return Option.none();
  const bundle = openBundle(bytes);
  if (Result.isFailure(bundle)) return Option.none();
  const { components } = bundle.success;
  const document = components["Index/Document.iwa"];
  if (document === undefined) return Option.none();
  const slides = Rec.keys(components).some((path) => SLIDE_COMPONENT.test(path));
  const objects = decodeIwa(document);
  const root = Result.isSuccess(objects)
    ? objects.success.find((o) => o.identifier === 1n)?.messages[0]?.type
    : undefined;
  if (root === TP_DOCUMENT_ARCHIVE)
    return Option.some({ app: "pages", why: "iWork package with a TP.DocumentArchive root" });
  if (root === KN_DOCUMENT_ARCHIVE)
    return Option.some(
      slides
        ? { app: "keynote", why: "iWork package with slide components" }
        : { app: "numbers", why: "iWork package with no slide components" },
    );
  // an unreadable or unknown root: the component layout alone, a weaker guess
  return Option.some({
    app: slides ? "keynote" : "pages",
    why: "iWork package with an unrecognised document root",
  });
};

/** The sniffer for one app: certain for its own packages, absent for the others. */
const sniffApp =
  (app: IworkApp): Sniffer =>
  (content) =>
    Option.flatMap(iworkApp(content), (found): Option.Option<Sniff> =>
      found.app === app
        ? Option.some({
            confidence: found.why.includes("unrecognised") ? 0.6 : 0.97,
            evidence: found.why,
          })
        : Option.none(),
    );

/** The Keynote sniffer, for `detect`. */
export const sniffKeynote: Sniffer = sniffApp("keynote");
/** The Numbers sniffer, for `detect`. */
export const sniffNumbers: Sniffer = sniffApp("numbers");
/** The Pages sniffer, for `detect`. */
export const sniffPages: Sniffer = sniffApp("pages");
