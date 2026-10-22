/**
 * Root workspace config. Owns the repo-wide format/lint/staged passes (read
 * statically by `vp fmt` / `vp lint` / `vp staged`), the root aggregates
 * (`check`, `check:dist`, `test:integration`, `test:coverage`) and the
 * cross-package integration suite under `test/integration`. Every package's
 * own tasks are defined once in `vite.package.ts` and instantiated by each
 * package's `vite.config.ts`; a new package adds itself to the aggregate
 * lists below.
 *
 * Copied from the effect-web library's root config: every comment that
 * explains a load-bearing decision is part of the standard and travels with
 * the config.
 *
 * @copyright Thomas Foster
 */

import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@mpsuesser/oxlint-plugin-effect";
import { packageAliases } from "./vite.package.ts";
import { options as core } from "./packages/core/vite.config.ts";
import { options as csv } from "./packages/csv/vite.config.ts";
import { options as iwork } from "./packages/iwork/vite.config.ts";
import { options as ooxml } from "./packages/ooxml/vite.config.ts";
import { options as pdf } from "./packages/pdf/vite.config.ts";
import { options as rtf } from "./packages/rtf/vite.config.ts";

/** Every package name and subpath, resolved to its `src/` file. */
const integrationAliases = [core, csv, iwork, ooxml, pdf, rtf].flatMap(packageAliases);

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    "*.{js,ts,css,json,md}": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/docs/**", "**/coverage/**"],
    overrides: [
      {
        files: ["**/*.md"],
        options: {
          proseWrap: "never",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/docs/**", "**/coverage/**", "**/node_modules/**"],
    extends: [recommended, effect.configs.recommended],
    categories: {
      correctness: "error",
    },
    rules: {
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "warn",
      // The `Buffer` global is typed `any` wherever a consumer loads
      // @cloudflare/workers-types next to @types/node (every application this
      // family serves), so every call on it is unchecked there. Use
      // Uint8Array / TextEncoder / DataView instead.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array / TextEncoder / DataView.",
        },
      ],
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`, including the narrowings the Fetch / Workers
      // types structurally require. Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this family shares with its consumers.
      "effect/prefer-namespace-imports": "off",

      // ---- Effect preset: ported-code allowances ---------------------------
      // The modules under packages/*/src are ports of behaviour the
      // applications carry today, which predates the Effect oxlint preset. The
      // rules below sit at `warn` so a port stays committable while each site
      // stays reported; a new site is a defect, not headroom. Once a rule's
      // count reaches zero its line is deleted, so it is back at the preset's
      // `error` (effect-web#48).
      "effect/imperative-loops": "warn",
      "effect/avoid-native-object-helpers": "warn",
      "effect/avoid-non-null-assertion": "warn",
      "effect/avoid-untagged-errors": "warn",
      "effect/avoid-direct-json": "warn",
      "effect/effect-run-in-body": "warn",
      "effect/avoid-direct-tag-checks": "warn",
      "effect/avoid-option-getorthrow": "warn",
      // ---- Effect preset: rules this workspace's conventions cut across ----
      // `prefer-option-over-null` also fires on `?: T | undefined`, which is
      // the ONLY spelling of an optional member `exactOptionalPropertyTypes`
      // lets a caller forward an optional of its own into (AGENTS.md). A bare
      // `null` / `undefined` in a return type is still a finding to read; the
      // options-object members are not.
      "effect/prefer-option-over-null": "warn",
      // `unknown` is the honest type at the two boundaries these libraries
      // sit on: a caught failure handed to an error tracker or a log line
      // (`describeError`, `describeSessionDegraded`), and the free-form
      // fields of a structured log event. Parsing them would change the
      // applications' log shape.
      "effect/no-unknown-parameters": "warn",
      "effect/no-unsafe-dictionary-type": "warn",
      "effect/no-runtime-typeof": "warn",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      // Build/test configs are evaluated by Vite and Vitest in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The Effect preset's
      // service rules have no satisfiable fix in these files.
      {
        files: ["**/vite.config.ts", "**/vitest.config.ts", "vite.package.ts", "scripts/**"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          // Plain Node build tooling (the task-graph builder, the dist guard):
          // native loops, `.length` and `Object.fromEntries` are the idiom.
          "effect/imperative-loops": "off",
          "effect/no-length-comparison": "off",
          "effect/prefer-arr-match": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
          // `...(process.env.X ? { x } : {})` is how a vitest option is left
          // unset under `exactOptionalPropertyTypes`.
          "effect/no-conditional-empty-object-spread": "off",
        },
      },
      // Type-level tests: the expect-error directives ARE the assertions
      // (a statement that must fail to compile), and every binding exists to
      // be asserted against, never to be read.
      {
        files: ["**/tests/**/*.types.ts"],
        rules: {
          "eslint/no-unused-vars": "off",
          "effect/avoid-ts-ignore": "off",
        },
      },
      // Test fixtures are the seams under test, not domain code: a
      // wall-clock `Date` standing in for a publication stamp, a `CI`
      // variable toggled to drive a reporter. Each stays visible as a
      // warning, because a fixture cannot be written another way.
      {
        files: ["**/tests/**/*.ts"],
        rules: {
          "effect/require-safety-comment-for-type-assertion": "warn",
          "effect/use-clock-service": "warn",
          "effect/avoid-process-env": "warn",
          "effect/require-effect-concurrency": "warn",
        },
      },
    ],
    // Type-aware linting is intentionally disabled: type checking stays the
    // `check` tasks' job (native tsc, Effect-patched).
    options: {
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  run: {
    tasks: {
      // The CI typecheck gate, as one task: every package's `check` (`src`
      // under tsconfig.json, the tests under tsconfig.test.json) plus the
      // root tsconfig.test.json (the integration suite and `examples/`). The
      // packages are named explicitly — a `from: "dependencies"` edge does
      // not traverse the workspace root's own devDependencies — so a new
      // package adds itself to EVERY list here.
      check: {
        command: "tsc -p tsconfig.test.json",
        dependsOn: [
          "@thomasfosterau/effect-document#check",
          "@thomasfosterau/effect-csv#check",
          "@thomasfosterau/effect-iwork#check",
          "@thomasfosterau/effect-ooxml#check",
          "@thomasfosterau/effect-pdf#check",
          "@thomasfosterau/effect-rtf#check",
        ],
        cache: false,
      },
      // Import guard: the built dist of every published package imports no
      // removed `effect/unstable/*` path (the family's rc.118 floor). Reads
      // `dist/`, hence the build edges.
      "check:dist": {
        command: "node scripts/check-dist-imports.mjs",
        dependsOn: [
          "@thomasfosterau/effect-document#build",
          "@thomasfosterau/effect-csv#build",
          "@thomasfosterau/effect-iwork#build",
          "@thomasfosterau/effect-ooxml#build",
          "@thomasfosterau/effect-pdf#build",
          "@thomasfosterau/effect-rtf#build",
        ],
        cache: false,
      },
      // The cross-package suite under `test/integration` (conversions between
      // formats). It resolves every package name to its `src/` (the
      // `integration` project below), so it needs no build.
      "test:integration": {
        command: "vp test run --project integration",
        cache: false,
      },
      // Every package's unit suite plus the integration suite under one
      // Istanbul coverage map (`coverage/coverage-final.json`), which `fallow
      // audit` reads for exact per-function CRAP scores (`health.coverage` in
      // .fallowrc.json). Without it fallow estimates every function as
      // uncovered, and any function with cyclomatic complexity ≥ 5 fails the
      // gate on its own. Run this before `fallow audit` (the Claude Code
      // PreToolUse fallow gate runs the audit on `git commit` / `git push`
      // but never refreshes this map).
      //
      // One vitest process runs every package's suite, so no
      // `{ from: "dependencies" }` edge builds the siblings a suite imports
      // through `exports` (→ `dist/`); every package's `build` is named
      // explicitly (cached, so a warm tree pays nothing).
      "test:coverage": {
        command: "vp test run --coverage",
        dependsOn: [
          "@thomasfosterau/effect-document#build",
          "@thomasfosterau/effect-csv#build",
          "@thomasfosterau/effect-iwork#build",
          "@thomasfosterau/effect-ooxml#build",
          "@thomasfosterau/effect-pdf#build",
          "@thomasfosterau/effect-rtf#build",
        ],
        cache: false,
      },
    },
  },
  test: {
    // One entry per package (each package's own vite.config.ts is a vitest
    // project), plus the integration suite, so the root run and the root
    // coverage map cover them all.
    projects: [
      "packages/*/vite.config.ts",
      {
        resolve: { alias: integrationAliases },
        test: {
          name: "integration",
          include: ["test/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
});
