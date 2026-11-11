# CLAUDE.md

Instructions for Claude Code only: its hooks, its settings and the constraints of a Claude session. Everything that applies to any contributor or agent is in the files imported at the end (the agent guidance and verification gates in `AGENTS.md`, setup, commands and the branch and pull-request rules in `CONTRIBUTING.md`, the overview in `README.md`); `packages/core/CLAUDE.md` imports the package's own `AGENTS.md`.

## Hooks and settings

`.claude/settings.json` wires three hooks and enables the plugins this repository uses (`typescript-lsp`, `code-review`, `github`, `claude-md-management`, `commit-commands`, `pr-review-toolkit`, `code-simplifier`).

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's network allowlist), links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`), and runs `vp install --frozen-lockfile`. Everything else goes through Vite+: `vp exec fallow …` for fallow, `vpx <file>.ts` for TypeScript programs. Nothing else is put on PATH. If the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets; none are needed, and nothing here can publish.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` (run as `vp exec fallow`) fails; it audits only this checkout and its `.claude/worktrees/*`, skipping any other tree with a notice, and first regenerates the coverage map (`vp run test:coverage`) when it is missing or older than any `.ts` / `.mjs` file under `packages/`, `test/`, `examples/` or `bench/`, blocking if that fails (`FALLOW_GATE_SKIP_COVERAGE=1` skips the refresh). A PostToolUse hook runs `vp fmt` on every source, JSON, CSS or Markdown file you write or edit.

## Sessions

- Agent work uses git worktrees under `.claude/worktrees/`, one per branch, named `issue-<n>-<slug>` for issue-linked work. Start every command that targets a worktree with an explicit `cd` and confirm with `git log -1` before committing. A worktree needs its own `pnpm install`: the global `vp` delegates to the checkout's own `vite-plus`, so a worktree without `node_modules` has none to run.
- Every gate in [Verification](../AGENTS.md#verification) runs in an agent session; `vp run check:pack` and `pnpm audit` need the network.

@../AGENTS.md

@../CONTRIBUTING.md

@../README.md
