# taskshoot-socket-agent

A daemon that answers [Taskshoot](https://taskshoot.com) mentions in (near)
real time. It subscribes to the notification WebSocket through
[`taskshoot listen`](https://github.com/cyberneura/taskshoot-cli) and runs one
agent per mention; the agent reads the task thread and posts its reply with
`taskshoot task comment` itself.

The agent backend is pluggable (`TSSA_AGENT_BACKEND`):
[Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) in-process
(`claude`, the default) or the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
CLI (`hermes`), for hosts whose main job is browser / desktop work.

```
taskshoot listen (WebSocket, JSON Lines)
        │            plus a polling backstop (unread notifications)
        ▼
  serial queue ── handled-id ledger (no double replies)
        ▼
  agent run   ──────> taskshoot task comment <ref> "..."
```

## What it does — and does not — do

- **Conversation and investigation only.** The agent answers questions, reads
  code/logs on its host and replies in the thread. While a task has mentions
  queued or being answered — from the moment a mention is received until its
  run finished — the thread shows a transient "Thinking about a reply… /
  回答を考えています…" activity indicator (`taskshoot task activity`,
  CLI 0.8.0+; skipped on older CLIs).
- **It never starts real work.** Code changes, PRs and merges are gated by the
  task's *Bot Ready* flag and executed by a separate agent loop (see the
  `taskshoot-agent-loop` skill in taskshoot-cli). When a mention asks for
  work, the reply asks the requester to assign the task to the bot and enable
  Bot Ready — or, if that is already the case, says the work will be picked up
  shortly.
- **Label mentions get no reply.** A mention that merely names the bot
  ("@bot can handle this") is detected by the agent and deliberately ignored.
- **Self-mentions never arrive**: the Taskshoot server does not notify the
  author of a comment about their own mentions.

## Requirements

- Node.js >= 20 (pnpm only for a source checkout)
- The [`taskshoot` CLI](https://github.com/cyberneura/taskshoot-cli) >= 0.7.0
  on PATH, authenticated as the bot user (a **write** API key; see
  `taskshoot config init`)
- Claude Code installed and authenticated on the host

## Installing

```bash
pnpm add -g --allow-build=taskshoot-socket-agent \
  github:cyberneura/taskshoot-socket-agent
taskshoot-socket-agent --version
```

The install compiles the TypeScript itself, so no checkout is needed.
`--version` doubles as the install check: it exits non-zero if the compile
step was skipped, which is the failure mode the flag below prevents. The
daemon itself takes no arguments and runs in the foreground until stopped;
`--help` lists the environment variables.

Two install caveats, both from the compile step:

- `--allow-build` is what lets that compile run. Current pnpm refuses build
  scripts in git-hosted packages unless the package is allowlisted (verified
  on 10.29; 10.17 still installed without the flag).
- `npm install -g <git url>` cannot work at all: npm omits devDependencies
  for global git installs, so there is no compiler to run. Use pnpm, or
  install from a source checkout.

## Running from a source checkout

```bash
pnpm install             # also builds (the prepare script runs tsc)
node dist/main.js        # or: pnpm run dev
```

`bin/start.sh` is the supervised entry point for a checkout: it sets up PATH,
reads an optional `.env`, installs/builds when needed and execs the daemon.
A global install uses neither — configure it through the supervisor's own
environment. Deployment templates (both variants):

- Ubuntu (supervisor): `deploy/supervisor/taskshoot-socket-agent.conf.example`
- macOS (launchd): `deploy/launchd/com.cyberneura.taskshoot-socket-agent.plist.example`

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `TSSA_NOTIFICATION_TYPES` | `task_mentioned` | Notification types to subscribe to (comma-separated) |
| `TSSA_POLL_MINUTES` | `30` | Polling backstop interval |
| `TSSA_AGENT_BACKEND` | `claude` | Which agent runs a mention: `claude` (Agent SDK, in-process) or `hermes` (Hermes CLI) |
| `TSSA_AGENT_TIMEOUT_MINUTES` | `20` | Hard timeout for one agent run |
| `TSSA_AGENT_CWD` | `~/workspace` | Working directory for the agent (backend `claude` only) |
| `TSSA_HERMES_BIN` | `hermes` | The Hermes CLI binary (backend `hermes`) |
| `TSSA_HERMES_WORKDIR` | `<state dir>/hermes-workspace` | Run directory for backend `hermes`; it owns the `AGENTS.md` there |
| `TSSA_STATE_DIR` | `~/.local/state/taskshoot-socket-agent` | Session ids + handled-notification ledger |
| `TSSA_TASKSHOOT_BIN` | `taskshoot` | The CLI binary |
| `TSSA_EXTRA_SYSTEM_PROMPT` | (empty) | Site policy appended to the agent's operating policy |
| `TSSA_EXTRA_PATH` | (empty) | Prepended to PATH by `bin/start.sh` |

## Design notes

- **The WebSocket is not a source of truth.** The server pushes with no ACK
  and no replay, and the reconnect catch-up is capped. The polling backstop
  (`TSSA_POLL_MINUTES`) re-reads unread notifications; both paths converge on
  a persistent handled-id ledger, which is what actually prevents double
  replies (replying is not idempotent).
- **Mentions are processed strictly one at a time.** Parallel agent runs on
  one host would race on repositories and the session store.
- **A later mention in the same task resumes the same SDK session**, so the
  thread keeps its conversational context.
- **Failures are retried, completions are not.** A crashed or error-ending
  agent run (`error_max_turns` and friends included) leaves the notification
  unhandled for the backstop to retry; a completed run (including a
  deliberate no-reply) marks it handled and read.
- **Delivery is at-least-once at the edges.** If the process dies between the
  agent posting its comment and the ledger being saved, the mention is
  retried; the system prompt tells the agent to read the thread and never
  repeat a reply it already posted, which is mitigation, not a guarantee.

## Security model — read before deploying

The daemon runs the agent unattended with `bypassPermissions`, because there
is no human at the prompt to approve tools. There is deliberately no blanket
PreToolUse allow hook: a hook's "allow" skips the normal permission
evaluation — deny rules included — whereas `bypassPermissions` on its own
still honors them.
**Bypassing permissions does not protect against prompt injection**: anyone
who can write into a task thread the bot reads can try to steer the agent.
The system-prompt policy ("no real work, no secrets") is guidance the model
follows, not enforcement. The enforcement layers are:

- the host's Claude settings deny lists (`user`, `project` and `local`
  settings are all loaded), and
- host isolation: run this only on a machine dedicated to the bot, holding
  nothing you would not let the bot's mention audience reach.

This is the same trade-off as running any autonomous coding agent on the
host; if that is not acceptable, do not deploy this daemon.

## License

MIT OR Apache-2.0
