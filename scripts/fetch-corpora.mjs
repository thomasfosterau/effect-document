#!/usr/bin/env node
/**
 * Fetches the public test corpora pinned in `corpora.json` into the
 * git-ignored `.corpora/` cache (#133). Corpora are fetched, never committed:
 * each is a shallow, sparse, blob-filtered checkout of one pinned commit,
 * holding only the files its `paths` globs match, in
 * `.corpora/<id>/<commit>/`. A corpus already present at its pin is skipped,
 * so CI can cache `.corpora/` keyed by `corpora.json`.
 *
 * Usage: node scripts/fetch-corpora.mjs [id ...]   (default: every corpus)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cache = join(root, ".corpora");
const manifest = JSON.parse(readFileSync(join(root, "corpora.json"), "utf8"));
const wanted = new Set(process.argv.slice(2));

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "inherit"] });

const unknown = [...wanted].filter((id) => !manifest.corpora.some((c) => c.id === id));
if (unknown.length > 0) {
  console.error(`unknown corpus: ${unknown.join(", ")}`);
  process.exit(1);
}

for (const corpus of manifest.corpora) {
  if (wanted.size > 0 && !wanted.has(corpus.id)) continue;
  const dir = join(cache, corpus.id, corpus.commit);
  const done = join(dir, ".fetched");
  if (existsSync(done)) {
    console.log(`${corpus.id}: cached at ${corpus.commit.slice(0, 12)}`);
    continue;
  }
  // a previous pin, or a fetch that died half-way, is replaced
  rmSync(join(cache, corpus.id), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`${corpus.id}: fetching ${corpus.repository} at ${corpus.commit.slice(0, 12)}`);
  git(dir, "init", "--quiet");
  git(dir, "remote", "add", "origin", corpus.repository);
  git(dir, "sparse-checkout", "set", "--no-cone", ...corpus.paths);
  git(dir, "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", corpus.commit);
  git(dir, "checkout", "--quiet", "FETCH_HEAD");
  // `ls-files -t` marks the entries the sparse checkout skipped with "S"
  const files = git(dir, "ls-files", "-t")
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("H ")).length;
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  writeFileSync(done, `${corpus.commit}\n`);
  console.log(`${corpus.id}: ${files} files`);
}
