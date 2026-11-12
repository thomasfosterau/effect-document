/**
 * Open Packaging Conventions (OPC) helpers shared by the OOXML formats.
 *
 * An OOXML file (.xlsx/.docx/.pptx) is a ZIP of XML "parts" wired together by
 * relationship (`.rels`) files. These helpers read parts and resolve
 * relationships on the way in, and zip a set of parts on the way out.
 */

import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { ParseError as XmlSyntaxError } from "@thomasfosterau/effect-parse";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import { findChildren, getAttr, parseXmlResult, type XmlElement } from "./xml.ts";

/** A resolved relationship from a `.rels` file. */
export interface Relationship {
  readonly id: string;
  readonly type: string;
  /** Package-absolute target path (leading slash stripped), or the URI of an external target. */
  readonly target: string;
  /** True for `TargetMode="External"` (hyperlink URLs and the like). */
  readonly external: boolean;
}

/** Percent-decode a part-name URI, leaving malformed escapes as they are. */
const decodePartName = (s: string): string =>
  Result.getOrElse(
    Result.try(() => decodeURIComponent(s)),
    () => s,
  );

/** Resolve a relationship target against the base directory of its source part. */
export const resolveTarget = (baseDir: string, target: string): string => {
  const decoded = decodePartName(target.split("#")[0]!);
  if (decoded.startsWith("/")) return decoded.substring(1);
  const segments = [...baseDir.split("/").filter((s) => s !== ""), ...decoded.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== ".") resolved.push(segment);
  }
  return resolved.join("/");
};

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.substring(0, slash);
};

const fileOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.substring(slash + 1);
};

/** The name of the relationships part of the part `partPath` (`""` for the package itself). */
export const relsPartOf = (partPath: string): string => {
  const dir = dirOf(partPath);
  return (dir ? dir + "/" : "") + "_rels/" + fileOf(partPath) + ".rels";
};

/**
 * Zip-bomb limits for reading a package; any left out (or `undefined`) take the
 * {@link DEFAULT_OPC_LIMITS} value. The names and defaults match iWork's
 * `BundleLimits`, so every zip-based format is configured the same way.
 */
export interface OpcLimits {
  /** The most entries the zip may list. Defaults to 10,000. */
  readonly maxEntries?: number | undefined;
  /** The largest uncompressed size of any one part read. Defaults to 256 MiB. */
  readonly maxEntrySize?: number | undefined;
  /** The most uncompressed bytes inflated for the parts read, in total. Defaults to 512 MiB. */
  readonly maxTotalSize?: number | undefined;
}

/** {@link OpcLimits} with every limit filled in. */
export type ResolvedOpcLimits = { readonly [K in keyof OpcLimits]-?: NonNullable<OpcLimits[K]> };

/** The default {@link OpcLimits}. */
export const DEFAULT_OPC_LIMITS: ResolvedOpcLimits = {
  maxEntries: 10_000,
  maxEntrySize: 256 * 1024 * 1024,
  maxTotalSize: 512 * 1024 * 1024,
};

/** Fill in every limit left out, or explicitly `undefined`, with its default. */
const resolveLimits = (limits: OpcLimits | undefined): ResolvedOpcLimits => ({
  maxEntries: limits?.maxEntries ?? DEFAULT_OPC_LIMITS.maxEntries,
  maxEntrySize: limits?.maxEntrySize ?? DEFAULT_OPC_LIMITS.maxEntrySize,
  maxTotalSize: limits?.maxTotalSize ?? DEFAULT_OPC_LIMITS.maxTotalSize,
});

/**
 * Why a package can't be read: a broken limit, the wrong kind, a missing part,
 * not a zip at all, or a Compound File Binary container in its place
 * (`Encrypted`: a password-protected OOXML package, or a legacy binary Office
 * file, #173).
 */
export type OpcErrorKind =
  | "LimitExceeded"
  | "WrongPackageType"
  | "MissingPart"
  | "InvalidContainer"
  | "Encrypted";

/** A package that breaks a resource limit, isn't the expected kind of package, or isn't a zip. */
export class OpcError extends Error {
  readonly kind: OpcErrorKind;

  constructor(kind: OpcErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** A part whose XML is malformed, with the parser's positioned error. */
export class XmlPartError extends Error {
  readonly part: string;
  readonly failure: XmlSyntaxError.ParseError<string>;

  constructor(part: string, failure: XmlSyntaxError.ParseError<string>) {
    super(`malformed XML in /${part}: ${failure.message}`);
    this.part = part;
    this.failure = failure;
  }
}

/** Decode UTF-16 code units (an unpaired surrogate becomes U+FFFD). */
const decodeUtf16 = (b: Uint8Array, bigEndian: boolean): string => {
  const units = new Uint16Array(b.length >> 1);
  for (let i = 0; i < units.length; i++) {
    units[i] = bigEndian ? (b[2 * i]! << 8) | b[2 * i + 1]! : b[2 * i]! | (b[2 * i + 1]! << 8);
  }
  let out = "";
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode(...units.subarray(i, i + 8192));
  }
  return out.toWellFormed();
};

/** Decode a part's bytes honouring a BOM or the XML declaration's encoding (UTF-8 or UTF-16). */
export const decodePart = (b: Uint8Array): string => {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return decodeUtf16(b.subarray(2), false);
  if (b[0] === 0xfe && b[1] === 0xff) return decodeUtf16(b.subarray(2), true);
  // No BOM: UTF-16 still shows as "<\0?\0" or "\0<\0?".
  if (b[0] === 0x3c && b[1] === 0x00) return decodeUtf16(b, false);
  if (b[0] === 0x00 && b[1] === 0x3c) return decodeUtf16(b, true);
  return new TextDecoder("utf-8").decode(b);
};

interface Entry {
  readonly name: string;
  readonly originalSize: number;
}

/** The signature of a Compound File Binary (OLE2) container. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** The end-of-central-directory signature, `PK\x05\x06`. */
const EOCD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06];

/** How far from the end the end-of-central-directory record can start: its 22 bytes plus a comment of up to 64 KiB. */
const EOCD_SEARCH = 22 + 0xffff;

/** Whether `sig` is at offset `at` of `b`. */
const signatureAt = (b: Uint8Array, at: number, sig: ReadonlyArray<number>): boolean =>
  sig.every((v, i) => b[at + i] === v);

/**
 * What is wrong with a would-be package before unzipping it, if anything
 * fflate would only report as "invalid zip data" (#173): a Compound File
 * Binary container (Office keeps an encrypted OOXML package in one, and the
 * legacy `.xls` / `.doc` / `.ppt` are one), or a zip whose end-of-central-
 * directory record is missing (a truncated or streamed archive).
 */
const containerProblem = (data: Uint8Array): Option.Option<OpcError> => {
  if (signatureAt(data, 0, CFB_SIGNATURE)) {
    return Option.some(
      new OpcError(
        "Encrypted",
        "a Compound File Binary container, not a zip: an encrypted (password-protected) Office package, or a legacy binary .xls, .doc or .ppt file",
      ),
    );
  }
  const tail = data.subarray(Math.max(0, data.length - EOCD_SEARCH));
  const hasEnd = tail.some((_, i) => signatureAt(tail, i, EOCD_SIGNATURE));
  return signatureAt(data, 0, [0x50, 0x4b]) && !hasEnd
    ? Option.some(
        new OpcError(
          "InvalidContainer",
          "a zip without its central directory (truncated, or written as a stream and never finished)",
        ),
      )
    : Option.none();
};

/**
 * A read-only view over an OPC package. Parts are inflated lazily, one at a
 * time when first read, within {@link OpcLimits}; part names match
 * case-insensitively, as OPC requires.
 */
export class OpcReader {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, Uint8Array>();
  private readonly limits: ResolvedOpcLimits;
  private inflated = 0;
  private contentTypes:
    | { defaults: Map<string, string>; overrides: Map<string, string> }
    | null
    | undefined;

  private readonly data: Uint8Array;

  constructor(data: Uint8Array, limits?: OpcLimits) {
    this.data = data;
    this.limits = resolveLimits(limits);
    const notZip = containerProblem(data);
    if (Option.isSome(notZip)) throw notZip.value;
    // List the central directory without inflating anything. fflate reports
    // an unreadable archive only by throwing: it becomes the package's own
    // tagged kind (#127), and an OpcError thrown from the filter stays as it is.
    const listed = Result.try({
      try: () =>
        unzipSync(data, {
          filter: (file) => {
            if (this.entries.size >= this.limits.maxEntries) {
              throw new OpcError(
                "LimitExceeded",
                `more than ${this.limits.maxEntries} zip entries`,
              );
            }
            this.entries.set(file.name.toLowerCase(), {
              name: file.name,
              originalSize: file.originalSize,
            });
            return false;
          },
        }),
      catch: (cause) =>
        cause instanceof OpcError
          ? cause
          : new OpcError("InvalidContainer", `not a readable zip: ${String(cause)}`),
    });
    if (Result.isFailure(listed)) throw listed.failure;
  }

  /** The package's part names (as stored in the zip). */
  get partNames(): ReadonlyArray<string> {
    return [...this.entries.values()].map((e) => e.name);
  }

  /** The raw bytes of a part, or null if absent. */
  bytes(path: string): Uint8Array | null {
    const key = (path.startsWith("/") ? path.substring(1) : path).toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    // charge the declared size before inflating: fflate never inflates past it
    const { maxEntrySize, maxTotalSize } = this.limits;
    if (entry.originalSize > maxEntrySize) {
      throw new OpcError(
        "LimitExceeded",
        `${entry.name} is ${entry.originalSize} bytes uncompressed, over the ${maxEntrySize}-byte limit`,
      );
    }
    if (this.inflated + entry.originalSize > maxTotalSize) {
      throw new OpcError(
        "LimitExceeded",
        `the parts read exceed the ${maxTotalSize}-byte total limit`,
      );
    }
    const out =
      unzipSync(this.data, { filter: (file) => file.name === entry.name })[entry.name] ?? null;
    if (out === null) return null;
    this.inflated += entry.originalSize;
    this.cache.set(key, out);
    return out;
  }

  /**
   * Inflate several parts in one pass over the zip's directory, so reading
   * each later costs a lookup. Reading a part alone walks the whole directory
   * (a deck with hundreds of slides reads thousands of parts), so a reader
   * that knows its parts up front names them here. Parts that are absent or
   * already read are skipped; the limits apply as for {@link OpcReader.bytes}.
   */
  prefetch(paths: ReadonlyArray<string>): void {
    const wanted = MutableHashSet.fromIterable(
      paths.map((path) => (path.startsWith("/") ? path.substring(1) : path).toLowerCase()),
    );
    const { maxEntrySize, maxTotalSize } = this.limits;
    const found = unzipSync(this.data, {
      filter: (file) => {
        const key = file.name.toLowerCase();
        if (!MutableHashSet.has(wanted, key) || this.cache.has(key)) return false;
        if (file.originalSize > maxEntrySize) {
          throw new OpcError(
            "LimitExceeded",
            `${file.name} is ${file.originalSize} bytes uncompressed, over the ${maxEntrySize}-byte limit`,
          );
        }
        if (this.inflated + file.originalSize > maxTotalSize) {
          throw new OpcError(
            "LimitExceeded",
            `the parts read exceed the ${maxTotalSize}-byte total limit`,
          );
        }
        this.inflated += file.originalSize;
        return true;
      },
    });
    Rec.toEntries(found).forEach(([name, data]) => this.cache.set(name.toLowerCase(), data));
  }

  /** The text of a part (UTF-8 or UTF-16, by BOM or declaration), or null if absent. */
  text(path: string): string | null {
    const b = this.bytes(path);
    return b === null ? null : decodePart(b);
  }

  /**
   * A part parsed as XML, or null if absent; malformed XML throws an
   * {@link XmlPartError}. `fastContentOf` names an element whose content is
   * read by the fast scanner (see `parseXmlResult`).
   */
  xml(path: string, fastContentOf?: string): XmlElement | null {
    const text = this.text(path);
    if (text === null) return null;
    const result = parseXmlResult(text, fastContentOf);
    if (Result.isFailure(result)) throw new XmlPartError(path.replace(/^\//, ""), result.failure);
    return result.success;
  }

  /** The relationships declared for the given part (resolved to absolute paths). */
  rels(partPath: string): ReadonlyArray<Relationship> {
    const dir = dirOf(partPath);
    const root = this.xml(relsPartOf(partPath));
    if (root === null) return [];
    return findChildren(root, "Relationship").map((r) => {
      const target = getAttr(r, "Target") ?? "";
      // External targets (hyperlink URLs, etc.) are absolute - never resolve them.
      const external = getAttr(r, "TargetMode") === "External";
      return {
        id: getAttr(r, "Id") ?? "",
        type: getAttr(r, "Type") ?? "",
        target: external ? target : resolveTarget(dir, target),
        external,
      };
    });
  }

  /** Resolve the single root-relationship target whose type ends with `suffix`. */
  rootTarget(suffix: string, fallback: string): string {
    const rootRels = this.rels(""); // "_rels/.rels"
    return rootRels.find((r) => !r.external && r.type.endsWith(suffix))?.target ?? fallback;
  }

  /**
   * A part's content type from `[Content_Types].xml` (an Override for the part,
   * else the Default for its extension); undefined if the package declares none.
   */
  contentType(path: string): string | undefined {
    if (this.contentTypes === undefined) {
      const root = this.xml("[Content_Types].xml");
      if (root === null) this.contentTypes = null;
      else {
        this.contentTypes = {
          defaults: new Map(
            findChildren(root, "Default").map((d) => [
              (getAttr(d, "Extension") ?? "").toLowerCase(),
              getAttr(d, "ContentType") ?? "",
            ]),
          ),
          overrides: new Map(
            findChildren(root, "Override").map((o) => [
              decodePartName(getAttr(o, "PartName") ?? "")
                .replace(/^\//, "")
                .toLowerCase(),
              getAttr(o, "ContentType") ?? "",
            ]),
          ),
        };
      }
    }
    if (this.contentTypes === null) return undefined;
    const key = (path.startsWith("/") ? path.substring(1) : path).toLowerCase();
    const ext = key.includes(".") ? key.substring(key.lastIndexOf(".") + 1) : "";
    return this.contentTypes.overrides.get(key) ?? this.contentTypes.defaults.get(ext);
  }

  /**
   * Fail with a "WrongPackageType" OpcError when the main part's declared
   * content type isn't one of `accepted` (e.g. a .xlsx given to the DOCX
   * reader). Packages without `[Content_Types].xml` are not checked.
   */
  expectMainPart(path: string, format: string, accepted: ReadonlyArray<string>): void {
    if (this.text("[Content_Types].xml") === null) return;
    const type = this.contentType(path);
    if (type === undefined || !accepted.includes(type)) {
      throw new OpcError(
        "WrongPackageType",
        `not a ${format} package: main part /${path} has content type "${type ?? "none"}"`,
      );
    }
  }
}

/**
 * The fixed timestamp written into zips so output is byte-for-byte
 * deterministic: 1980-01-01 00:00, the DOS epoch. fflate encodes a zip
 * entry's DOS time from the date's *local* fields, so this is built from
 * local fields, afresh for each zip: the same fields in every time zone, even
 * when the zone changes while the program runs. (A fixed UTC instant, as this
 * once was, is 1979-12-31 west of UTC, which fflate refuses, failing every
 * OOXML write there, and a later hour east of it.)
 */
export const zipMtime = (): Date =>
  // oxlint-disable-next-line effect/use-clock-service -- a fixed epoch, not the current time
  new Date(1980, 0, 1, 0, 0, 0);

/** Zip a set of named parts into OPC package bytes. */
export const zipParts = (
  files: Record<string, string | Uint8Array>,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
): Uint8Array => {
  const encoded: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    encoded[path] = Predicate.isString(content) ? strToU8(content) : content;
  }
  return zipSync(encoded, { level, mtime: zipMtime() });
};

/** The standard XML declaration prefixed to every OOXML part. */
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The OPC package-relationships namespace. */
export const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
/** The officeDocument relationships namespace. */
export const NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** The content-types namespace. */
export const NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
