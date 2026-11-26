# taskshoot-socket-agent — guide for AI agents

A resident daemon that automatically replies to Taskshoot mentions with an AI agent.
The agent backend is swappable (Claude Agent SDK / Hermes Agent CLI / Codex CLI).
See README.md for the overview and setup. Only information used repeatedly during development is written here.

## Tech stack

- Node.js >= 20.6 / TypeScript (ESM, `type: module`)
- pnpm
- `@anthropic-ai/claude-agent-sdk` (backend `claude`)
- Hermes Agent CLI (backend `hermes`; a command on the host, not an npm dependency)
- Codex CLI (backend `codex`; same as above)
- Tests: Node's built-in `node --test` + tsx (AAA pattern)

## Commands

```shell
pnpm build        # tsc → dist/
pnpm check        # type check only
pnpm test         # test/*.test.ts
pnpm dev          # run directly with tsx (requires an authenticated taskshoot CLI)
pnpm start        # run dist/main.js
```

## Distribution

It can be installed with `pnpm add -g --allow-build=taskshoot-socket-agent github:cyberneura/taskshoot-socket-agent`
(`prepare` runs tsc, so dist does not need to be committed).
Because it depends on building at install time, there are two constraints. Both were confirmed by actual measurement:

- `--allow-build` is required (confirmed on pnpm 10.29; it was not needed on 10.17). Current pnpm does not
  run the build script of git-sourced packages without an allowlist
- **`npm install -g <git url>` does not work**: npm does not install devDependencies for global git
  installs, so there is no tsc (`--include=dev` does not change this)

Both are caused by "building at install time", so they go away once it is published to the npm registry
(the published package contains dist via `files`, so no build is needed; confirmed by `-g` installing the
`npm pack` tarball). It is not published yet. Publishing is `npm login && npm publish`.

- `bin/taskshoot-socket-agent.mjs` — the `bin` entry. `--version` / `--help` answer
  without importing dist/main.js (importing it starts the daemon and takes the
  lock, which would make it impossible to smoke-test the installation)
- Anything not listed in `files` is not included in the package. Check it when adding sources

## pnpm 11 and build scripts

Do not remove `allowBuilds: {esbuild: true}` from `pnpm-workspace.yaml`.
pnpm 11 **fails the install** when there are unapproved build scripts
(`ERR_PNPM_IGNORED_BUILDS`; pnpm 10 only warns). `bin/start.sh` runs
`pnpm install --frozen-lockfile` under `set -e`, so without the approval the first start on a new host
fails there (node_modules and dist do get created, so it comes up on the supervisor's retry, but
a start failure that looks FATAL is logged once every time).

The key name is pnpm 11's. **`onlyBuiltDependencies` / `ignoredBuiltDependencies` have no effect on
11** (that is the pnpm 10 syntax; measured on 11.21). When more dependencies with build scripts are added,
run `pnpm approve-builds --all` and update this file.

## Layout

- `src/main.ts` — entry point. WS subscription + polling backstop + serial queue
- `src/listen.ts` — subscribing to `taskshoot listen` (WebSocket, JSON Lines)
- `src/taskshoot.ts` — a thin wrapper around the taskshoot CLI (notifications, read state, activity)
- `src/activity.ts` — the "回答を考えています…" ("Thinking about a reply…") indicator (per-task reference counting +
  promise-chain serialization + a global semaphore)
- `src/runner.ts` — backend selection (`TSSA_AGENT_BACKEND`)
- `src/backends/types.ts` — the backend contract (`runAgent(prompt, opts) -> {result, sessionId}`)
- `src/backends/claude.ts` — Claude Agent SDK (default)
- `src/backends/hermes.ts` — Hermes Agent CLI
- `src/backends/codex.ts` — Codex CLI (`codex exec --json`)
- `src/backends/child-process.ts` — launching, timeouts and process-group cleanup shared by the
  backends that run as child processes (hermes / codex)
- `src/shutdown.ts` — shutdown state (closing intake + cleanup registration)
- `src/sentry.ts` — opt-in error reporting (everything is a no-op without a DSN. It pins the places where
  SDK defaults would change the daemon's behaviour. The README's "Error reporting" is the source of truth)
- `src/state.ts` — the handled-id ledger and session storage (the source of truth for preventing double replies)
- `src/prompt.ts` — the agent's operating policy. `TSSA_POLICY` switches between `work` (default; real work is
  allowed on tasks with Bot Ready OFF that no other agent is touching) and `safe` (conversation and investigation only).
  The effective policy is `runner.effectivePolicy` (codex + `workspace-write` cannot write, so it is `safe`)
- `skills/taskshoot-socket-agent/SKILL.md` (for `work`) and
  `skills/taskshoot-socket-agent-safe/SKILL.md` (for `safe`) — agent skills for distribution
  (`npx skills add cyberneura/taskshoot-socket-agent -s <name>`). Do not put them in `.claude/skills/`
  (both are discovery targets, so they would be listed twice). The two are almost identical except for
  the policy section, so when you fix one, fix the other too

## Caveats when changing things

- On shutdown, "stopping what is running" is not enough. A killed run rejects, so the
  queue takes the next mention and posts during the grace period. That reply is not recorded in the ledger
  (because the daemon that would record it goes down), so it is posted again after restart. **Closing intake**
  is needed as the counterpart. `src/shutdown.ts` is the source of truth for this.
- The handled-id ledger is the source of truth for preventing double replies. WS has no ACK and a limit on
  catch-up after reconnecting, so the design does not trust it. The reason for the marking order (read → ledger)
  in terms of crash safety is written in a comment.
- The activity indicator is best-effort (a failure does not stop the run). The concurrency invariants
  (per-task serial chain / refcount / bounded fairness of the semaphore / the relationship between the TTL and
  refresh supply capacity) have `src/activity.ts`'s comments as their source of truth. When changing them, also
  update the numbers the comments assume.
- **Do not make SKILL.md a summary of the README.** Its readers are third parties who installed this app as OSS
  and their agents, so do not write a single local environment detail, organization-specific name or personal path.
  Check the text **against the implementation**, not against the README (the README itself carries caveats, so
  copying it is not verification. Summarizing drops the caveats and turns them into assertions, which then
  become errors as is).
  Prose is not executed, so tests do not catch it. When requesting a review, state explicitly that
  "the content of the text itself is what is under review", "verify the facts", and
  "check whether it is correct in the environment of a third party installing this app for the first time".
  Example: the default state directory is built from `homedir()`, so it is `~/.local/state/...` even on macOS
  (it does not follow the platform's conventions).
  Writing "follows XDG" would be wrong
- When writing escapes such as `\u0000` in source, if real bytes get mixed in via a generation tool, git
  treats the file as binary. Before committing, check that `git diff --staged --stat` shows no `Bin`.
