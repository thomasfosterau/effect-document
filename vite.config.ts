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
      // @cloudflare/workers-types next to @types/node, so every call on it is
      // unchecked there. These readers and writers work on bytes, so the rule
      // is load-bearing: use Uint8Array / TextEncoder / DataView instead.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array / TextEncoder / DataView.",
        },
      ],
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`, including the narrowings a byte-level decoder
      // structurally requires. Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import * as Option from
      // "effect/Option"`) this family shares with its consumers.
      "effect/prefer-namespace-imports": "off",
      // "Shape" here is the presentation-domain term, not a description of
      // structure: a slide's drawing objects are shapes (PresentationML
      // `<p:sp>`, Keynote's drawables), and `Shape` / `TextBox` / `Picture` /
      // `TableShape` are the document model's public schema for them. The
      // rule cannot tell the domain noun from the structural one.
      "effect/no-shape-in-symbol-names": "off",
      // Name-based: it flags any relative import of a `make[A-Z]…` function
      // as an Effect service constructor. Every `make*` this workspace
      // exports (`makeCsvReader`, `makeXlsxWriter`, `makePdfReader`, …) is a
      // dependency-free factory returning a plain `Reader` / `Writer` value
      // with no `R` requirement, and each package's `format` bundle is built
      // from them by design; there is no service or Layer to yield instead.
      "effect/no-service-constructor-imports": "off",

      // ---- Effect preset: ported-code allowances ---------------------------
      // The modules under packages/*/src predate the Effect oxlint preset.
      // The rules below sit at `warn` so the code stays committable while each
      // site stays reported; a new site is a defect, not headroom. Once a
      // rule's count reaches zero its line is deleted, so it is back at the
      // preset's `error`.
      // Remaining sites are listed in effect-document#155, which also says
      // why each rule could not reach zero in the migration PR.
      // 256 sites in packages/*/src (pdf 142, ooxml 47, iwork 32, core 22, csv
      // 7, rtf 6): indexed loops over bytes, glyphs and XML children in the
      // decoders' hot paths, and the explicit-stack walks that keep deep
      // documents off the call stack.
      "effect/imperative-loops": "warn",
      // 187 sites in packages/*/src (pdf 107, ooxml 40, iwork 23, csv 8,
      // rtf 6, core 3): `buf[i]!`-style reads beside a bounds check the
      // compiler cannot see (`noUncheckedIndexedAccess`).
      "effect/avoid-non-null-assertion": "warn",
      // 86 sites in packages/*/src (pdf 39, ooxml 27, iwork 12, rtf 4, core 2,
      // csv 2): `PdfDict.entries` is a public `Map` in the `./cos` object
      // model and `Profile.features` / `collectFeatures` are public `Set`s
      // (a `HashMap` / `HashSet` would change that API), the rest are decoder
      // caches and identity-keyed cycle guards; plus the CSV compiled-parser
      // memo (a bounded cache keyed by the option string).
      "effect/avoid-native-object-helpers": "warn",
      // ---- Effect preset: rules this workspace's conventions cut across ----
      // `prefer-option-over-null` also fires on `?: T | undefined`, which is
      // the ONLY spelling of an optional member `exactOptionalPropertyTypes`
      // lets a caller forward an optional of its own into (AGENTS.md). A bare
      // `null` / `undefined` in a return type is still a finding to read; the
      // options-object members are not.
      "effect/prefer-option-over-null": "warn",
      // `unknown` is the honest type at a decoder's input boundary (a cell
      // value, a JSON metadata entry), and a PDF object is a union of
      // primitives that `typeof` discriminates. Each stays visible.
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
          // The pack smoke test (scripts/check-pack.mjs) is bare-Node tooling
          // too: it shells out to pnpm, npm, publint, attw and tsc, reads and
          // writes package manifests as JSON, works in an `os.tmpdir()`
          // scratch directory it removes in `finally`, and fails the task by
          // throwing; no Effect runtime or service layer exists there.
          "effect/use-command-executor-service": "off",
          "effect/use-temp-file-scoped": "off",
          "effect/avoid-direct-json": "off",
          "effect/avoid-try-catch": "off",
          "effect/avoid-untagged-errors": "off",
          // scripts/fetch-corpora.mjs likewise shells out to git and reads
          // corpora.json with JSON.parse.
          // `...(process.env.X ? { x } : {})` is how a vitest option is left
          // unset under `exactOptionalPropertyTypes`.
          "effect/no-conditional-empty-object-spread": "off",
        },
      },
      // The runnable examples are entrypoints: each ends by running its
      // program, which is exactly what the rule asks to keep at the boundary.
      {
        files: ["examples/**/*.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
        },
      },
      // Type-level tests: the expect-error directives ARE the assertions
      // (a statement that must fail to compile), and every binding exists to
      // be asserted against, never to be read.
      {
        files: ["**/test/**/*.types.ts"],
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
        files: ["**/test/**/*.ts"],
        rules: {
          // A test body is the boundary that runs the effect under test, and
          // the rule has no entrypoint detection (effect-web disables it per
          // file in its suites; here it is one override for every suite).
          "effect/effect-run-in-body": "off",
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
      // Consumer smoke test: packs every package as `pnpm publish` would,
      // lints the tarballs (publint, attw), installs them into a scratch
      // project from npm and imports and type-checks every entry. Reads
      // `dist/`, hence the build edges; needs the registry.
      "check:pack": {
        command: "node scripts/check-pack.mjs",
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
      // Runs every program under `examples/` (the README's worked examples)
      // against the built packages, as a consumer would: each imports the
      // packages by name, which resolves through `exports` to `dist/` — hence
      // the build edges. `convert-csv-to-xlsx` writes a git-ignored
      // `output.xlsx` to the workspace root.
      examples: {
        command:
          "tsx examples/document-ast.ts && tsx examples/streaming.ts && tsx examples/convert-csv-to-xlsx.ts",
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
      // Fetches the public corpora pinned in `corpora.json` into the
      // git-ignored `.corpora/` (shallow, sparse checkouts; a corpus already
      // at its pin is kept). Needs the network.
      "corpora:fetch": {
        command: "node scripts/fetch-corpora.mjs",
        cache: false,
      },
      // Runs every reader over every fetched corpus file (`test/corpus`),
      // failing on a defect or a hang and reporting read rates per format;
      // skipped when nothing has been fetched.
      "test:corpus": {
        command: "vp test run --project corpus",
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
        command: "vp test run --coverage --project '!corpus'",
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
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      // Corpus smoke mode (#133): every reader over the corpora fetched into
      // `.corpora/` (`corpora:fetch`); skipped when none has been fetched.
      {
        resolve: { alias: integrationAliases },
        test: {
          name: "corpus",
          include: ["test/corpus/**/*.test.ts"],
          testTimeout: 60_000,
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
