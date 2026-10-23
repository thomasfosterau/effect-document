/**
 * Consumer smoke test for the published packages (`vp run check:pack`, after
 * `vp run -r build`): checks what npm would ship, not the workspace.
 *
 * 1. `pnpm pack` each package, the way `pnpm publish` builds the tarball
 *    (`workspace:` and `catalog:` specifiers replaced with real ranges).
 * 2. Lint each tarball: publint (manifest, `exports` and files agree) and
 *    attw with the `esm-only` profile (every entry's types resolve under
 *    node16 / bundler resolution; the packages ship no CommonJS).
 * 3. Install every tarball, plus `effect` and `@types/node` at the catalog
 *    versions, into a scratch project with npm, so `@thomasfosterau/effect-parse` and `fflate`
 *    come from the registry as a consumer gets them.
 * 4. Import every `exports` entry from Node, and type-check an import of
 *    every entry with `module: nodenext` and `skipLibCheck: false`, so the
 *    emitted `.d.ts` must compile under a strict consumer's settings.
 *
 * Needs the network (the registry) for step 3.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packages = ["core", "csv", "iwork", "ooxml", "pdf", "rtf"];
const root = resolve(".");
const bin = (name) => join(root, "node_modules", ".bin", name);
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });

const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
/** A version from the workspace catalog, so the consumer matches the workspace. */
const catalogVersion = (name) => {
  const line = workspace
    .split("\n")
    .find((l) => l.trim().replaceAll('"', "").startsWith(`${name}: `));
  if (line === undefined)
    throw new Error(`no \`${name}\` entry in the pnpm-workspace.yaml catalog`);
  return line.split(": ")[1].trim();
};

const work = mkdtempSync(join(tmpdir(), "effect-document-pack-"));
try {
  const tarballs = [];
  const specifiers = [];
  for (const name of packages) {
    const dir = join(root, "packages", name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const packed = JSON.parse(
      execFileSync("pnpm", ["pack", "--json", "--pack-destination", work], {
        cwd: dir,
        encoding: "utf8",
      }),
    );
    const tarball = resolve(work, packed.filename);
    console.log(`\n${manifest.name}: ${tarball}`);
    run(bin("publint"), ["run", tarball, "--strict"], root);
    run(bin("attw"), [tarball, "--profile", "esm-only", "--format", "table-flipped"], root);
    tarballs.push(tarball);
    for (const key of Object.keys(manifest.exports ?? { ".": null })) {
      if (key !== "./package.json") specifiers.push(manifest.name + key.slice(1));
    }
  }

  const consumer = join(work, "consumer");
  run("mkdir", ["-p", consumer], work);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
  );
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      `effect@${catalogVersion("effect")}`,
      `@types/node@${catalogVersion("@types/node")}`,
      ...tarballs,
    ],
    consumer,
  );

  const imports = specifiers.map((s) => `await import(${JSON.stringify(s)});`).join("\n");
  run("node", ["--input-type=module", "-e", imports], consumer);
  console.log(`\nimported ${specifiers.length} entries from Node ${process.version}`);

  writeFileSync(
    join(consumer, "index.ts"),
    specifiers
      .map((s, i) => `import * as m${i} from ${JSON.stringify(s)};\nvoid m${i};`)
      .join("\n"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          // a Node consumer: effect's own types use `Disposable` and web globals
          lib: ["esnext"],
          types: ["node"],
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["index.ts"],
      },
      null,
      2,
    ),
  );
  run(bin("tsc"), ["-p", "tsconfig.json"], consumer);
  console.log(`type-checked ${specifiers.length} entries (nodenext, skipLibCheck: false)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
