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

- Node.js >= 20.6 (the Sentry dependency tree pulls in OpenTelemetry packages that require it; pnpm only for a source checkout)
- The [`taskshoot` CLI](https://github.com/cyberneura/taskshoot-cli) >= 0.7.0
  on PATH, authenticated as the bot user (a **write** API key; see
  `taskshoot config init`)
- The agent for the backend you select (`TSSA_AGENT_BACKEND`), on PATH and
  authenticated:
  - `claude` (default) — Claude Code
  - `hermes` — the Hermes CLI

  The daemon checks the `hermes` binary at startup and refuses to start when it
  is missing, because otherwise every mention would fail at spawn and stay
  unread while the backstop retries it.

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
reads an optional `.env`, installs and builds on every start, and execs the daemon.
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
| `TSSA_SENTRY_DSN` | (empty) | Sentry DSN. Empty disables error reporting entirely |
| `TSSA_SENTRY_ENVIRONMENT` | (SDK default) | Sentry `environment`. The host is already identifiable from `server_name`, so this is for grouping deployments, not hosts |
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

## Error reporting (optional)

Set `TSSA_SENTRY_DSN` to report failures to Sentry. With no DSN nothing is
loaded and every reporting call is a no-op, so this changes nothing for
deployments that do not want it.

**Pass the DSN through the environment.** This repository is public; a DSN must
never be committed to it. Use whatever the host already has for secrets — a
Kubernetes Secret, a `.env` read by `bin/start.sh`, and so on.

### What is reported

- A failure that reaches `main().catch` and stops the daemon. Events are
  flushed before the process exits, since `captureException` is asynchronous.
- Uncaught exceptions, via a replacement handler of ours — see below.
- Unhandled rejections, via a replacement handler of ours — the SDK's cannot be
  used here, see below.

All three are filed the way the SDK's own crash handlers would file them:
level `fatal`, `handled: false`. Sentry filters on both, and a report whose next
line is `process.exit` is not a handled error. (For an error with a `cause`
chain the SDK puts that flag on the innermost cause rather than on the error
itself; nothing on the fatal paths today uses `cause`.)

### What a report contains

The error's own text, cut at 250 characters (`maxValueLength`, set
explicitly — the Node SDK sends it whole by default): its message, the
messages of its `cause` chain, and for a rejection that is not an `Error`, the
string, or for an object its `message`/`name`, or failing those its list of
keys — and an `Error` sitting in any property of that object is adopted as the
exception outright. The cut applies to the message only: the error's `name`
goes whole, and the SDK parses stack frames out of the *entire* text, so a
line shaped like `at f (/p:1:1)` anywhere in a message — past the cut
included — arrives as a frame with that function name and path (measured).
That is what reporting an error *is*, and it is also the
limit of what can be promised: an error that quotes its input puts the start
of that input in Sentry (`JSON.parse` does when the input does not begin as
JSON; a failed `execFile` appends the child's stderr). The errors that reach
the fatal paths today — the state file, the lock, `whoami`, hermes preflight,
and the first-run backlog seeding (`listUnreadNotifications`, `markReadIds`)
— carry no task text or credential in their messages, and the `taskshoot` CLI
does not print its key. The ones that come closest are `whoami` and the
seeding, which both parse the CLI's JSON: if the CLI answered with something
else, the first 250 characters of the message would quote the start of it.
Each report also carries the stack, with the absolute path of the checkout
(which includes the login name of the account the daemon runs as), plus the
SDK's runtime, OS, app, device and culture contexts (Node version, platform,
process start time, CPU and memory figures, boot time, locale, timezone) and,
where a cloud provider's environment variables exist, the provider's name and
what those variables carry (region on most; platform too on AWS; region,
account id and availability zone on Tencent Cloud). `server_name` is the
hostname, or `SENTRY_NAME` if the host sets that.

Reports do **not** carry anything the error did not itself say. The SDK paths
that would copy such data in are closed:

- `Console`, which turns every `console.*` call into a breadcrumb, is
  disabled. This daemon logs task titles and the agent's replies, and enabling
  error reporting should not quietly ship private task content to a third
  party.
- `LocalVariablesAsync` is disabled. It is inert unless `includeLocalVariables`
  is set, and dropping it means turning that option on later cannot start
  shipping the values of locals, which here hold credentials.
- `NodeSystemError`, which copies a system error's own properties into a
  context — for a failed `spawn`, its arguments, and the hermes backend passes
  the prompt as one — is disabled. It also used to strip the failing path from
  the message; without it a filesystem error names its file (in practice the
  state directory under the daemon's home).
- A plain object captured as an exception is serialised whole into
  `extra.__serialized__`; `beforeSend` strips that. Its `message` and `name`
  still become the exception text, like any error's.
- `Modules`, which copies the dependency map of the working directory's
  package.json into every event, is disabled. Here that would be this
  repository's, but a dependency spec can be a git URL carrying a credential,
  and the versions are in the lockfile anyway.
- `ProcessSession` is disabled. Once a release is known — and the SDK infers
  one from CI-style environment variables — it sends a release-health session
  as its own envelope with the first error, or at `beforeExit` if none
  happened. On such a host the process would report more than the error.
- `ContextLines` is disabled. It attaches the source lines around each stack
  frame by reading the file the frame names, and the SDK parses frames out of
  the error *text* — so a message containing a line shaped like
  `at x (/etc/passwd:1:1)` gets that file read and shipped (measured). Error
  messages here quote CLI output and child stderr, which is not text to trust
  with a file read. The frame's path still appears; the file's content does
  not.
- `SENTRY_SPOTLIGHT` in the environment is ignored (`spotlight: false`).
  Otherwise `init` would add a `Spotlight` integration after the integration
  filter has run and post every event to a local sidecar as well. The DSN is
  the only destination.
- The global OpenTelemetry propagator that `init` registers is disabled
  again right after. The Agent SDK asks that propagator for headers when it
  spawns `claude` and copies them into the child's environment: `SENTRY-TRACE`
  and `BAGGAGE`, the latter carrying the DSN's public key (measured). With
  propagation disabled the child's environment is what it is without
  reporting; events, the integration set, the outgoing `Http`/`NodeFetch`
  headers and incoming trace continuation (which `@sentry/core` builds from
  the request headers itself) are all unchanged (measured). (Not done with
  `skipOpenTelemetrySetup`: without the context manager the SDK records a
  dropped-span outcome for every transport request — the client report that
  flushes outcomes included — so each `beforeExit` flush produces the next
  outcome and a process that would exit on its own cycles forever, whether or
  not Sentry accepts the reports; measured with a local server answering 200.)
- `SENTRY_TRACE` / `SENTRY_BAGGAGE` are not carried. With
  `SENTRY_USE_ENVIRONMENT` set on the host, `init` copies both into the scope
  every later capture forks from, and each `sentry-*` baggage entry then
  lands in every envelope's `trace` header — from the fatal handlers too
  (measured). Unset, nothing is read; the propagation context is replaced
  with a fresh one after `init` regardless, and a test runs with the variable
  set and checks that a planted entry never leaves.

The SDK reads a few other variables on its own, none of which adds a
destination or data from the error's surroundings: `https_proxy` /
`http_proxy` / `no_proxy` (the transport goes through the proxy; `http_proxy`
is the fallback even for an https DSN), `SENTRY_ENVIRONMENT` (the event's
`environment` when `TSSA_SENTRY_ENVIRONMENT` is empty), `SENTRY_NAME`
(replaces the hostname in `server_name`), `SENTRY_RELEASE` and CI commit
variables such as `CI_COMMIT_SHA` (become the event's `release`),
`SENTRY_DEBUG` (SDK logging on the console — mostly stdout), and `VERCEL`
(adds a `SIGTERM` listener that flushes for 200 ms — the
one process listener the SDK adds conditionally, on a platform this daemon
does not run on).

A test plants a value on the `spawn` and plain-object paths and checks that
only the `message` leaves.

### Enabling reporting does not change how the daemon behaves

Four SDK defaults would change it, and reporting itself adds a fifth
difference. All five are pinned in `src/sentry.ts`. Each was checked by running
the daemon's failure modes with and without a DSN, not only by reading the
code, and each has a test that fails if the pinning is removed. (`init` also
adds two `beforeExit` listeners. They are not counted: this process never
reaches `beforeExit` — the poll interval and the listener child keep the loop
busy, and every exit path calls `process.exit`.)

- **`onUncaughtException` reports and exits, but never closes the intake** —
  and it is the SDK's handler, so nothing of ours runs first. Replaced by our
  own, symmetric with the rejection handler below. Note the trap: adding a
  listener *without* suppressing the SDK's integration is worse than leaving it
  alone, because it only exits when no other listener is registered — one extra
  listener and the process stops dying at all (measured).
- **`onUnhandledRejection` does not restore Node's behaviour, in any mode.**
  Its default `warn` only logs; `strict` exits but still skips a
  non-removable ignore list (`AbortError`, `AI_NoOutputGeneratedError`). Either
  way the listener is registered, which suppresses Node's own "die on an
  unhandled rejection" — so with a DSN an unhandled `AbortError` would survive
  where it used to be fatal. (The daemon's own abort path — shutdown aborts the
  Agent SDK's controllers in `backends/claude.ts` — is caught in `handle()`;
  the exposure is a promise the Agent SDK leaves floating on abort.) The
  integration is dropped and replaced with a handler that reports, flushes,
  and exits.
- **`ChildProcess` attaches an `error` listener to every child process.**
  `startListener` deliberately has none: a `taskshoot listen` that fails to
  spawn should crash the daemon so the supervisor restarts it. With the
  listener attached the crash disappears — and a failed spawn emits no `exit`,
  so the reconnect scheduler never runs either. The WebSocket path would stay
  dead while the daemon looked healthy. Dropped.
- **`registerEsmLoaderHooks` defaults to on.** `init` registers an
  `import-in-the-middle` loader hook whether or not tracing is enabled, so
  every later dynamic import goes through a hook chain and the process gains a
  worker thread. The Agent SDK imports at runtime, so this is in the daemon's
  path. Set to `false`; the integration set is unchanged (measured).
- **Dying stops being instant.** Reporting a fatal error means flushing it,
  and the event loop keeps turning while that happens — long enough for
  `drain()` to start a run the dying process will never record. The flush is
  bounded to 500 ms in total (the SDK's own `flush` can take twice its
  argument, so the bound is enforced around it), and both fatal handlers close
  the intake (`closeIntake()`) before flushing, so nothing new starts during
  it. Measured: a fatal error with an unresponsive DSN host lets ~400 ms of
  timers run, against 0 with reporting off — with `isShuttingDown()` already
  true throughout.

One option is pinned to a value that looks odd. **`tracesSampleRate` is
`null` — not `0`, and not left out.** Sentry tests `!= null`, so `0` counts as
enabled and adds 27 auto-performance integrations (17 becomes 44, measured),
each patching some module when it loads. None of them reaches the agent today
(`Anthropic_AI`, for instance, targets `@anthropic-ai/sdk`, which the Agent
SDK bundles rather than imports, and the model calls happen in the `claude`
child process), but 27 patches that happen to miss is not a state to depend
on. Leaving the option out is not safe either: the SDK then reads
`SENTRY_TRACES_SAMPLE_RATE` from the environment, and a host with that set
would send a transaction for every span created here. `null` is passed
through as-is and fails the `!= null` test, so tracing stays off whatever the
host sets; a test starts a span under that variable and checks that nothing
leaves. (`Http` and
`NodeFetch` are ordinary defaults and stay either way. They are not inert:
both add `sentry-trace` and `baggage` headers to outgoing requests — `http`
and `fetch` respectively — and `Http` instruments incoming ones. This daemon
makes no in-process HTTP calls —
`taskshoot` and the agent are separate processes — so today that has no
effect, but it would if in-process HTTP were added.)

The daemon ends up with 8 of the 17 default integrations; the exact set is
asserted in the tests, so an SDK rename or addition fails there rather than
quietly changing what runs. This repository has no CI, so "fails there" means
at the next `pnpm test` — run it after bumping the SDK.

#### Three differences left in place, deliberately

Each is either bounded by the 500 ms reporting window or needs a host
configuration nothing here produces, and closing it would cost more than it
is worth.

- **A fatal error during a signal-driven shutdown races it for the exit
  code.** `shutdown.ts` exits with 130/143 after its grace period; a fatal
  error that lands inside that period reports for up to 500 ms and exits 1,
  and whichever timer fires first wins. (The other order is not a race: once a
  fatal report has closed the intake, a later signal is ignored and the exit
  still happens.) Every code involved is non-zero and the supervisor restarts
  either way, so unifying the two exit paths is not worth the coupling.
- **An in-flight run gets up to 500 ms longer.** The fatal path closes the
  intake but does not run the cleanup the signal path runs. What happens to a
  run already executing then depends on the backend. A hermes run is a
  detached process group that outlives the daemon either way. A Claude run is
  a child the Agent SDK kills with `SIGTERM` from its own `process.on("exit")`
  handler — immediately without reporting, and after the flush with it. So
  with a DSN the run continues for up to 500 ms more before the same signal
  arrives. Running the cleanup here would close that gap for Claude but would
  also kill hermes groups that survive without reporting, which is a bigger
  divergence than the one it fixes.
- **`--unhandled-rejections=warn` is overridden.** A host that starts Node that
  way has chosen not to die on a rejection; the replacement handler exits
  regardless. Detecting the mode means parsing `execArgv` and `NODE_OPTIONS`
  and guessing what Node would have done, which is more likely to be wrong than
  the thing it fixes. Nothing in this repository starts Node that way.

**Failures inside `handle()` and `poll()` are deliberately not reported yet.**
Both swallow their errors so the polling backstop can retry, and the backstop
retries the *same* notification until it succeeds or ages out — reporting each
attempt would turn one stuck task into a stream of identical events. Adding
them needs a suppression rule (report from the Nth attempt, say), and that
threshold should be chosen against real traffic rather than guessed.

**A bad environment variable is not reported either.** `config.ts` validates
`TSSA_*` values while it is being imported, which happens before `main()` runs
and therefore before reporting is initialised — so the likeliest startup
failure of all (a typo in a supervisor unit or `.env`) exits with a message on
stderr and nothing in Sentry.

So: **a quiet Sentry project does not mean the daemon is healthy.** It does not
even mean it has not died at startup — initialisation failures, capture
failures and a flush that times out are all swallowed rather than reported, on
the principle that reporting must never be what stops the daemon. The log files
remain the place to look.

### Grouping

`captureError(where, ...)` tags the event with `where` and adds it to the
fingerprint alongside Sentry's own grouping, so the same error raised from
different places stays separate. This narrows grouping; it does not collapse a
call site into a single issue.

## Security model — read before deploying

The daemon runs its agent unattended and approves every tool automatically,
because there is no human at the prompt. **That does not protect against
prompt injection**: anyone who can write into a task thread the bot reads can
try to steer the agent. The operating policy ("no real work, no secrets") is
guidance the model follows, not enforcement.

What enforcement exists depends on the backend:

| | `claude` | `hermes` |
|---|---|---|
| How tools are approved | `bypassPermissions` | `--yolo` |
| Deny lists | the host's Claude settings (`user`, `project` and `local` are all loaded) still apply | **none — Hermes has no equivalent** |
| Policy delivery | system prompt | `AGENTS.md` in the run directory |
| Remaining enforcement | deny lists + host isolation | **host isolation only** |

On the `claude` backend there is deliberately no blanket PreToolUse allow
hook: a hook's "allow" skips the normal permission evaluation — deny rules
included — whereas `bypassPermissions` on its own still honors them.

On the `hermes` backend there is no configuration-level restriction at all.
Anything the agent can reach from the shell, it can read and write. Choose it
only where host isolation alone is an acceptable boundary.

Either way: run this only on a machine dedicated to the bot, holding nothing
you would not let the bot's mention audience reach. This is the same trade-off
as running any autonomous agent on the host; if that is not acceptable, do not
deploy this daemon.

## Agent skill

The repository carries an agent skill (`skills/taskshoot-socket-agent/`) that
tells a coding agent how to deploy, configure and troubleshoot this daemon:

```bash
npx skills add cyberneura/taskshoot-socket-agent
```

It is agent-independent: one file, in the layout that agents supporting the
`skills/` convention read.

## License

MIT OR Apache-2.0
