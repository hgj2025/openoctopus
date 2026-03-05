# Repository Guidelines

This is a Feishu-focused AI agent built on the OpenClaw gateway framework.
Primary use case: handling Feishu documents, reading/writing code, coding assistance, and git operations.

- In chat replies, file references must be repo-root relative only (e.g. `src/commands/agent/run.ts:80`); never absolute paths.
- GitHub comments/PR comments: use literal multiline strings or `-F - <<'EOF'` for real newlines; never embed `\n`.

## Project Structure

- Source code: `src/` (CLI in `src/cli`, commands in `src/commands`, infra in `src/infra`, media in `src/media`).
- Tests: colocated `*.test.ts`.
- Config: `config/` (vitest configs).
- Docker: `docker/` (Dockerfiles, docker-compose.yml, setup.sh).
- Docs: `docs/`. Built output: `dist/`.
- Extensions (channel plugins): `extensions/*` (workspace packages).
  - Active: `extensions/feishu` (primary channel), `extensions/memory-core`, `extensions/memory-lancedb`, `extensions/diffs`, `extensions/shared`, `extensions/test-utils`.
- Skills: `skills/` (coding-agent, github, gh-issues, session-logs, tmux, summarize, model-usage).

## Channel: Feishu

- Extension: `extensions/feishu/`
- Tools: documents, wiki, drive, bitable, directory, message cards, SSE streaming
- Feishu webhook events are received by the extension and dispatched to the agent pipeline

## Build, Test, and Development Commands

- Runtime: Node **22+** (Bun also supported).
- Install deps: `pnpm install`
- Run CLI: `pnpm openclaw ...` or `pnpm dev`
- Build: `pnpm build`
- Type-check: `pnpm tsgo`
- Lint/format: `pnpm check`
- Format fix: `pnpm format:fix`
- Tests: `pnpm test`; coverage: `pnpm test:coverage`

## Plugins / Extensions

- Plugin-only deps go in the extension `package.json`; do not add to root unless core uses them.
- Runtime deps must be in `dependencies` (not `devDependencies`); `npm install --omit=dev` runs in plugin dir.
- Avoid `workspace:*` in `dependencies`; use `devDependencies` or `peerDependencies` for the core package.

## Coding Style

- Language: TypeScript ESM. Strict typing; avoid `any`.
- Formatter: oxfmt; linter: oxlint. Run `pnpm check` before commits.
- Never add `@ts-nocheck`; fix root causes.
- Keep files under ~700 LOC; extract helpers as needed.
- Add brief comments for non-obvious logic.

## Commit Guidelines

- Use `scripts/committer "<msg>" <file...>` for scoped staging.
- Concise action-oriented messages (e.g. `feishu: add bitable record tool`).

## Agent-Specific Notes

- Never edit `node_modules`.
- CLI progress: use `src/cli/progress.ts` (`osc-progress` + `@clack/prompts`).
- Docker files live in `docker/`; vitest configs live in `config/`.
- `.docs/` contains project planning docs (refactoring plan, architecture analysis).
