/**
 * effect-document: Office Open XML
 *
 * The OOXML format family - Excel (`Xlsx`), Word (`Docx`) and PowerPoint
 * (`Pptx`) - over shared XML and OPC packaging infrastructure. Each format is
 * also available on its own subpath (`/xlsx`, `/docx`, `/pptx`).
 */

export * as Xlsx from "./xlsx/index.ts";
export * as Docx from "./docx/index.ts";
export * as Pptx from "./pptx/index.ts";
