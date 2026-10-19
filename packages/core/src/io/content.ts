/**
 * Content is the raw material that flows into readers and out of writers. Text
 * formats (CSV, Markdown, ...) deal in strings; binary formats (XLSX, docx, ...)
 * deal in bytes. Either can be viewed as the other on demand.
 */

/** Textual content. */
export interface Text {
  readonly _tag: "Text";
  readonly text: string;
}

/** Binary content. */
export interface Bytes {
  readonly _tag: "Bytes";
  readonly bytes: Uint8Array;
}

/** Raw content accepted by readers and produced by writers. */
export type Content = Text | Bytes;

/** Construct textual content. */
export const text = (text: string): Text => ({ _tag: "Text", text });

/** Construct binary content. */
export const bytes = (bytes: Uint8Array): Bytes => ({ _tag: "Bytes", bytes });

/** View any content as a string (bytes are decoded as UTF-8). */
export const contentToText = (content: Content): string =>
  content._tag === "Text" ? content.text : new TextDecoder().decode(content.bytes);

/** View any content as bytes (text is encoded as UTF-8). */
export const contentToBytes = (content: Content): Uint8Array =>
  content._tag === "Bytes" ? content.bytes : new TextEncoder().encode(content.text);
