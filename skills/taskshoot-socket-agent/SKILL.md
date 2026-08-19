---
name: taskshoot-socket-agent
description: Deploy, configure and troubleshoot taskshoot-socket-agent, the daemon that answers Taskshoot mentions with an AI agent. Use when installing or running the daemon, choosing an agent backend, setting TSSA_* environment variables, diagnosing why it will not start or why a mention got no reply or a duplicate reply, or when the user mentions taskshoot-socket-agent or a Taskshoot mention bot.
---

# taskshoot-socket-agent

A daemon that answers [Taskshoot](https://taskshoot.com) mentions in near real
time. It subscribes to the notification WebSocket through `taskshoot listen`
and runs one agent per mention; **the agent posts its own reply** with
`taskshoot task comment` — the agent's final text output is a log line, not the
reply.

Full documentation: https://github.com/cyberneura/taskshoot-socket-agent

## The line this daemon does not cross

**Conversation and investigation only. It never starts real work.** The agent
answers questions, reads code and logs on its host, and replies in the thread.
Code changes, pull requests and merges are gated by the task's *Bot Ready* flag
and executed by a **separate** agent loop. When a mention asks for work, the
reply asks the requester to assign the task to the bot and enable Bot Ready.

Knowing this line matters before you change anything here: widening what the
daemon does (giving it a repository to push from, letting it act on a request
directly) removes the separation the two systems are built around.

Two more behaviours that look like bugs and are not:

- **A mention that merely names the bot gets no reply.** A description listing
  "@bot can handle this" is a label, not a request. The agent decides this and
  ends its run without commenting.
- **Self-mentions never arrive.** The Taskshoot server does not notify the
  author of a comment about mentions inside it, so the bot quoting its own
  handle cannot loop.

## Requirements

- Node.js >= 20.
- The `taskshoot` CLI >= 0.7.0 on PATH, authenticated **as the bot user with a
  write API key**. The daemon never handles Taskshoot credentials itself: every
  call shells out to that CLI, which resolves its own credentials.
  The transient "Thinking about a reply…" indicator needs CLI >= 0.8.0. On an
  older CLI the daemon keeps working without it, but it says so on stderr
  (`[activity] ... unavailable ... disabled`) — that line is a notice, not a
  failure to chase.
- The agent for the backend you choose, already authenticated on this host:
  - `claude` (the default) runs the Claude Agent SDK **in this process**. The
    SDK locates Claude Code itself; the daemon never spawns a `claude` binary
    and does not check for one at startup.
  - `hermes` runs the Hermes CLI as a child process, so that binary does have
    to be on PATH (or named through `TSSA_HERMES_BIN`).

## Installing

```bash
pnpm add -g --allow-build=taskshoot-socket-agent \
  github:cyberneura/taskshoot-socket-agent
taskshoot-socket-agent --version
```

Two constraints, both because the install compiles the TypeScript itself:

- `--allow-build` is what lets that compile run. Current pnpm refuses build
  scripts in git-hosted packages unless the package is allowlisted (needed on
  pnpm 10.29; 10.17 installed without it).
- **`npm install -g <git url>` cannot work**: npm omits devDependencies for
  global git installs, so there is no compiler to run.

`--version` is the install check: it exits non-zero and tells you to reinstall
when `dist/` is missing, which is exactly what a skipped compile leaves behind.
It is safe to run against a host where the daemon is already up, because
`--version` and `--help` are answered by the wrapper without importing the
daemon — and importing it is what starts it (it takes the single-instance lock
and connects immediately). Every other invocation starts the daemon.

From a source checkout: `pnpm install` (its `prepare` script builds) then
`node dist/main.js`. `bin/start.sh` is the supervised entry point for a
checkout — it sets up PATH, reads an optional `.env`, installs/builds when
needed and execs the daemon. A global install uses none of that; configure it
through the supervisor's environment. The repository carries templates for
supervisor (Ubuntu) and launchd (macOS) under `deploy/`.

## Configuration

Environment variables only; the daemon takes no arguments and runs in the
foreground until stopped. `--help` lists the ones the daemon itself reads —
that is all of these except `TSSA_EXTRA_PATH`, which only `bin/start.sh`
consumes.

| Variable | Default | Meaning |
|---|---|---|
| `TSSA_NOTIFICATION_TYPES` | `task_mentioned` | Notification types to subscribe to (comma-separated) |
| `TSSA_POLL_MINUTES` | `30` | Polling backstop interval |
| `TSSA_AGENT_BACKEND` | `claude` | `claude` (Agent SDK, in-process) or `hermes` (Hermes CLI) |
| `TSSA_AGENT_TIMEOUT_MINUTES` | `20` | Hard timeout for one agent run |
| `TSSA_AGENT_CWD` | `~/workspace` | Working directory for the agent (backend `claude` only) |
| `TSSA_HERMES_BIN` | `hermes` | The Hermes CLI binary (backend `hermes`) |
| `TSSA_HERMES_WORKDIR` | `<state dir>/hermes-workspace` | Run directory for backend `hermes`; the backend owns the `AGENTS.md` there |
| `TSSA_STATE_DIR` | `~/.local/state/taskshoot-socket-agent` | Session ids + handled-notification ledger + the pid lock |
| `TSSA_TASKSHOOT_BIN` | `taskshoot` | The CLI binary |
| `TSSA_EXTRA_SYSTEM_PROMPT` | (empty) | Site policy appended to the agent's operating policy |
| `TSSA_EXTRA_PATH` | (empty) | Prepended to PATH — read by `bin/start.sh`, not by the daemon |

Notes that are easy to get wrong:

- The state directory default is `~/.local/state/taskshoot-socket-agent` **on
  every platform, macOS included**: it is built from the home directory, not
  from the platform's own convention. Set `TSSA_STATE_DIR` if you want it
  elsewhere.
- The numeric variables must be positive integers and `TSSA_AGENT_BACKEND` must
  be one of the two names; anything else throws at startup rather than falling
  back to the default.
- `TSSA_AGENT_CWD` with `TSSA_AGENT_BACKEND=hermes` is a startup error, not a
  no-op: the hermes backend runs in a directory it owns, so the variable would
  otherwise be silently ignored. Use `TSSA_HERMES_WORKDIR`.

## Why it will not start

The daemon is meant to fail loudly rather than run half-configured. In order:

1. **`taskshoot-socket-agent is installed but not built`** — the compile step
   was skipped at install (see above).
2. **`another taskshoot-socket-agent is running (pid N)`** — the pid file in
   the state directory is held by a live process. Two daemons sharing a state
   directory would both answer the same mention and race on the ledger. The
   lock is per state directory: two processes with **different**
   `TSSA_STATE_DIR` values do not exclude each other, even on one host, and if
   both authenticate as the same bot they will both answer. A pid file left
   behind by a crash is detected as stale and taken over.
3. **A configuration error** — see the notes above.
4. **The `hermes` binary is missing** (backend `hermes` only). Only that
   backend is checked: this daemon spawns that binary itself, whereas Claude
   Code is located by the Agent SDK, and second-guessing it here could refuse
   to start a host that works. Without the check every mention would fail at
   spawn and stay unread while the backstop retried it.

`authenticated as <name> (<id>)` on stdout is the line that says startup got
past all of this. Reaching it can take minutes on a slow or flaky connection,
because the identity call retries.

## How work flows, and what that means when something looks wrong

```
taskshoot listen (WebSocket, JSON Lines)
        │            plus a polling backstop (unread notifications)
        ▼
  serial queue ── handled-id ledger (no double replies)
        ▼
  agent run   ──────> taskshoot task comment <ref> "..."
```

- **The WebSocket is not a source of truth.** The server pushes with no ACK,
  and the catch-up the listener does on reconnect is capped, so neither adds up
  to a delivery guarantee. The polling backstop
  re-reads unread notifications; both paths converge on a persistent
  handled-id ledger, and that ledger — not the socket — is what prevents double
  replies. Replying is not idempotent.
- **Mentions are processed strictly one at a time.** Parallel runs on one host
  would race on repositories and on the session store. A burst of mentions is
  answered late rather than in parallel. Ordering holds within what is queued,
  not across a large backlog: one poll admits at most 100 mentions, so if more
  than that are waiting, a live mention arriving meanwhile can be answered
  before the ones left for the next sweep.
- **A later mention in the same task resumes the same session**, so the thread
  keeps its conversational context — until that session is evicted. The store
  keeps the 200 most recently used task sessions, so a mention in a task that
  has been quiet while 200 other tasks were active starts fresh and only knows
  what it reads back from the thread.
- **Failures are retried, completions are not.** A crashed or error-ending run
  leaves the notification unhandled for the backstop to pick up; a completed
  run — including a deliberate no-reply — marks it handled and read.
- **Delivery is at-least-once at the edges.** If the process dies between the
  agent posting its comment and the ledger being written, the mention is
  retried. The ledger is also bounded — the 1000 most recent handled ids — so a
  notification that stayed unread (marking it read can fail) can come back
  through the polling path once 1000 newer ones have pushed its id out. Either
  way the agent is told to read the thread and never repeat a reply it already
  posted, which is mitigation, not a guarantee.

So: a mention with no reply is usually either a label mention (by design) or a
run that failed and is waiting for the backstop — up to `TSSA_POLL_MINUTES`
away. A duplicated reply points at the ledger: the state directory being wiped,
moved between hosts, the process being killed between comment and save, or the
id having aged out of the bounded ledger.

## Security model — read before deploying

The daemon runs its agent unattended and approves every tool automatically,
because there is no human at the prompt. **That does not protect against prompt
injection**: anyone who can write into a task thread the bot reads can try to
steer the agent. The operating policy ("no real work, no secrets") is guidance
the model follows, not enforcement.

What enforcement exists depends on the backend:

| | `claude` | `hermes` |
|---|---|---|
| How tools are approved | `bypassPermissions` | `--yolo` |
| Deny lists | the host's Claude settings still apply | **none — Hermes has no equivalent** |
| Policy delivery | system prompt | `AGENTS.md` in the run directory |
| Remaining enforcement | deny lists + host isolation | **host isolation only** |

On the `claude` backend, do not add a blanket PreToolUse "allow" hook: a hook
that allows skips the normal permission evaluation, deny rules included,
whereas `bypassPermissions` on its own still honours them.

Either way, run this only on a machine dedicated to the bot, holding nothing
you would not let the bot's mention audience reach.
