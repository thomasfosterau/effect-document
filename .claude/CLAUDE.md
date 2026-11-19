# Claude Code

Read README.md, docs/CONTRIBUTING.md and AGENTS.md (imported below). This file covers only Claude Code's own setup.

- **Hooks** ([settings.json](settings.json)). PostToolUse runs `vp fmt --write` on edited source, JSON and Markdown files. The fallow gate is the Vite+ pre-commit hook, not a Claude hook.
- **Worktrees** go under `.claude/worktrees/`, one per branch. Run `vp install` in a new one before anything else.
- **Package guidance** loads with the package: `packages/core/CLAUDE.md` imports its `AGENTS.md`.

@../README.md

@../docs/CONTRIBUTING.md

@../AGENTS.md
