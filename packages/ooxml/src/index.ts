/**
 * effect-document: Office Open XML
 *
 * The OOXML format family - Excel (`Xlsx`), Word (`Docx`) and PowerPoint
 * (`Pptx`) - over shared XML and OPC packaging infrastructure. Each format is
 * also available on its own subpath (`/xlsx`, `/docx`, `/pptx`).
 */

/** The XLSX (Excel workbook) reader, writer and format. */
export * as Xlsx from "./xlsx/index.ts";
/** The DOCX (Word document) reader, writer and format. */
export * as Docx from "./docx/index.ts";
/** The PPTX (PowerPoint presentation) reader, writer and format. */
export * as Pptx from "./pptx/index.ts";
