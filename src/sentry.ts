/**
 * Optional Sentry reporting.
 *
 * This daemon is deliberately hard to kill: `handle()` and `poll()` swallow
 * their errors so the polling backstop can retry, and only a startup failure
 * reaches `main().catch`. That is the right behaviour for keeping mentions
 * answered, but it also means a host can fail the same way for days with
 * nothing but a line in a log file nobody reads.
 *
 * Reporting is entirely opt-in: with no DSN every function here is a no-op, so
 * nothing changes for anyone who does not configure it. The DSN is read from
 * the environment only — **never commit one to this repository**, which is
 * public.
 *
 * **Turning reporting on must not change how the daemon behaves.** The SDK's
 * defaults change it in four ways, and reporting itself adds a fifth (dying is
 * no longer instant). All five are pinned below.
 */
import { randomUUID } from "node:crypto";

import { config } from "./config.js";
import { closeIntake, isShuttingDown } from "./shutdown.js";

type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | undefined;

/**
 * How long to wait for events to leave before exiting on a fatal error.
 *
 * Every millisecond here is a millisecond the daemon keeps running after it
 * should have died, with the event loop live. Deliberately short.
 */
const FLUSH_TIMEOUT_MS = 500;

/**
 * Default integrations we take out.
 *
 * - `Console` turns every `console.*` call into a breadcrumb attached to later
 *   events. This daemon logs the agent's replies and task titles, so that
 *   would ship private task content to Sentry as a side effect of enabling
 *   error reporting. Failures are reported with their stack; the log stays on
 *   the host.
 * - `ChildProcess` attaches an `error` listener to **every** child process.
 *   `startListener` deliberately has none: a `taskshoot listen` that fails to
 *   spawn raises an unhandled `error` event, the daemon exits, and the
 *   supervisor restarts it. With the listener attached the throw disappears —
 *   and because a failed spawn emits no `exit`, the reconnect scheduler never
 *   runs either, so the WebSocket path would stay dead while the daemon looked
 *   healthy. (The spawn window is real: a deploy can replace the `taskshoot`
 *   binary while this is running.)
 * - `OnUnhandledRejection` and `OnUncaughtException` are replaced by our own
 *   listeners below, so that both fatal paths close the intake before they
 *   spend time reporting. Note that adding a listener *without* suppressing
 *   `OnUncaughtException` is worse than doing nothing: it only calls
 *   `logAndExitProcess` when `userProvidedListenersCount === 0`, so one extra
 *   listener stops it exiting at all.
 * - `LocalVariablesAsync` is inert unless `includeLocalVariables` is set, which
 *   we do not set. Dropped anyway so that turning that option on later cannot
 *   quietly start shipping the values of locals, which here hold credentials.
 * - `NodeSystemError` copies every own property of a system error into
 *   `contexts.node_system_error`. For a failed `spawn` that includes
 *   `spawnargs` — and the hermes backend passes the whole prompt, task content
 *   included, as an argument (measured: the prompt arrived verbatim). No fatal
 *   path spawns with a prompt today, but the first `handle()` report would.
 *   What the context adds (`code`, `syscall`, `errno`) is already in the
 *   message. One thing is lost with it: the integration also removed the
 *   failing `path` from the message, so a filesystem error now names its
 *   file (the state directory under the daemon's home, in practice).
 * - `Modules` copies the dependency map of the package.json in the working
 *   directory into every event. Here that is this repository's, which is
 *   public — but a daemon started from any other directory would ship that
 *   directory's, and a dependency spec can be a git URL with a credential in
 *   it. The versions that matter are in the checkout's lockfile anyway.
 * - `ProcessSession` starts a release-health session at init and, whenever a
 *   release is known, sends it as its own envelope alongside the first error,
 *   or at `beforeExit` if none happened. The SDK infers a release from CI-style
 *   environment variables (`CI_COMMIT_SHA`, `BUILDKITE_COMMIT`, ...), so on
 *   such a host the process would report more than the error. Reporting here
 *   is errors only.
 * - `ContextLines` reads source files named in stack frames to attach the
 *   lines around each frame — and it trusts the stack, which the SDK parses
 *   out of the error *text*. A message containing a line shaped like
 *   `at x (/etc/passwd:1:1)` gets that file read and shipped (measured with a
 *   planted file). Messages here quote child stderr and CLI output, so that
 *   text is not ours to trust. `maxValueLength` does not help: frames are
 *   parsed before the value is cut.
 */
const SUPPRESSED_INTEGRATIONS = new Set([
  "Console",
  "ChildProcess",
  "OnUnhandledRejection",
  "OnUncaughtException",
  "LocalVariablesAsync",
  "NodeSystemError",
  "Modules",
  "ProcessSession",
  "ContextLines",
]);

/**
 * Load and initialise Sentry when a DSN is configured.
 *
 * The DSN and environment are parameters rather than reads of `config` so this
 * can be exercised directly; `config` supplies the defaults.
 *
 * The import is dynamic so that a deployment without a DSN never pays for
 * loading the SDK, and so that a failure to load it at runtime cannot stop the
 * daemon — reporting is a convenience, and a daemon that refuses to answer
 * mentions because its error reporter failed is strictly worse than one that
 * answers them unreported. (This does not extend to build time: `tsc` needs
 * the package to be installed, see `bin/start.sh`.)
 */
export async function initSentry(
  dsn: string = config.sentryDsn,
  environment: string = config.sentryEnvironment,
): Promise<void> {
  if (!dsn) return;
  try {
    const sdk = await import("@sentry/node");
    sdk.init({
      dsn,
      // Empty means "let the SDK decide" (`production`, unless the process has
      // `SENTRY_ENVIRONMENT` set — the SDK reads that one itself). The host is
      // already identifiable from `server_name`, which the SDK fills in from
      // the hostname, so defaulting `environment` to the hostname would add no
      // information while creating one Sentry environment per host — and per
      // pod, on Kubernetes, where the name changes every restart.
      environment: environment || undefined,

      // `init` registers an `import-in-the-middle` ESM loader hook unless told
      // not to, which puts every later dynamic import through a hook chain and
      // adds a worker thread to a long-lived process. The Agent SDK does
      // `await import(...)` at runtime, so this is squarely in the daemon's
      // path. Nothing here needs it: the auto-instrumentation it exists to
      // serve is all in the integrations we do not load.
      registerEsmLoaderHooks: false,

      // Exception text is sent in full unless told otherwise — the Node SDK
      // has no default here, only the browser one does. An error that quotes
      // its input (`JSON.parse` on a non-JSON reply, `execFile` appending a
      // child's stderr) would otherwise ship all of it. 250 matches the
      // browser default and keeps the first line, which is the useful part.
      maxValueLength: 250,

      // With this unset, `SENTRY_SPOTLIGHT` in the environment makes `init`
      // add a `Spotlight` integration *after* the filter below has run and
      // send every event to a second, local HTTP destination as well. The DSN
      // is the only destination this daemon is configured with.
      spotlight: false,

      // `null`, not `0` and not omitted. `hasSpansEnabled()` tests `!= null`,
      // so `0` counts as enabled and adds 27 auto-performance integrations
      // (17 default becomes 44, measured), each of which patches some module
      // on load. None of them reaches the agent today — `Anthropic_AI`, say,
      // targets `@anthropic-ai/sdk`, which the Agent SDK bundles rather than
      // imports, and the model calls happen in the `claude` child process
      // anyway — but "27 patches that happen to miss" is not a state to
      // depend on. Omitting it is not safe either: the SDK then reads
      // `SENTRY_TRACES_SAMPLE_RATE` from the environment, and a host with that
      // set would start sending transactions for any span created here.
      // `null` is returned as-is (the env fallback is `=== undefined`) and
      // fails the `!= null` test, so tracing is off whatever the host sets
      // (measured: option `null`, no transaction from a manual span, 8
      // integrations). The type says `number | undefined`, hence the cast.
      // (`Http` and `NodeFetch` are ordinary defaults and stay either way.
      // They are not inert: both add `sentry-trace` and `baggage` headers to
      // outgoing requests — `http` and `fetch` respectively — even with
      // tracing off. This daemon makes no in-process HTTP calls, so today
      // that has no effect.)
      tracesSampleRate: null as unknown as undefined,

      integrations: (defaults) =>
        defaults.filter((i) => !SUPPRESSED_INTEGRATIONS.has(i.name)),

      // A plain object captured as an exception (a rejection with `{...}`
      // rather than an `Error`) is serialised whole into `extra.__serialized__`
      // — every property value, verbatim (measured). Its `message` and `name`
      // become the exception text regardless, as an Error's would, and an
      // `Error` found in any of its properties is adopted as the exception
      // outright (`getErrorPropertyFromObject`); it is the remaining values
      // that could hold a credential or task text.
      beforeSend: (event) => {
        if (event.extra) delete event.extra.__serialized__;
        return event;
      },
    });
    // `init` registers a global OpenTelemetry propagator, and that is not
    // inert here: the Agent SDK calls `propagation.inject()` when it spawns
    // `claude` and copies the result into the child's environment — with the
    // propagator in place that is `SENTRY-TRACE` and `BAGGAGE`, the latter
    // carrying the DSN's public key (measured). Disabling propagation puts
    // the no-op propagator back; events, tags, levels and the integration
    // set are unchanged, and `Http`/`NodeFetch` add their outgoing headers
    // through their own path — as does incoming trace continuation, which
    // `@sentry/core` builds from the request headers itself — so both are
    // unaffected (measured). What the propagator did carry was the remote
    // span parent into the OpenTelemetry context, which nothing uses with
    // spans off. Not done via `skipOpenTelemetrySetup`: without the
    // context manager the SDK records a dropped-span outcome for every
    // transport request — the client report that flushes outcomes included —
    // so each `beforeExit` flush produces the next outcome and the process
    // cycles forever, whether or not Sentry accepts the reports (measured
    // with a local server answering 200: a process that would exit on its
    // own no longer does).
    const otel = await import("@opentelemetry/api");
    otel.propagation.disable();
    // With `SENTRY_USE_ENVIRONMENT` set on the host, `init` copies
    // `SENTRY_TRACE` and `SENTRY_BAGGAGE` from the environment into the
    // scope every later capture forks from, and from there every `sentry-*`
    // baggage entry lands in every envelope's `trace` header (measured —
    // from the fatal handlers too). Unset, the gate is closed and nothing is
    // read; but that is one host variable away, so the context is replaced
    // with a fresh one here rather than trusted.
    sdk.getCurrentScope().setPropagationContext({
      traceId: randomUUID().replace(/-/g, ""),
      sampleRand: Math.random(),
    });
    sentry = sdk;
    installFatalHandlers();
  } catch (error) {
    sentry = undefined;
    console.error("sentry: initialisation failed; continuing without it:", error);
  }
}

/**
 * Report an error, tagged with where it came from.
 *
 * `where` is added to the fingerprint alongside Sentry's own grouping, so the
 * same error raised from different places stays separate. Different errors
 * from the same place still group separately — this narrows grouping, it does
 * not collapse a call site into one issue.
 *
 * `extra` is sent as-is, as a context on the event. Nothing scrubs it: do not
 * pass a prompt, a notification body or anything holding a credential.
 *
 * `fatal` marks the event the way the SDK's own crash handlers would have:
 * level `fatal` and `mechanism.handled: false`. Without it Sentry files the
 * event as a handled error, which is what `captureException` means by
 * default — wrong for a report whose next line is `process.exit`.
 */
export function captureError(
  where: string,
  error: unknown,
  extra?: Record<string, unknown>,
  { fatal = false } = {},
): void {
  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      scope.setTag("where", where);
      scope.setFingerprint(["{{ default }}", where]);
      if (extra) scope.setContext("details", extra);
      if (fatal) scope.setLevel("fatal");
      sentry?.captureException(error, {
        mechanism: { handled: !fatal, type: where },
      });
    });
  } catch (sendError) {
    // Never let reporting break the caller. Today every caller is about to
    // exit anyway, but a throw here would replace the real error in the log
    // with a reporting error.
    console.error("sentry: capture failed:", sendError);
  }
}

/**
 * Flush buffered events before the process exits.
 *
 * `captureException` is asynchronous. Without this the fatal path — the one
 * failure that is always worth knowing about — would exit before its event
 * left the process.
 */
export async function flushSentry(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  if (!sentry) return;
  // `Client.flush(t)` is not bounded by `t`: it waits up to `t` for event
  // processing and then up to `t` again for the transport, so it can take
  // twice what it was given. The callers exit when this returns, so the bound
  // is enforced here rather than trusted.
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      sentry.flush(timeoutMs),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (error) {
    console.error("sentry: flush failed:", error);
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Report unhandled rejections and then exit, as Node would have.
 *
 * The SDK's own `onUnhandledRejection` integration cannot be used for this.
 * Its `mode: "warn"` default only logs, and `strict` still skips a
 * non-removable ignore list (`AbortError`, `AI_NoOutputGeneratedError`) — the
 * listener is registered either way, which suppresses Node's own "die on an
 * unhandled rejection", so those two would survive where they used to be
 * fatal. `AbortError` is what an abort produces, and shutdown aborts the Agent
 * SDK's controllers in `backends/claude.ts`. The daemon's own abort path is
 * caught in `handle()`; the exposure is a promise the Agent SDK leaves floating
 * when its controller is aborted, which would reject under that name.
 *
 * Caveat worth knowing: a host that starts Node with
 * `--unhandled-rejections=warn` chooses *not* to die, and this handler
 * overrides that choice. Nothing here starts Node that way.
 */
let exitingFatally = false;

/** Report, then exit as the process would have without reporting. */
function reportFatalAndExit(where: string, error: unknown): void {
  // Only the first one exits. A burst would otherwise start a flush each,
  // racing the others' `process.exit`, and the later reports would be cut off
  // mid-send anyway. (Not observable from outside — the first exit wins either
  // way — so the tests do not cover this directly.)
  if (exitingFatally) return;
  exitingFatally = true;
  // Read before closing the intake, which sets the same flag.
  const shutdownAlreadyRunning = isShuttingDown();
  // Before the flush: the process stays alive while it runs, and nothing new
  // may start in a process that is going down.
  closeIntake();
  captureError(where, error, undefined, { fatal: true });
  if (shutdownAlreadyRunning) {
    // A signal-driven shutdown is in progress: `shutdown.ts` has sent its
    // `stop` phase and will run `force` (which SIGKILLs hermes groups that
    // ignored `stop`) and exit 130/143 when its grace period ends. Exiting
    // here first would cancel that timer and leave those groups running —
    // the one thing the signal path exists to prevent. So report, flush, and
    // let the shutdown own the exit; the grace period is longer than the
    // flush, so the report still gets out.
    void flushSentry();
    return;
  }
  // A signal arriving *after* this point is ignored by `shutdown.ts` — the
  // intake is already closed — and the exit below still happens.
  void flushSentry().finally(() => process.exit(1));
}

function installFatalHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled rejection:", reason);
    reportFatalAndExit("unhandledRejection", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("uncaught exception:", error);
    reportFatalAndExit("uncaughtException", error);
  });
}
