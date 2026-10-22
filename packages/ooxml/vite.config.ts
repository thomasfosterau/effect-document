import { packageConfig, type PackageConfigOptions } from "../../vite.package.ts";

/** This package's entry points; the root integration project reuses them. */
export const options: PackageConfigOptions = {
  url: import.meta.url,
  name: "@thomasfosterau/effect-ooxml",
  entries: {
    index: "src/index.ts",
    xlsx: "src/xlsx/index.ts",
    docx: "src/docx/index.ts",
    pptx: "src/pptx/index.ts",
  },
};

export default packageConfig(options);
