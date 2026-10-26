---
name: taskshoot-socket-agent
description: Deploy, configure and troubleshoot taskshoot-socket-agent, the daemon that answers Taskshoot mentions with an AI agent and, by default (TSSA_POLICY=work), also does the requested code changes, commits and pull requests on tasks no agent loop is on. Use when installing or running the daemon, choosing an agent backend, setting TSSA_* environment variables, diagnosing why it will not start or why a mention got no reply or a duplicate reply, or when the user mentions taskshoot-socket-agent or a Taskshoot mention bot.
---

# taskshoot-socket-agent

A daemon that answers [Taskshoot](https://taskshoot.com) mentions in near real
time. It subscribes to the notification WebSocket through `taskshoot listen`
and runs one agent per mention; **the agent posts its own reply** with
`taskshoot task comment` — the agent's final text output is a log line, not the
reply.

Full documentation: https://github.com/cyberneura/taskshoot-socket-agent

## What the agent may do

The policy is chosen with `TSSA_POLICY`; this skill describes the default,
`work`. (For conversation only, set `TSSA_POLICY=safe` and use the
`taskshoot-socket-agent-safe` skill instead.)

The agent always answers questions, reads code and logs on its host, and
replies in the thread. When a mention asks for work, it may also change files
in a repository, commit on a new branch, push it and open a pull request —
**only when all of these hold**, checked by the agent itself from
`taskshoot task show --json` and `taskshoot task activity --json`:

- The task's *Bot Ready* flag is **off**. Bot Ready hands a task to a separate
  agent loop, and agent loops only pick up Bot Ready tasks — so this is what
  keeps the daemon and a loop from working the same task. With Bot Ready on,
  the agent replies and leaves the work to the loop.
- No other agent is on it: the task is unassigned, assigned to the bot, or
  assigned to the person who asked; nobody else shows as active on the thread;
  the thread shows no unfinished claim or open pull request by someone else.
- The work fits in one run (`TSSA_AGENT_TIMEOUT_MINUTES`, 20 by default).
  Larger work is declined with a pointer to Bot Ready.

It claims an unassigned task with `taskshoot task claim --if-unassigned`
before starting, commits on a `mention/` branch (never the default branch),
re-checks Bot Ready before every commit and push, and merges or deploys only
when the requester explicitly asked. It leaves the assignee and stage as
they are at the end. Its one reply reports what changed and where.

What this means for a deployment:

- **The agent needs write access to the repositories it is asked about**: a
  checkout it can find, git push credentials and an authenticated `gh` (or
  equivalent) for pull requests, all for the daemon's user. On `claude` the
  agent starts in `TSSA_AGENT_CWD`, so checkouts under it are found; `hermes`
  and `codex` start in a directory the daemon owns, so tell the agent where
  the checkouts are through `TSSA_EXTRA_SYSTEM_PROMPT`. Without these the
  conditions can hold and the work still fails.
- **Bot Ready off is the only check that separates it from an agent loop.**
  The assignee and activity checks see users, and a loop that runs as the
  same bot user as the daemon looks exactly like the daemon itself. If Bot
  Ready is turned on while a run is working, a loop can start on the same
  task before the agent's next check; the agent stops at its next commit or
  push. Do not switch Bot Ready on a task while the bot is working it here.
- **A task assigned to the requester is not claimed**, so nothing durable
  marks it as taken — only the transient activity indicator.
- Branches it creates start with `mention/`; merging or deploying happens only
  on an explicit request, and any mentioner counts as a requester. Add "never
  merge" to `TSSA_EXTRA_SYSTEM_PROMPT` if merges should stay with people.
- **One run blocks the queue.** Mentions are answered one at a time, so a
  20-minute piece of work delays every other reply by up to 20 minutes.
  Raising `TSSA_AGENT_TIMEOUT_MINUTES` for bigger work lengthens that delay.
- **A run cut off by the timeout leaves its claim and a partial branch
  behind**, and the backstop retries the mention in the same session. The
  agent is told to commit and push what it has and report instead of carrying
  on when it finds its own earlier unreported attempt — even when the earlier
  run died early for another reason, so a re-mention is what restarts it — otherwise work that never fits would be
  retried every `TSSA_POLL_MINUTES` without end. That is an instruction, not a
  retry limit; the daemon has none.
- **The conditions are the model's judgement, not enforcement.** Nothing in
  the daemon checks Bot Ready or the assignee before the agent writes.
- On the `codex` backend with the default `workspace-write` sandbox the agent
  cannot write outside its run directory, so it is given the `safe` policy
  instead (startup logs `policy: safe (...)`). Real work there needs
  `TSSA_CODEX_SANDBOX=danger-full-access`.

Two more behaviours that look like bugs and are not:

- **A mention that merely names the bot gets no reply.** A description listing
  "@bot can handle this" is a label, not a request. The agent decides this and
  ends its run without commenting.
- **Self-mentions never arrive.** The Taskshoot server does not notify the
  author of a comment about mentions inside it, so the bot quoting its own
  handle cannot loop.

## Requirements

- Node.js >= 20.6.
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
  - `codex` runs the Codex CLI (`codex exec`) as a child process; the binary
    has to be on PATH (or named through `TSSA_CODEX_BIN`) and logged in
    (`codex login status`).

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
checkout — it sets up PATH, reads an optional `.env`, installs and builds on
every start and execs the daemon. A global install uses none of that; configure it
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
| `TSSA_POLICY` | `work` | `work`: code changes, commits and PRs on tasks with Bot Ready off that no other agent is on. `safe`: conversation and investigation only |
| `TSSA_AGENT_BACKEND` | `claude` | `claude` (Agent SDK, in-process), `hermes` (Hermes CLI) or `codex` (Codex CLI) |
| `TSSA_AGENT_TIMEOUT_MINUTES` | `20` | Hard timeout for one agent run |
| `TSSA_AGENT_CWD` | `~/workspace` | Working directory for the agent (backend `claude` only) |
| `TSSA_HERMES_BIN` | `hermes` | The Hermes CLI binary (backend `hermes`) |
| `TSSA_HERMES_WORKDIR` | `<state dir>/hermes-workspace` | Run directory for backend `hermes`; the backend owns the `AGENTS.md` there |
| `TSSA_CODEX_BIN` | `codex` | The Codex CLI binary (backend `codex`) |
| `TSSA_CODEX_WORKDIR` | `<state dir>/codex-workspace` | Run directory for backend `codex`; the backend owns the `AGENTS.md` there. Not inside `/tmp` or `$TMPDIR` with `workspace-write` (startup error) |
| `TSSA_CODEX_SANDBOX` | `workspace-write` | `workspace-write` (writes limited to the run directory, `/tmp` and `$TMPDIR`; network left open for the `taskshoot` CLI) or `danger-full-access` |
| `TSSA_CODEX_MODEL` | (codex config) | Model for backend `codex`; empty leaves it to `~/.codex/config.toml` |
| `TSSA_STATE_DIR` | `~/.local/state/taskshoot-socket-agent` | Session ids + handled-notification ledger + the pid lock |
| `TSSA_TASKSHOOT_BIN` | `taskshoot` | The CLI binary |
| `TSSA_EXTRA_SYSTEM_PROMPT` | (empty) | Site policy appended to the agent's operating policy |
| `TSSA_SENTRY_DSN` | (empty) | Sentry DSN. Empty disables error reporting entirely; never commit one |
| `TSSA_SENTRY_ENVIRONMENT` | (SDK default) | Sentry `environment`, for grouping deployments (the host is already in `server_name`) |
| `TSSA_EXTRA_PATH` | (empty) | Prepended to PATH — read by `bin/start.sh`, not by the daemon |

Notes that are easy to get wrong:

- The state directory default is `~/.local/state/taskshoot-socket-agent` **on
  every platform, macOS included**: it is built from the home directory, not
  from the platform's own convention. Set `TSSA_STATE_DIR` if you want it
  elsewhere.
- The numeric variables must be positive integers and `TSSA_AGENT_BACKEND` must
  be one of the three names; anything else throws at startup rather than falling
  back to the default.
- `TSSA_EXTRA_SYSTEM_PROMPT` is appended after the policy, so it has the last
  word: use it to narrow the policy for one host (which repositories may be
  touched, "never merge") rather than to widen it. Multi-line text is fine;
  quote it in a `.env` read by `bin/start.sh`.
- `TSSA_AGENT_CWD` with `TSSA_AGENT_BACKEND=hermes` or `codex` is a startup
  error, not a no-op: those backends run in a directory they own, so the
  variable would otherwise be silently ignored. Use `TSSA_HERMES_WORKDIR` /
  `TSSA_CODEX_WORKDIR`.

## Why it will not start

The daemon is meant to fail loudly rather than run half-configured. Roughly in
the order they are reached:

1. **`taskshoot-socket-agent is installed but not built`** — the compile step
   was skipped at install (see above).
2. **A configuration error** — see the notes above. The configuration is
   validated as the module loads, so this comes before anything the daemon
   does, the lock included.
3. **`another taskshoot-socket-agent is running (pid N)`** — the pid file in
   the state directory is held by a live process. Two daemons sharing a state
   directory would both answer the same mention and race on the ledger. The
   lock is per state directory: two processes with **different**
   `TSSA_STATE_DIR` values do not exclude each other, even on one host, and if
   both authenticate as the same bot they will both answer. A pid file left
   behind by a crash is detected as stale and taken over.
4. **The `hermes` / `codex` binary is missing** (those backends only). Only
   they are checked: this daemon spawns those binaries itself, whereas Claude
   Code is located by the Agent SDK, and second-guessing it here could refuse
   to start a host that works. Without the check every mention would fail at
   spawn and stay unread while the backstop retried it.
   With `TSSA_CODEX_SANDBOX=workspace-write` (the default), the same step also
   refuses a `TSSA_CODEX_WORKDIR` inside `/tmp` or `$TMPDIR`: the sandbox lets
   the agent write there, so a run could swap the run directory for a link
   and the daemon's next, unsandboxed write of `AGENTS.md` would go through it.
   For the same reason it refuses a `TSSA_STATE_DIR` inside the run directory,
   `/tmp` or `$TMPDIR`: the agent could edit the handled-mention ledger.
5. **The identity check (`taskshoot --json me`) fails.** An authentication
   failure (401 / 403, no API key configured) or a missing `taskshoot` binary
   stops startup at once. A failure that can clear on its own — a 5xx, 408 or
   429 response, a connection / DNS / TLS error, or a call that takes longer
   than 30 seconds — is retried with exponential backoff (5 s, doubling, at
   most 60 s apart) for 15 minutes — no new attempt starts after that, though
   the one in flight may run up to its 30-second cap — with a `[startup] taskshoot me
   failed (attempt N): ...` line on stderr per retry. If it is still failing
   after that, the daemon exits with the last error and it is up to the
   supervisor to start it again.

`authenticated as <name> (<id>)` on stdout is the line that says startup got
past all of this. Reaching it can take about 15 minutes while the API is
unavailable, because the identity call retries.

**The first run on a fresh state directory answers almost nothing that was
already waiting.** Unread notifications older than one minute before that boot
are marked read and recorded as handled without running an agent, on the
grounds that a bulk reply to weeks-old mentions is noise and the people who
wrote them have moved on. The last minute is kept and answered, so a mention
sent while the daemon was being started is not lost. This is worth knowing twice over: it
also means **wiping or moving the state directory silently discards the
current backlog**, and that a mention created during startup is still answered
(the listener runs before the seeding, and seeding skips what is already
queued).

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
  run — including a deliberate no-reply — records it in the ledger and marks it
  read. Marking read is best effort: if that call fails it is logged and the
  run still counts as handled, so the notification stays unread in Taskshoot
  while the ledger keeps it from being answered again (until the ledger's own
  bound below applies).
- **Delivery is at-least-once at the edges.** If the process dies between the
  agent posting its comment and the ledger being written, the mention is
  retried. The ledger is also bounded — the 1000 most recent handled ids — so a
  notification that stayed unread (marking it read can fail) can come back
  through the polling path once 1000 newer ones have pushed its id out. Either
  way the agent is told to read the thread and never repeat a reply it already
  posted, which is mitigation, not a guarantee.

So: a mention with no reply is usually either a label mention (by design) or a
run that failed and is waiting for the backstop — normally up to
`TSSA_POLL_MINUTES` away, but not bounded to a single sweep: on a CLI without
`notifications list --before` the poll can only see the newest 100 unread
rows, so a failed mention below that line waits until the ones above it clear. A duplicated reply points at the ledger: the state directory being wiped,
moved between hosts, the process being killed between comment and save, or the
id having aged out of the bounded ledger.

## Security model — read before deploying

The daemon runs its agent unattended and approves every tool automatically,
because there is no human at the prompt. **That does not protect against prompt
injection**: anyone who can write into a task thread the bot reads can try to
steer the agent — and under the `work` policy that includes asking it, in
plain words, to change code and push. Whoever can mention the bot can get code
pushed from this host. The operating policy (its conditions for real work, "no
secrets") is guidance the model follows, not enforcement.

What enforcement exists depends on the backend:

| | `claude` | `hermes` | `codex` |
|---|---|---|---|
| How tools are approved | `bypassPermissions` | `--yolo` | `codex exec` never asks |
| Deny lists | the host's Claude settings still apply | **none — Hermes has no equivalent** | none |
| Sandbox | none | none | writes confined to the run directory, `/tmp` and `$TMPDIR` by default; **reads and the network are not restricted** |
| Policy delivery | system prompt | `AGENTS.md` in the run directory | `AGENTS.md` in the run directory |
| Remaining enforcement | deny lists + host isolation | **host isolation only** | write sandbox for shell commands (not for the host's MCP servers / plugins) + host isolation |

On the `claude` backend, do not add a blanket PreToolUse "allow" hook: a hook
that allows skips the normal permission evaluation, deny rules included,
whereas `bypassPermissions` on its own still honours them.

Either way, run this only on a machine dedicated to the bot, holding nothing
you would not let the bot's mention audience reach.
