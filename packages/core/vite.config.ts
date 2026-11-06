import { packageConfig, type PackageConfigOptions } from "../../vite.package.ts";

/**
 * This package's entry points; the root integration project reuses them.
 * Each format is a nested subpath (`./csv`, `./ooxml/xlsx`, …) and stays off
 * the root barrel, so a consumer that never imports a format never loads it
 * or its dependency (`fflate`, the optional `@thomasfosterau/effect-parse`
 * peer).
 */
export const options: PackageConfigOptions = {
  url: import.meta.url,
  name: "@thomasfosterau/effect-document",
  entries: {
    index: "src/index.ts",
    schema: "src/schema/index.ts",
    profile: "src/profile/index.ts",
    profiles: "src/profile/profiles.ts",
    io: "src/io/index.ts",
    csv: "src/csv/index.ts",
    rtf: "src/rtf/index.ts",
    ooxml: "src/ooxml/index.ts",
    "ooxml/xlsx": "src/ooxml/xlsx/index.ts",
    "ooxml/docx": "src/ooxml/docx/index.ts",
    "ooxml/pptx": "src/ooxml/pptx/index.ts",
    pdf: "src/pdf/index.ts",
    "pdf/cos": "src/pdf/cos/index.ts",
    iwork: "src/iwork/index.ts",
    "iwork/pages": "src/iwork/pages.ts",
    "iwork/numbers": "src/iwork/numbers.ts",
    "iwork/keynote": "src/iwork/keynote.ts",
    "iwork/codec": "src/iwork/codec.ts",
  },
};

export default packageConfig(options);
