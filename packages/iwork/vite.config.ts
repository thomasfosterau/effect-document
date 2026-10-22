import { packageConfig, type PackageConfigOptions } from "../../vite.package.ts";

/** This package's entry points; the root integration project reuses them. */
export const options: PackageConfigOptions = {
  url: import.meta.url,
  name: "@thomasfosterau/effect-iwork",
  entries: {
    index: "src/index.ts",
    pages: "src/pages.ts",
    numbers: "src/numbers.ts",
    keynote: "src/keynote.ts",
    codec: "src/codec.ts",
  },
};

export default packageConfig(options);
