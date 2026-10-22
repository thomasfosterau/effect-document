import { packageConfig, type PackageConfigOptions } from "../../vite.package.ts";

/** This package's entry points; the root integration project reuses them. */
export const options: PackageConfigOptions = {
  url: import.meta.url,
  name: "@thomasfosterau/effect-document",
  entries: {
    index: "src/index.ts",
    schema: "src/schema/index.ts",
    profile: "src/profile/index.ts",
    profiles: "src/profile/profiles.ts",
    io: "src/io/index.ts",
  },
};

export default packageConfig(options);
