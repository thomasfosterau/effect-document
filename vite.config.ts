// Workspace-wide format, lint and staged settings, the root task graph and
// the root test projects. The package's own tasks live in `vite.package.ts`.

import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import { packageAliases } from "./vite.package.ts";
import { options as core } from "./packages/core/vite.config.ts";

const integrationAliases = packageAliases(core);

export default defineConfig({
  staged: {
    "*.{js,ts,css,json,md}": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/vendor/**"],
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
    ignorePatterns: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/vendor/**"],
    extends: [recommended, effect.configs.recommended],
    plugins: ["typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
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
      // `_tag` is the discriminant of every Effect tagged value; the rule
      // knows no other way to allow it.
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
      // Vitest's `expect(value, message)` takes the failure message as its
      // second argument.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      // `survives` is the fuzz suites' assertion helper.
      "vitest/expect-expect": ["error", { assertFunctionNames: ["expect", "assert", "survives"] }],
      // `@effect/vitest`'s test blocks.
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            "it.effect",
            "it.live",
            "it.effect.each",
            "it.live.each",
            "it.effect.prop",
            "it.live.prop",
            "it.effect.only",
            "it.effect.skip",
          ],
        },
      ],
      // The flagged lists are a few module-level strings; a top-level `new Set`
      // would be a side effect in `dist/` and an `avoid-native-object-helpers` finding.
      "unicorn/prefer-set-has": "off",
      // `Buffer` is Node-only and typed `any` under @cloudflare/workers-types.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array / TextEncoder / DataView.",
        },
      ],
      // The workspace imports Effect modules under their full names.
      "effect/prefer-namespace-imports": "off",
      // "Shape" is the presentation-domain noun (a slide's drawing objects).
      "effect/no-shape-in-symbol-names": "off",
      // Name-based; every `make*` here is a plain factory, not a service.
      "effect/no-service-constructor-imports": "off",

      // Allowances for code that predates the Effect preset: every site stays
      // reported, and a new one is a defect. Delete a line once its count is 0.
      // Hot-path loops over bytes, glyphs and XML children, and explicit-stack walks.
      "effect/imperative-loops": "warn",
      // `buf[i]!` beside a bounds check the compiler can't see.
      "effect/avoid-non-null-assertion": "warn",
      // Public `Map` / `Set` APIs (`PdfDict.entries`, `Profile.features`) and decoder caches.
      "effect/avoid-native-object-helpers": "warn",
      // Also fires on `?: T | undefined`, the spelling `exactOptionalPropertyTypes` needs.
      "effect/prefer-option-over-null": "warn",
      // `unknown` at decoder input boundaries.
      "effect/no-unknown-parameters": "warn",
      "effect/no-unsafe-dictionary-type": "warn",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      // Configs and scripts run in bare Node, outside any Effect runtime.
      {
        files: ["**/vite.config.ts", "**/vitest.config.ts", "vite.package.ts", "**/scripts/**"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/imperative-loops": "off",
          "effect/no-length-comparison": "off",
          "effect/prefer-arr-match": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
          "effect/use-command-executor-service": "off",
          "effect/use-temp-file-scoped": "off",
          "effect/avoid-direct-json": "off",
          "effect/avoid-try-catch": "off",
          "effect/avoid-untagged-errors": "off",
        },
      },
      // Benchmarks time samples in bare Node: an Effect around each sample
      // would be measured too.
      {
        files: ["bench/**/*.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
          "effect/use-console-service": "off",
          "effect/avoid-process-env": "off",
          "effect/imperative-loops": "off",
          "effect/no-length-comparison": "off",
          "effect/avoid-native-object-helpers": "off",
          "effect/no-unknown-returns": "off",
          "effect/avoid-non-null-assertion": "off",
          "effect/prefer-option-over-null": "off",
          "effect/use-filesystem-service": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-node-imports": "off",
          "eslint/no-await-in-loop": "off",
        },
      },
      // The examples are entrypoints that run their program.
      {
        files: ["examples/**/*.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
          "effecttsgo/strict-effect-provide": "off",
        },
      },
      // A regression test counts `charCodeAt` calls by patching the prototype
      // (`vi.spyOn` runs out of memory there).
      {
        files: ["packages/core/test/csv/csv.test.ts"],
        rules: {
          "eslint/no-extend-native": "off",
          "typescript/unbound-method": "off",
        },
      },
      // Type-level tests: expect-error directives are the assertions.
      {
        files: ["**/test/**/*.types.ts"],
        rules: {
          "eslint/no-unused-vars": "off",
          "effect/avoid-ts-ignore": "off",
        },
      },
      {
        files: ["**/test/**/*.ts"],
        rules: {
          "eslint/no-await-in-loop": "off",
          // `@effect/vitest` is marked unstable; the tests use it deliberately.
          "effecttsgo/unstable-api-usage": "off",
          // `layer(...)` hands each block its own `it`.
          "eslint/no-shadow": ["error", { allow: ["it"] }],
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
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
      // The API reference the Pages workflow publishes. Examples are
      // rendered but not compiled (`tscExecutable: "true"` in docgen.json).
      docgen: { command: "vp run --filter ./packages/core docgen", cache: false },
      // The whole CI gate, in order, failing fast. `test:interop` skips a
      // missing tool unless INTEROP=1; `test:validate` fails without xmllint
      // under CI.
      ci: {
        command:
          "vp check && vp run --concurrency-limit 2 check && vp run -r test:unit && vp run test:integration && vp run corpora:fetch && vp run test:validate && vp run test:corpus && vp run test:interop && vp run -r build && vp run check:dist && vp run examples && vp run check:pack && pnpm audit --audit-level high",
        cache: false,
      },
      // The package's `check`, then the root config (integration suite,
      // examples, bench). Named explicitly: a `from: "dependencies"` edge
      // doesn't follow the root's own devDependencies.
      check: {
        command: "tsc -p tsconfig.test.json",
        dependsOn: ["@thomasfosterau/effect-document#check"],
        cache: false,
      },
      // The built dist imports no `effect/unstable/*`, and the core entries
      // reach no format dependency.
      "check:dist": {
        command: "node scripts/check-dist-imports.mjs",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      // Packs, lints and installs the tarball into a scratch project and
      // type-checks every entry. Needs the registry.
      "check:pack": {
        command: "node scripts/check-pack.mjs",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      // The publish job's script (.github/workflows/release.yml), after the
      // offline dist check on the same commit: pnpm publishes each
      // public package whose version isn't on npm yet, under OIDC trusted
      // publishing; then `changeset git-tag` tags each untagged version and
      // reports the tags to `changesets/action` through `CHANGESETS_OUTPUT`,
      // which pushes them and creates the GitHub releases. A failed publish
      // stops before tagging; a re-run publishes only what is missing.
      // Uncached, so it sees the job's full environment. Never `check:pack`:
      // its consumer install fetches registry code, which must not run in the
      // job that holds `id-token: write`; CI runs it.
      release: {
        command: [
          "vp pm publish -r --access public --no-git-checks -- --ignore-scripts",
          "changeset git-tag",
        ],
        dependsOn: ["check:dist"],
        cache: false,
      },
      // What `release` would publish, without publishing or tagging.
      "release:dry-run": {
        command: "vp pm publish -r --access public --dry-run --no-git-checks -- --ignore-scripts",
        dependsOn: ["check:dist"],
        cache: false,
      },
      examples: {
        command:
          "vpx examples/document-ast.ts && vpx examples/streaming.ts && vpx examples/convert-csv-to-xlsx.ts && vpx examples/read-iwork-directory.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      // Not in CI: the numbers depend on the machine. `BENCH_TIME` (ms per
      // group) and `BENCH_FILTER` (a group-name substring) narrow a run.
      // Sequential, so one benchmark never runs beside another.
      bench: {
        command:
          "node --expose-gc bench/csv.bench.ts && node --expose-gc bench/xlsx.bench.ts && node --expose-gc bench/docx.bench.ts && node --expose-gc bench/pptx.bench.ts && node --expose-gc bench/rtf.bench.ts && node --expose-gc bench/pdf.bench.ts && node --expose-gc bench/iwork.bench.ts && node --expose-gc bench/convert.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:csv": {
        command: "node --expose-gc bench/csv.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:xlsx": {
        command: "node --expose-gc bench/xlsx.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:docx": {
        command: "node --expose-gc bench/docx.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:pptx": {
        command: "node --expose-gc bench/pptx.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:rtf": {
        command: "node --expose-gc bench/rtf.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:pdf": {
        command: "node --expose-gc bench/pdf.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:iwork": {
        command: "node --expose-gc bench/iwork.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "bench:convert": {
        command: "node --expose-gc bench/convert.bench.ts",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      "test:integration": {
        command: "vp test run --project integration",
        cache: false,
      },
      // Fetches the corpora pinned in `corpora.json` into `.corpora/`. Needs the network.
      "corpora:fetch": {
        command: "node scripts/fetch-corpora.mjs",
        cache: false,
      },
      "test:corpus": {
        command: "vp test run --project corpus",
        cache: false,
      },
      "test:validate": {
        command: "vp test run --project validate",
        cache: false,
      },
      "test:interop": {
        command: "vp test run --project interop",
        cache: false,
      },
      // One Istanbul map over the unit and integration suites, which `fallow
      // audit` reads for its per-function CRAP scores.
      "test:coverage": {
        command:
          "vp test run --coverage --project '!corpus' --project '!validate' --project '!interop'",
        dependsOn: ["@thomasfosterau/effect-document#build"],
        cache: false,
      },
      fallow: {
        command: "vp exec fallow --summary",
        cache: false,
      },
      "fallow:audit": {
        command: "vp exec fallow audit --base origin/trunk --quiet",
        dependsOn: ["test:coverage"],
        cache: false,
      },
    },
  },
  test: {
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
      // Writer output against the ECMA-376 schemas, with xmllint.
      {
        resolve: { alias: integrationAliases },
        test: {
          name: "validate",
          include: ["test/validate/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
      // Writer output opened by LibreOffice, qpdf, pdftotext and pandoc.
      {
        resolve: { alias: integrationAliases },
        test: {
          name: "interop",
          include: ["test/interop/**/*.test.ts"],
          testTimeout: 180_000,
        },
      },
      // Every reader over the fetched corpora; skipped when none is fetched.
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
