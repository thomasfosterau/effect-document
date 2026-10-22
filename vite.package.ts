/**
 * The one Vite+ configuration every package in this workspace shares: the
 * task graph (`check`, `build`, `test:unit`, `test:coverage`), the `vp pack`
 * (tsdown) settings, the alias that lets tests import the package by name and
 * resolve to `src/`, and the vitest / coverage settings. Each
 * `packages/<name>/vite.config.ts` is a one-call instantiation of it.
 *
 * Shape copied from the effect-web library's `vite.package.ts`, with one
 * difference: entry points are named explicitly (`entries` maps an export
 * subpath to its source file), because several packages here expose a
 * single module (`./pages`, `./profiles`) rather than a directory barrel.
 * Written against Vite+ 1.x, which takes a task's `env` / `input` / `output`
 * under `cache` (effect-web, on 0.3.x, sets them on the task itself).
 */
import { defineConfig } from "vite-plus";

/** What differs per package. */
export interface PackageConfigOptions {
  /** The package's `import.meta.url`, so paths resolve relative to it. */
  readonly url: string;
  /** The published name (`@thomasfosterau/effect-csv`), for the test alias. */
  readonly name: string;
  /**
   * `pack.entry`: export subpath → source file. `index` is the root export
   * (`.`); every other key `k` is the `./k` export and builds `dist/k.js`.
   */
  readonly entries: Readonly<Record<string, string>>;
}

/**
 * Input fingerprint for a package's cached tasks: auto tracking minus
 * node_modules bookkeeping churn (pnpm rewrites `.modules.yaml` on every
 * install), with the lockfile back explicitly so a dependency upgrade still
 * invalidates a type-check or a test run.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

/**
 * A sibling package is consumed the way a consumer does — through its
 * `exports`, so its `dist/` — hence the build edge on every task that
 * resolves one. A package with no workspace dependency gets an empty edge.
 */
const siblingBuild = { task: "build", from: "dependencies" as const };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The aliases that resolve the package's name (and each subpath) to its
 * `src/` file. Shared by the package's own vitest project and the root
 * integration project, which resolves every package this way.
 */
export const packageAliases = ({ url, name, entries }: PackageConfigOptions) => {
  const root = new URL("./", url).pathname;
  return Object.entries(entries).map(([key, file]) => ({
    find: new RegExp(`^${escapeRegExp(key === "index" ? name : `${name}/${key}`)}$`),
    replacement: `${root}${file}`,
  }));
};

export const packageConfig = (options: PackageConfigOptions) => {
  const { entries } = options;
  const maxWorkers = process.env.VITEST_MAX_WORKERS;
  return defineConfig({
    run: {
      tasks: {
        // `src` under the native, Effect-patched `tsc`, then the tests under
        // tsconfig.test.json, which resolves the package name to `src/` so
        // this package's own build is never needed first.
        check: {
          command: "tsc -p tsconfig.json && tsc -p tsconfig.test.json",
          dependsOn: [siblingBuild],
          cache: { input: cacheInputs, output: [] },
        },
        // The published artifact: one ESM bundle + declaration file per entry
        // point (`vp pack` → tsdown, `platform: neutral`). `sideEffects:
        // false` is a claim about this output: no top-level statements.
        build: {
          command: "vp pack",
          dependsOn: [siblingBuild],
          cache: { input: cacheInputs, output: ["dist/**"] },
        },
        "test:unit": {
          command: "vp test run test",
          dependsOn: [siblingBuild],
          cache: { env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"], input: cacheInputs, output: [] },
        },
        "test:coverage": {
          command: "vp test run test --coverage",
          dependsOn: [siblingBuild],
          cache: {
            env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
            input: cacheInputs,
            output: ["coverage/**"],
          },
        },
      },
    },
    pack: {
      entry: entries,
      format: "esm",
      platform: "neutral",
      dts: true,
      outDir: "dist",
      clean: true,
    },
    resolve: {
      // Tests import the package by name, exactly as a consumer would (and as
      // tsconfig.test.json's `paths` type-checks them), so the runner resolves
      // that name to `src/` rather than to the built `dist/` that `exports`
      // points at — a unit run never needs this package's build first.
      alias: packageAliases(options),
    },
    test: {
      include: ["test/**/*.test.ts"],
      testTimeout: 30_000,
      ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
      coverage: {
        provider: "istanbul",
        // `json` writes coverage-final.json, the Istanbul map `fallow audit`
        // reads for exact per-function CRAP scores (`health.coverage` in
        // .fallowrc.json); without it every function scores as uncovered.
        reporter: ["text-summary", "json-summary", "json"],
        reportsDirectory: "./coverage",
        include: ["src/**/*.ts"],
        exclude: ["**/*.d.ts"],
      },
    },
  });
};
