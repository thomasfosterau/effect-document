/**
 * Import guard for the published package, on Effect rc.118 (the family floor):
 * its built `dist/` must import no removed `effect/unstable/*` path, and the
 * core entries must reach no format dependency. Run after `vp run -r build`
 * (`vp run check:dist`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const packages = ["core"];
const forbidden = [/["'`]effect\/(?:unstable|httpapi)(?:\/[^"'`]*)?["'`]/];

const failures = [];
for (const name of packages) {
  const dist = join("packages", name, "dist");
  const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).filter((f) =>
    /\.(?:js|mjs|cjs|d\.ts|d\.mts|d\.cts)$/.test(f),
  );
  if (files.length === 0) failures.push(`${dist}: no built files (run vp run -r build first)`);
  for (const file of files) {
    const text = readFileSync(join(dist, file), "utf8");
    for (const pattern of forbidden) {
      const hit = text.match(pattern);
      if (hit) failures.push(`${join(dist, file)}: imports ${hit[0]}`);
    }
  }
}

// What each published entry loads: walk the built import graph from each
// `exports` entry and collect the packages it reaches. The core entries reach
// neither `fflate`, `@thomasfosterau/effect-ext` (only `/encoding` does) nor the
// optional `@thomasfosterau/effect-parse` peer, and
// `/pdf*` reaches no effect-parse (test/module-graph.test.ts checks `src/`).
// Rolldown writes every static import at the start of a line; a doc comment
// that shows an import never starts one.
const importRe = /^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^import\s*["']([^"']+)["']/gm;
const reach = (entry) => {
  const seen = new Set();
  const found = new Set();
  const stack = [resolve(entry)];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, from, bare] of readFileSync(file, "utf8").matchAll(importRe)) {
      const spec = from ?? bare;
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
      else
        found.add(
          spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0],
        );
    }
  }
  return found;
};
const coreEntries = [".", "./schema", "./profile", "./profiles", "./io"];
const forbiddenFrom = (key) =>
  coreEntries.includes(key)
    ? ["fflate", "@thomasfosterau/effect-parse", "@thomasfosterau/effect-ext"]
    : key === "./pdf" || key.startsWith("./pdf/")
      ? ["@thomasfosterau/effect-parse"]
      : [];
for (const name of packages) {
  const dir = join("packages", name);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key === "./package.json") continue;
    const reached = reach(join(dir, target.default));
    for (const dep of forbiddenFrom(key)) {
      if (reached.has(dep)) failures.push(`${manifest.name}${key.slice(1)}: dist reaches ${dep}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `check:dist: ${packages.join(", ")} imports no effect/unstable, and its core entries reach no format dependency`,
);
