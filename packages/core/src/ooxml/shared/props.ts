/**
 * Package metadata (#79): the core-properties part (`docProps/core.xml`, ECMA-376
 * Part 2, Dublin Core) and the extended-properties part (`docProps/app.xml`)
 * mapped to and from `Document.meta`, for DOCX, XLSX and PPTX alike.
 *
 * The keys follow the PDF format's (`title`, `author`, `subject`, `keywords`,
 * `creator` for the producing application, `lang`), so a conversion carries
 * them across. Values are strings: an empty or blank one is not read, and on
 * write only a non-empty string is written. Nothing is invented: no date is
 * taken from the clock.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import type { Diagnostic, Meta } from "../../index.ts";
import { XML_DECL, type OpcReader } from "./opc.ts";
import { escapeXml, type XmlElement } from "./xml.ts";

const NS_CP = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_DCTERMS = "http://purl.org/dc/terms/";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const NS_APP = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";

/** The `Application` written when `meta.creator` names none. */
const DEFAULT_APPLICATION = "effect-document";

/** The core-properties part's path in a package we write. */
const CORE_PATH = "docProps/core.xml";
/** The extended-properties part's path in a package we write. */
const APP_PATH = "docProps/app.xml";

const CT_CORE_PROPS = "application/vnd.openxmlformats-package.core-properties+xml";
const CT_APP_PROPS = "application/vnd.openxmlformats-officedocument.extended-properties+xml";
const REL_CORE_PROPS = `http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties`;
const REL_APP_PROPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";

/** One core property: the `meta` key, the element's namespace, prefix and local name, and whether it is a W3CDTF date. */
interface CoreField {
  readonly key: string;
  readonly ns: string;
  readonly prefix: string;
  readonly name: string;
  readonly date: boolean;
}

const field = (key: string, ns: string, prefix: string, name: string, date = false): CoreField => ({
  key,
  ns,
  prefix,
  name,
  date,
});

/** The core properties in the order they are written. */
const CORE_FIELDS: ReadonlyArray<CoreField> = [
  field("title", NS_DC, "dc", "title"),
  field("subject", NS_DC, "dc", "subject"),
  field("author", NS_DC, "dc", "creator"),
  field("keywords", NS_CP, "cp", "keywords"),
  field("description", NS_DC, "dc", "description"),
  field("lastModifiedBy", NS_CP, "cp", "lastModifiedBy"),
  field("revision", NS_CP, "cp", "revision"),
  field("category", NS_CP, "cp", "category"),
  field("contentStatus", NS_CP, "cp", "contentStatus"),
  field("lang", NS_DC, "dc", "language"),
  field("created", NS_DCTERMS, "dcterms", "created", true),
  field("modified", NS_DCTERMS, "dcterms", "modified", true),
];

const W3CDTF =
  /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?)?)?$/;

/** Whether `s` is a W3CDTF date: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a date with `Thh:mm[:ss[.s]]` and `Z` or `±hh:mm`. */
const isW3cdtf = (s: string): boolean => W3CDTF.test(s);

/** `meta[key]` when it is a non-empty string. */
const stringOf = (meta: Meta, key: string): Option.Option<string> => {
  const value = meta[key];
  return Predicate.isString(value) && value !== "" ? Option.some(value) : Option.none();
};

/** The date keys of `meta` that hold a string but not a W3CDTF date: not written. */
const invalidDates = (meta: Meta): ReadonlyArray<string> =>
  CORE_FIELDS.filter(
    (f) => f.date && Option.exists(stringOf(meta, f.key), (value) => !isW3cdtf(value)),
  ).map((f) => f.key);

/**
 * The core-properties part (`docProps/core.xml`) for `meta`: each string value
 * under the keys `title`, `subject`, `author`, `keywords`, `description`,
 * `lastModifiedBy`, `revision`, `category`, `contentStatus`, `lang`, `created`
 * and `modified`. Other keys, and values that aren't non-empty strings, are
 * left out; `created` / `modified` are written only when they are valid W3CDTF
 * (see {@link metadataDiagnostics}). With no such key the part is empty.
 */
export const corePropsXml = (meta: Meta): string => {
  const skipped = invalidDates(meta);
  const elements = CORE_FIELDS.flatMap((f) =>
    skipped.includes(f.key)
      ? []
      : Arr.fromOption(
          Option.map(
            stringOf(meta, f.key),
            (value) =>
              `<${f.prefix}:${f.name}${f.date ? ' xsi:type="dcterms:W3CDTF"' : ""}>${escapeXml(value)}</${f.prefix}:${f.name}>`,
          ),
        ),
  );
  const open =
    XML_DECL +
    `<cp:coreProperties xmlns:cp="${NS_CP}" xmlns:dc="${NS_DC}" xmlns:dcterms="${NS_DCTERMS}" xmlns:xsi="${NS_XSI}"`;
  return Arr.isReadonlyArrayEmpty(elements)
    ? open + "/>"
    : open + ">" + elements.join("") + "</cp:coreProperties>";
};

/**
 * The extended-properties part (`docProps/app.xml`) for `meta`: the
 * `Application` is `meta.creator` when that is a non-empty string, else
 * `effect-document`.
 */
export const appPropsXml = (meta: Meta): string =>
  XML_DECL +
  `<Properties xmlns="${NS_APP}">` +
  `<Application>${escapeXml(Option.getOrElse(stringOf(meta, "creator"), () => DEFAULT_APPLICATION))}</Application>` +
  `</Properties>`;

/** The two property parts of a package we write, by path. */
export const propsParts = (meta: Meta) =>
  ({ [CORE_PATH]: corePropsXml(meta), [APP_PATH]: appPropsXml(meta) }) as const;

/** The `[Content_Types].xml` overrides for {@link propsParts}. */
export const PROPS_CONTENT_TYPES =
  `<Override PartName="/${CORE_PATH}" ContentType="${CT_CORE_PROPS}"/>` +
  `<Override PartName="/${APP_PATH}" ContentType="${CT_APP_PROPS}"/>`;

/** The `_rels/.rels` relationships for {@link propsParts}, under the ids `coreId` and `appId`. */
export const propsRelationships = (coreId: string, appId: string): string =>
  `<Relationship Id="${coreId}" Type="${REL_CORE_PROPS}" Target="${CORE_PATH}"/>` +
  `<Relationship Id="${appId}" Type="${REL_APP_PROPS}" Target="${APP_PATH}"/>`;

/**
 * The diagnostics a writer reports once after writing `meta`: one
 * `<format>.metadataSkipped` (`dropped-content`, at `["meta", key]`) for each
 * `created` / `modified` value that is not a W3CDTF date and so was not written.
 */
export const metadataDiagnostics = (format: string, meta: Meta): ReadonlyArray<Diagnostic> =>
  invalidDates(meta).map((key): Diagnostic => ({
    format,
    stage: "write",
    code: `${format}.metadataSkipped`,
    severity: "dropped-content",
    path: ["meta", key],
    detail: `meta.${key} is not a W3CDTF date (YYYY, YYYY-MM, YYYY-MM-DD or a date-time with a zone): not written`,
  }));

// ============================================================================
// Reading
// ============================================================================

/** The text of the first child of `root` in namespace `ns` named `name`, trimmed; none when absent or blank. */
const childText = (root: XmlElement, ns: string, name: string): Option.Option<string> =>
  Option.filter(
    Option.map(
      Option.fromUndefinedOr(root.children.find((c) => c.ns === ns && c.name === name)),
      (el) => el.text.trim(),
    ),
    (text) => text !== "",
  );

/** The keys of `core` (a core-properties root) that `meta` carries. */
const coreMeta = (core: XmlElement): Record<string, string> =>
  Rec.fromEntries(
    CORE_FIELDS.flatMap((f) =>
      Arr.fromOption(Option.map(childText(core, f.ns, f.name), (value) => [f.key, value] as const)),
    ),
  );

/** What reading a package's property parts found: the `meta` keys, and what to report. */
export interface PackageMeta {
  /** The keys read: see {@link corePropsXml} (and `creator` from the `Application`). */
  readonly meta: Readonly<Record<string, string>>;
  /** One `<format>.metadataUnreadable` for each property part that could not be read. */
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

const unreadable = (format: string, part: string, cause: unknown): Diagnostic => ({
  format,
  stage: "read",
  code: `${format}.metadataUnreadable`,
  severity: "dropped-content",
  path: [part],
  detail: `${part} could not be read, so its properties are dropped: ${String(cause)}`,
});

/** Read one property part found through the package relationships, never failing. */
const readPart = (
  pkg: OpcReader,
  format: string,
  relSuffix: string,
  read: (root: XmlElement) => Record<string, string>,
): readonly [Record<string, string>, ReadonlyArray<Diagnostic>] => {
  const located = Result.try({
    try: () =>
      Option.fromUndefinedOr(pkg.rels("").find((r) => !r.external && r.type.endsWith(relSuffix))),
    catch: (cause) => unreadable(format, "_rels/.rels", cause),
  });
  if (Result.isFailure(located)) return [{}, [located.failure]];
  if (Option.isNone(located.success)) return [{}, []];
  const target = located.success.value.target;
  const parsed = Result.try({
    try: () => Option.fromNullishOr(pkg.xml(target)),
    catch: (cause) => unreadable(format, target, cause),
  });
  return Result.isFailure(parsed)
    ? [{}, [parsed.failure]]
    : [Option.match(parsed.success, { onNone: () => ({}), onSome: read }), []];
};

/**
 * The metadata an Office package carries (#79), found through the package
 * relationships (`/metadata/core-properties` and `/extended-properties`) and
 * matched by namespace URI and local name, so any prefix works. Never throws:
 * a missing part gives no keys, and an unreadable one is reported in
 * `diagnostics` while the rest is read.
 */
export const readPackageMeta = (pkg: OpcReader, format: string): PackageMeta => {
  const [core, coreNotes] = readPart(pkg, format, "/metadata/core-properties", coreMeta);
  const [app, appNotes] = readPart(pkg, format, "/extended-properties", (root) =>
    Option.match(childText(root, NS_APP, "Application"), {
      onNone: () => ({}),
      onSome: (value) => ({ creator: value }),
    }),
  );
  return { meta: { ...core, ...app }, diagnostics: [...coreNotes, ...appNotes] };
};
