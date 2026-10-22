import { packageConfig, type PackageConfigOptions } from "../../vite.package.ts";

/** This package's entry points; the root integration project reuses them. */
export const options: PackageConfigOptions = {
  url: import.meta.url,
  name: "@thomasfosterau/effect-rtf",
  entries: {
    index: "src/index.ts",
  },
};

export default packageConfig(options);
