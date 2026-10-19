/**
 * Layout analysis: positioned glyphs -> lines -> prose blocks.
 *
 * PDF has no paragraphs, only glyphs at coordinates, so structure is inferred
 * the way a reader's eye does it:
 *
 * - glyphs on one baseline form a line; a gap wider than a fraction of the
 *   font size is a space;
 * - the most common font size is the body size; larger lines are headings,
 *   ranked by size into levels 1-6;
 * - lines separated by more than the usual leading start a new paragraph;
 * - lines that open with a bullet or a number are list items (deeper markers
 *   nest), and runs of monospaced lines are code blocks;
 * - bold, italic and monospaced fonts become `Strong`, `Emph` and `Code`, and
 *   text under a link annotation becomes a `Link`.
 *
 * Text is taken in content-stream order, which is reading order for the vast
 * majority of generators; text that is not upright (rotated) is skipped.
 */

import {
  type Block, BulletList, Code, CodeBlock, Emph, Header, type Inline, Link, OrderedList, Para, Plain,
  SoftBreak, Str, Strong,
} from "@thomasfosterau/effect-document";
import type { PageLink, PageText, TextGlyph } from "./extract.js";

/** A run of identically styled text within a line. */
interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  mono: boolean;
  url: string | undefined;
}

/** A line of text. */
interface Line {
  readonly page: number;
  /** Baseline. */
  y: number;
  x0: number;
  x1: number;
  /** Dominant font size (by character count). */
  size: number;
  runs: Run[];
  text: string;
  /** Whether every visible character is monospaced. */
  mono: boolean;
  /** Width of a monospaced character, for recovering indentation in code. */
  charWidth: number;
}

const SPACE_GAP = 0.15; // of the font size
const BULLETS = "•◦▪▫‣⁃●○■□∙·–-*";
const BULLET_RE = new RegExp(`^([${BULLETS.replace("-", "\\-")}])\\s+`);
const ORDERED_RE = /^(\(?)(\d{1,3}|[a-z]|[ivxlcdm]{1,5}|[A-Z])([.)])\s+/;

// ============================================================================
// Glyphs -> lines
// ============================================================================

const urlAt = (links: ReadonlyArray<PageLink>, g: TextGlyph): string | undefined => {
  const cx = g.x + g.width / 2;
  const cy = g.y + g.size * 0.3;
  for (const l of links) {
    const [x0, y0, x1, y1] = l.rect;
    if (cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1) return l.url;
  }
  return undefined;
};

const sameStyle = (a: Run, b: Omit<Run, "text">): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.mono === b.mono && a.url === b.url;

const buildLines = (page: PageText, pageIndex: number): Line[] => {
  const lines: Line[] = [];
  let line: Line | undefined;
  let lastEnd = 0;
  let lastText = "";
  let sizes = new Map<number, number>();
  let monoChars = 0;
  let visibleChars = 0;
  let monoWidth = 0;

  const finish = (): void => {
    if (line === undefined) return;
    let best = line.size;
    let bestCount = -1;
    for (const [s, c] of sizes) {
      if (c > bestCount) {
        best = s;
        bestCount = c;
      }
    }
    line.size = best;
    line.mono = visibleChars > 0 && monoChars === visibleChars;
    line.charWidth = monoChars > 0 ? monoWidth / monoChars : best * 0.6;
    // trim, and drop lines with nothing visible
    const first = line.runs[0];
    if (first !== undefined) first.text = first.text.replace(/^\s+/, "");
    const last = line.runs[line.runs.length - 1];
    if (last !== undefined) last.text = last.text.replace(/\s+$/, "");
    line.runs = line.runs.filter((r) => r.text !== "");
    line.text = line.runs.map((r) => r.text).join("");
    if (line.text !== "") lines.push(line);
    line = undefined;
  };

  const recent: TextGlyph[] = [];
  for (const g of page.glyphs) {
    if (!g.upright || g.size <= 0) continue;
    // fake bold: the same glyph painted again a hair's breadth away
    if (g.text.trim() !== "" && recent.some((r) => r.text === g.text && Math.abs(r.x - g.x) < g.size * 0.1 && Math.abs(r.y - g.y) < g.size * 0.1)) continue;
    recent.push(g);
    if (recent.length > 8) recent.shift();

    const tolerance = Math.max(g.size, line?.size ?? 0) * 0.5;
    const continues = line !== undefined && Math.abs(g.y - line.y) <= tolerance && g.x >= lastEnd - Math.max(g.size, line.size) * 2;
    if (!continues) {
      finish();
      line = { page: pageIndex, y: g.y, x0: g.x, x1: g.x, size: g.size, runs: [], text: "", mono: false, charWidth: 0 };
      sizes = new Map();
      monoChars = 0;
      visibleChars = 0;
      monoWidth = 0;
      lastText = "";
    }
    const l = line!;
    let text = g.text.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").replace(/[\t\n\r ]/g, " ");
    if (text === "") continue;
    const gap = g.x - lastEnd;
    if (continues && gap > SPACE_GAP * Math.min(g.size, l.size) && !/\s$/.test(lastText) && !/^\s/.test(text)) text = " " + text;

    const style = { bold: g.bold, italic: g.italic, mono: g.monospace, url: urlAt(page.links, g) };
    const lastRun = l.runs[l.runs.length - 1];
    if (lastRun !== undefined && sameStyle(lastRun, style)) lastRun.text += text;
    else if (lastRun !== undefined && /^\s+$/.test(text)) lastRun.text += text; // spaces don't start a new style
    else {
      // a leading space at a style boundary stays with the plainer side
      if (lastRun !== undefined && text.startsWith(" ")) {
        lastRun.text += " ";
        text = text.slice(1);
      }
      l.runs.push({ text, ...style });
    }

    const visible = text.replace(/\s/g, "").length;
    if (visible > 0 && visibleChars === 0) l.x0 = g.x; // indentation is where the ink starts
    if (visible > 0) {
      const key = Math.round(g.size * 2) / 2;
      sizes.set(key, (sizes.get(key) ?? 0) + visible);
      visibleChars += visible;
      if (g.monospace) {
        monoChars += visible;
        monoWidth += g.width;
      }
    }
    if (g.y < l.y && Math.abs(g.size - l.size) < 0.01) l.y = g.y;
    l.x1 = Math.max(l.x1, g.x + g.width);
    lastEnd = g.x + g.width;
    lastText = text;
  }
  finish();
  return lines;
};

// ============================================================================
// Lines -> inlines
// ============================================================================

const styled = (run: Run, text: string): Inline => {
  let node: Inline = run.mono ? new Code({ text }) : new Str({ text });
  if (run.italic) node = new Emph({ content: [node] });
  if (run.bold) node = new Strong({ content: [node] });
  return node;
};

/** Inlines for a sequence of runs: styling, links, and merged neighbours. */
const runsToInlines = (runs: ReadonlyArray<Run>, inCode = false): Inline[] => {
  // merge neighbouring runs that render identically
  const merged: Run[] = [];
  for (const r of runs) {
    const run = inCode ? { ...r, mono: false } : r;
    const prev = merged[merged.length - 1];
    if (prev !== undefined && sameStyle(prev, run)) prev.text += run.text;
    else merged.push({ ...run });
  }
  const out: Inline[] = [];
  let i = 0;
  while (i < merged.length) {
    const url = merged[i]!.url;
    if (url !== undefined) {
      const content: Inline[] = [];
      while (i < merged.length && merged[i]!.url === url) {
        content.push(styled(merged[i]!, merged[i]!.text));
        i++;
      }
      out.push(new Link({ content, target: { url } }));
      continue;
    }
    const r = merged[i++]!;
    // keep spaces at the edges of a styled run outside it
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text)!;
    const plain = !r.bold && !r.italic && !r.mono;
    if (plain || m[2] === "") out.push(new Str({ text: r.text }));
    else {
      if (m[1] !== "") out.push(new Str({ text: m[1]! }));
      out.push(styled(r, m[2]!));
      if (m[3] !== "") out.push(new Str({ text: m[3]! }));
    }
  }
  // merge adjacent Strs
  const result: Inline[] = [];
  for (const n of out) {
    const prev = result[result.length - 1];
    if (n._tag === "Str" && prev?._tag === "Str") result[result.length - 1] = new Str({ text: prev.text + n.text });
    else result.push(n);
  }
  return result;
};

/** Inlines for several lines, joined by soft breaks (or nothing, after a hyphen). */
const linesToInlines = (lines: ReadonlyArray<{ runs: ReadonlyArray<Run>; text: string }>): Inline[] => {
  const out: Inline[] = [];
  lines.forEach((l, i) => {
    if (i > 0) {
      const prev = lines[i - 1]!.text;
      // a word broken with a hyphen at the end of the line continues directly
      if (!(/\p{L}-$/u.test(prev) && /^\p{Ll}/u.test(l.text))) out.push(new SoftBreak());
    }
    out.push(...runsToInlines(l.runs));
  });
  return out;
};

// ============================================================================
// Lines -> blocks
// ============================================================================

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

interface Marker {
  readonly ordered: boolean;
  readonly start?: number;
  /** The marker's text length, to strip from the line. */
  readonly length: number;
}

const markerOf = (line: Line): Marker | undefined => {
  const b = BULLET_RE.exec(line.text);
  if (b !== null) return { ordered: false, length: b[0].length };
  const o = ORDERED_RE.exec(line.text);
  if (o !== null && (o[1] === "" || o[3] === ")")) {
    const n = Number(o[2]);
    // a lone letter or roman numeral only counts in a list that's already going
    return { ordered: true, start: Number.isFinite(n) ? n : undefined, length: o[0].length };
  }
  return undefined;
};

/** Remove the first `n` characters from a line's runs. */
const dropChars = (runs: ReadonlyArray<Run>, n: number): Run[] => {
  const out: Run[] = [];
  let left = n;
  for (const r of runs) {
    if (left >= r.text.length) {
      left -= r.text.length;
      continue;
    }
    out.push({ ...r, text: r.text.slice(left) });
    left = 0;
  }
  return out;
};

interface Item {
  readonly markerX: number;
  readonly marker: Marker;
  readonly lines: Array<{ runs: Run[]; text: string }>;
}

/** Turn list items into (possibly nested) lists. */
const buildList = (items: ReadonlyArray<Item>, size: number): Block[] => {
  const out: Block[] = [];
  let i = 0;
  while (i < items.length) {
    const first = items[i]!;
    const level = first.markerX;
    const entries: Block[][] = [];
    const ordered = first.marker.ordered;
    while (i < items.length) {
      const it = items[i]!;
      if (it.markerX > level + size * 0.8) {
        // deeper: a nested list inside the previous item
        const nested: Item[] = [];
        while (i < items.length && items[i]!.markerX > level + size * 0.8) nested.push(items[i++]!);
        const target = entries[entries.length - 1];
        if (target !== undefined) target.push(...buildList(nested, size));
        else entries.push(buildList(nested, size));
        continue;
      }
      if (it.markerX < level - size * 0.8 || it.marker.ordered !== ordered) break;
      entries.push([new Plain({ content: linesToInlines(it.lines) })]);
      i++;
    }
    if (entries.length === 0) {
      // a shallower item than the list started with: start a new list there
      entries.push([new Plain({ content: linesToInlines(items[i]!.lines) })]);
      i++;
    }
    out.push(
      ordered
        ? new OrderedList({ start: first.marker.start ?? 1, numberStyle: "decimal", numberDelim: "period", items: entries })
        : new BulletList({ items: entries })
    );
  }
  return out;
};

/** Infer prose blocks from the text of a document's pages. */
export const layoutBlocks = (pages: ReadonlyArray<PageText>): Block[] => {
  const lines = pages.flatMap((p, i) => buildLines(p, i));
  if (lines.length === 0) return [];

  // the body size: the size most characters of prose are set in (code is often smaller)
  const bySize = new Map<number, number>();
  const prose = lines.some((l) => !l.mono) ? lines.filter((l) => !l.mono) : lines;
  for (const l of prose) bySize.set(l.size, (bySize.get(l.size) ?? 0) + l.text.length);
  const body = [...bySize].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  const isHeading = (l: Line): boolean => l.size >= body * 1.12 && l.text.length <= 200 && !l.mono;
  const headingSizes = [...new Set(lines.filter(isHeading).map((l) => l.size))].sort((a, b) => b - a);
  const levelOf = (size: number): number => Math.min(6, headingSizes.indexOf(size) + 1);

  // the usual distance between consecutive body lines
  const deltas: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!;
    const b = lines[i]!;
    const d = a.y - b.y;
    if (a.page === b.page && a.size === body && b.size === body && d > 0 && d < body * 3) deltas.push(d);
  }
  const leading = Math.min(median(deltas) ?? body * 1.2, body * 2);
  const breakGap = leading * 1.3 + 0.5;

  // each page's right text edge, to tell a full line from a paragraph's last line
  const rightEdge = new Map<number, number>();
  for (const l of lines) if (l.size === body && !l.mono) rightEdge.set(l.page, Math.max(rightEdge.get(l.page) ?? 0, l.x1));

  const blocks: Block[] = [];
  let i = 0;
  const gapBefore = (k: number): number => {
    const a = lines[k - 1];
    const b = lines[k]!;
    if (a !== undefined && b.page === a.page + 1 && continuesOnNextPage(a, b)) return leading;
    return a === undefined || a.page !== b.page || b.y > a.y ? Number.POSITIVE_INFINITY : a.y - b.y;
  };
  /** A paragraph runs over a page break when its line there is full and unfinished. */
  const continuesOnNextPage = (a: Line, b: Line): boolean =>
    a.size === body && b.size === body && !a.mono && !b.mono &&
    a.x1 >= (rightEdge.get(a.page) ?? Number.POSITIVE_INFINITY) - body * 2 &&
    !/[.!?:;]["'”’)]?$/.test(a.text) && markerOf(b) === undefined;

  while (i < lines.length) {
    const line = lines[i]!;

    if (isHeading(line)) {
      const group = [line];
      i++;
      while (i < lines.length && lines[i]!.size === line.size && isHeading(lines[i]!) && gapBefore(i) <= line.size * 1.45) group.push(lines[i++]!);
      // headings are usually set bold throughout; that's the heading's look, not emphasis
      const allBold = group.every((l) => l.runs.every((r) => r.bold));
      const unbolded = allBold ? group.map((l) => ({ ...l, runs: l.runs.map((r) => ({ ...r, bold: false })) })) : group;
      blocks.push(new Header({ level: levelOf(line.size), content: linesToInlines(unbolded) }));
      continue;
    }

    if (line.mono) {
      const group = [line];
      i++;
      while (i < lines.length && lines[i]!.mono && !isHeading(lines[i]!) && gapBefore(i) <= leading * 3) group.push(lines[i++]!);
      const left = Math.min(...group.map((l) => l.x0));
      const step = Math.abs(median(group.slice(1).map((l, k) => group[k]!.y - l.y).filter((d) => d > 0)) ?? line.size * 1.2);
      const text: string[] = [];
      group.forEach((l, k) => {
        if (k > 0) {
          const blank = Math.round((group[k - 1]!.y - l.y) / step) - 1;
          for (let b = 0; b < blank && b < 20; b++) text.push("");
        }
        const indent = Math.max(0, Math.round((l.x0 - left) / l.charWidth));
        text.push(" ".repeat(indent) + l.text);
      });
      blocks.push(new CodeBlock({ text: text.join("\n") }));
      continue;
    }

    const marker = markerOf(line);
    if (marker !== undefined && (!marker.ordered || marker.start !== undefined)) {
      const items: Item[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = markerOf(l);
        if (m === undefined || isHeading(l) || l.mono) break;
        if (items.length > 0 && gapBefore(i) > breakGap * 1.25) break;
        const item: Item = { markerX: l.x0, marker: m, lines: [{ runs: dropChars(l.runs, m.length), text: l.text.slice(m.length) }] };
        items.push(item);
        i++;
        // continuation lines: indented past the marker, no marker of their own
        while (i < lines.length) {
          const c = lines[i]!;
          if (markerOf(c) !== undefined || isHeading(c) || c.mono || gapBefore(i) > breakGap || c.x0 <= l.x0 + c.size * 0.5) break;
          item.lines.push({ runs: c.runs, text: c.text });
          i++;
        }
      }
      blocks.push(...buildList(items, body));
      continue;
    }

    const group = [line];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isHeading(l) || l.mono || gapBefore(i) > breakGap || Math.abs(l.size - line.size) > 0.75) break;
      const m = markerOf(l);
      if (m !== undefined && (!m.ordered || m.start !== undefined)) break;
      // a first-line indent starts a new paragraph
      if (l.x0 > group[group.length - 1]!.x0 + l.size * 1.5 && group.length > 1) break;
      group.push(l);
      i++;
    }
    blocks.push(new Para({ content: linesToInlines(group) }));
  }
  return blocks;
};
