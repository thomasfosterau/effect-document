/**
 * Image metadata from file headers (#113): the media type, pixel size and,
 * where the file records it, resolution of a PNG, JPEG, GIF or SVG, so a
 * writer can size an image (DOCX and PPTX need extents in EMUs) without an
 * image codec. Pure functions over bytes; nothing is decoded but the header.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/** A resolution in dots per inch, horizontally and vertically. */
export interface Dpi {
  readonly x: number;
  readonly y: number;
}

/** What an image's header says about it. */
export interface ImageInfo {
  /** `image/png`, `image/jpeg`, `image/gif` or `image/svg+xml`. */
  readonly mediaType: string;
  /** Width in pixels (for SVG, CSS pixels: 96 to the inch). */
  readonly width: number;
  /** Height in pixels (for SVG, CSS pixels: 96 to the inch). */
  readonly height: number;
  /** The resolution the file records (PNG `pHYs` in metres, JPEG JFIF density), if it records one. */
  readonly dpi: Option.Option<Dpi>;
}

/** The resolution assumed for an image that records none: the CSS pixel's 96 to the inch. */
export const DEFAULT_DPI = 96;

/** English Metric Units per inch, the unit of DOCX and PPTX extents. */
export const EMU_PER_INCH = 914_400;

/** An extent in English Metric Units. */
export interface EmuExtent {
  readonly cx: number;
  readonly cy: number;
}

/** An image's natural size in EMUs: its pixels at its recorded resolution, or {@link DEFAULT_DPI}. */
export const emuExtent = (info: ImageInfo): EmuExtent => {
  const dpi = Option.getOrElse(info.dpi, () => ({ x: DEFAULT_DPI, y: DEFAULT_DPI }));
  return {
    cx: Math.round((info.width / dpi.x) * EMU_PER_INCH),
    cy: Math.round((info.height / dpi.y) * EMU_PER_INCH),
  };
};

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u32be = (b: Uint8Array, i: number): number => ((u16be(b, i) << 16) | u16be(b, i + 2)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number): string =>
  String.fromCharCode(...b.subarray(i, i + n));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const INCHES_PER_METRE = 0.0254;

/** A positive, finite size, or `None`. */
const sized = (
  mediaType: string,
  width: number,
  height: number,
  dpi: Option.Option<Dpi>,
): Option.Option<ImageInfo> =>
  width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
    ? Option.some({ mediaType, width, height, dpi })
    : Option.none();

/** How many PNG chunks are read before the image data: real files put `pHYs` within the first few. */
const MAX_PNG_CHUNKS = 64;

/** The `pHYs` resolution among the chunks from offset `i`, before the image data; `None` past the bound. */
const pngDpi = (b: Uint8Array, i: number, left: number): Option.Option<Dpi> => {
  if (left === 0 || i + 8 > b.length) return Option.none();
  const length = u32be(b, i);
  const type = ascii(b, i + 4, 4);
  if (type === "IDAT" || type === "IEND") return Option.none();
  if (type === "pHYs" && length >= 9 && b[i + 16] === 1) {
    return Option.some({
      x: Math.round(u32be(b, i + 8) * INCHES_PER_METRE),
      y: Math.round(u32be(b, i + 12) * INCHES_PER_METRE),
    });
  }
  // chunks: length, type, data, CRC
  return pngDpi(b, i + 12 + length, left - 1);
};

/** A PNG's `IHDR` size and `pHYs` resolution (when its unit is the metre). */
const png = (b: Uint8Array): Option.Option<ImageInfo> =>
  b.length < 24 || ascii(b, 12, 4) !== "IHDR"
    ? Option.none()
    : sized("image/png", u32be(b, 16), u32be(b, 20), pngDpi(b, 8, MAX_PNG_CHUNKS));

/** A GIF's logical screen size. */
const gif = (b: Uint8Array): Option.Option<ImageInfo> =>
  b.length < 10 ? Option.none() : sized("image/gif", u16le(b, 6), u16le(b, 8), Option.none());

/** Whether a JPEG marker starts a frame (`SOF0`–`SOF15`, but not DHT, JPG or DAC). */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/** A JFIF density, in dots per inch (unit 1) or per centimetre (unit 2). */
const jfifDpi = (b: Uint8Array, data: number): Option.Option<Dpi> => {
  if (ascii(b, data, 5) !== "JFIF\u0000") return Option.none();
  const unit = b[data + 7];
  const x = u16be(b, data + 8);
  const y = u16be(b, data + 10);
  if (x === 0 || y === 0) return Option.none();
  if (unit === 1) return Option.some({ x, y });
  if (unit === 2) return Option.some({ x: Math.round(x * 2.54), y: Math.round(y * 2.54) });
  return Option.none();
};

/** The length of a JPEG marker without a segment (a fill byte, `TEM`, `RST0`–`RST7`); 0 for a marker followed by one. */
const bareMarkerLength = (marker: number): number =>
  marker === 0xff ? 1 : marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) ? 2 : 0;

/** Whether a JPEG marker ends the header before any frame: end of image, or the start of scan data. */
const endsHeader = (marker: number): boolean => marker === 0xd9 || marker === 0xda;

/** How many JPEG markers are read before the frame: real files reach `SOFn` within a few dozen. */
const MAX_JPEG_MARKERS = 256;

/** The frame size from the marker at offset `i`, carrying the JFIF density seen; `None` past the bound. */
const jpegFrame = (
  b: Uint8Array,
  i: number,
  dpi: Option.Option<Dpi>,
  left: number,
): Option.Option<ImageInfo> => {
  if (left === 0 || i + 4 > b.length) return Option.none();
  const marker = b[i + 1] ?? 0;
  if (b[i] !== 0xff || endsHeader(marker)) return Option.none();
  const bare = bareMarkerLength(marker);
  if (bare > 0) return jpegFrame(b, i + bare, dpi, left - 1);
  if (isStartOfFrame(marker)) return sized("image/jpeg", u16be(b, i + 7), u16be(b, i + 5), dpi);
  const seen = marker === 0xe0 ? jfifDpi(b, i + 4) : dpi;
  return jpegFrame(b, i + 2 + u16be(b, i + 2), seen, left - 1);
};

/** A JPEG's frame size, from its first start-of-frame segment, and its JFIF density. */
const jpeg = (b: Uint8Array): Option.Option<ImageInfo> =>
  jpegFrame(b, 2, Option.none(), MAX_JPEG_MARKERS);

/** How many bytes of an SVG are searched for its root element. */
const SVG_SAMPLE_BYTES = 4096;

/** CSS pixels per unit of an SVG length, by the unit's name (`""` for none). */
const SVG_UNITS = [
  ["", 1],
  ["px", 1],
  ["pt", 96 / 72],
  ["pc", 16],
  ["in", 96],
  ["cm", 96 / 2.54],
  ["mm", 96 / 25.4],
] as const;

/** CSS pixels per `unit`; `None` for a unit SVG lengths don't have. */
const svgUnit = (unit: string): Option.Option<number> =>
  Option.map(
    Arr.findFirst(SVG_UNITS, ([name]) => name === unit),
    ([, px]) => px,
  );

/** An SVG length attribute in CSS pixels; `None` for a percentage or anything unreadable. */
const svgLength = (tag: string, name: string): Option.Option<number> => {
  const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*([a-z]*)\\s*["']`).exec(tag);
  if (m === null) return Option.none();
  const value = Number(m[1]);
  return Number.isFinite(value)
    ? Option.map(svgUnit(m[2] ?? ""), (px) => value * px)
    : Option.none();
};

/** An SVG's root `width` / `height`, or, without them, its `viewBox` size. */
const svg = (b: Uint8Array): Option.Option<ImageInfo> => {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(0, SVG_SAMPLE_BYTES));
  const root = /<svg\b[^>]*>/i.exec(head);
  if (root === null) return Option.none();
  const tag = root[0];
  const box =
    /\sviewBox\s*=\s*["']\s*[-0-9.e]+[\s,]+[-0-9.e]+[\s,]+([0-9.e]+)[\s,]+([0-9.e]+)\s*["']/i.exec(
      tag,
    );
  const boxW = box === null ? Option.none<number>() : Option.some(Number(box[1]));
  const boxH = box === null ? Option.none<number>() : Option.some(Number(box[2]));
  const width = Option.orElse(svgLength(tag, "width"), () => boxW);
  const height = Option.orElse(svgLength(tag, "height"), () => boxH);
  return Option.isSome(width) && Option.isSome(height)
    ? sized("image/svg+xml", width.value, height.value, Option.none())
    : Option.none();
};

/**
 * What an image's header says (#113): its media type, its size in pixels and,
 * when recorded, its resolution. `None` for content that isn't a PNG, JPEG,
 * GIF or SVG with a readable size. Never throws.
 */
export const imageInfo = (bytes: Uint8Array): Option.Option<ImageInfo> => {
  if (PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return png(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes);
  const magic = ascii(bytes, 0, 6);
  if (magic === "GIF87a" || magic === "GIF89a") return gif(bytes);
  return svg(bytes);
};
