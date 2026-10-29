/**
 * Grouping list paragraphs into nested lists, shared by the DOCX and PPTX
 * readers: both formats store a list as a run of paragraphs, each with a
 * level, and an item's later blocks as unnumbered paragraphs (or tables)
 * indented to the item's level (#195, #196).
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { type Block, BulletList, OrderedList } from "@thomasfosterau/effect-document";

/** An item paragraph's place in the lists: its kind, level and where its list starts. */
export interface ListEntry {
  readonly kind: "bullet" | "ordered";
  /** The paragraph's level (DOCX `w:ilvl`, PPTX `lvl`). */
  readonly level: number;
  /** The list instance (DOCX `numId`): a different one at the same level begins a new list. */
  readonly key: string;
  /** Whether this item restarts its numbering (PPTX `startAt`), which begins a new list. */
  readonly restart: boolean;
  /** Where the list starts, if this item begins one. */
  readonly start: number;
  /** The left indent of the item's level, if known: a block indented to it continues the item. */
  readonly indent: number | undefined;
}

interface OpenList extends ListEntry {
  readonly items: Block[][];
}

/**
 * An item's blocks without an empty lead paragraph before other blocks: an
 * item that starts with a code block, table or list still needs a numbered
 * paragraph, which the writers leave empty.
 */
const itemBlocks = (item: Block[]): Block[] => {
  const [first, ...rest] = item;
  return Predicate.isTagged(first, "Plain") &&
    Arr.isReadonlyArrayEmpty(first.content) &&
    Arr.isReadonlyArrayNonEmpty(rest)
    ? rest
    : item;
};

const listBlock = (l: OpenList): Block => {
  const items = l.items.map(itemBlocks);
  return l.kind === "ordered"
    ? new OrderedList({ start: l.start === 1 ? undefined : l.start, items })
    : new BulletList({ items });
};

/**
 * The blocks of one container (a body, a table cell, a text box) as they
 * are read, with the lists still open: the outermost first, a deeper level
 * nesting inside the last item of the list above it.
 */
export class ListStack {
  /** The container's finished blocks. */
  readonly out: Block[] = [];
  private readonly open: OpenList[] = [];

  /** Close the innermost open list into the item above it, or into `out`. */
  private close(): void {
    const list = this.open.pop();
    if (list === undefined) return;
    const outer = this.open.at(-1);
    const item = outer?.items.at(-1);
    if (outer === undefined) this.out.push(listBlock(list));
    else if (item === undefined) outer.items.push([listBlock(list)]);
    else item.push(listBlock(list));
  }

  /** Close every open list; call once the container's last paragraph is read. */
  closeAll(): Block[] {
    this.open.slice().forEach(() => this.close());
    return this.out;
  }

  /**
   * The item a block indented by `indent` continues: the last item of the
   * innermost open list at that indent, after closing the lists nested in it.
   */
  private continuedItem(indent: number | undefined): Block[] | undefined {
    if (indent === undefined) return undefined;
    const at = this.open.findLastIndex(
      (l) => l.indent === indent && Arr.isReadonlyArrayNonEmpty(l.items),
    );
    const list = this.open[at];
    if (list === undefined) return undefined;
    this.open.slice(at + 1).forEach(() => this.close());
    return list.items.at(-1);
  }

  /**
   * Blocks that are not an item's first paragraph: a continuation of the open
   * item they are indented to, or else blocks after the lists. `blocks` is
   * told which (`continued`), for a format that reads the two differently.
   */
  place(indent: number | undefined, blocks: (continued: boolean) => Block[]): void {
    const item = this.continuedItem(indent);
    if (item !== undefined) item.push(...blocks(true));
    else {
      this.closeAll();
      this.out.push(...blocks(false));
    }
  }

  /** An item's first paragraph: a new item of the list open at its level, opening or closing lists as it needs. */
  item(entry: ListEntry, lead: Block): void {
    const deeper = this.open.findIndex((l) => l.level > entry.level);
    if (deeper >= 0) this.open.slice(deeper).forEach(() => this.close());
    const top = this.open.at(-1);
    // A different kind or list instance at the same level, or a restart, begins a new list.
    if (
      top !== undefined &&
      top.level === entry.level &&
      (top.kind !== entry.kind || top.key !== entry.key || entry.restart)
    )
      this.close();
    const current = this.open.at(-1);
    if (current === undefined || current.level < entry.level) {
      this.open.push({ ...entry, items: [[lead]] });
    } else current.items.push([lead]);
  }
}
