/**
 * Daemon shutdown state.
 *
 * Stopping is not just "kill what is running": a run that gets killed rejects,
 * which lets the serial queue move on and start the *next* mention. That new
 * run can post a reply in the seconds before the process exits — and the
 * ledger entry recording it is never written, because the daemon writing it is
 * gone. The supervisor restarts, finds the mention unread, and answers it
 * again.
 *
 * So shutdown has to close the intake as well as terminate the work: from the
 * first signal, no new run may start. Anything left unanswered stays unread,
 * which is the correct outcome — the next daemon picks it up exactly once.
 */

/** How long running work gets to stop before the process exits. */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * `stop` fires the moment a signal arrives; `force` fires once the grace has
 * elapsed, immediately before the process exits. Cleanup that can hang — a
 * process ignoring SIGTERM, say — needs the second phase, because nothing
 * scheduled by the first is guaranteed to run before exit.
 */
export type ShutdownPhase = "stop" | "force";

let shuttingDown = false;
const handlers: Array<(phase: ShutdownPhase) => void> = [];
let hooked = false;

function runHandlers(phase: ShutdownPhase): void {
  for (const cleanup of handlers) {
    try {
      cleanup(phase);
    } catch (error) {
      console.error(`shutdown handler failed (${phase}):`, error);
    }
  }
}

/** True once a stop signal arrived. Callers must not start new work. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Registers cleanup to run when the daemon is stopping (terminating child
 * process groups, etc.). Installs the signal handlers on first use.
 */
export function onShutdown(handler: (phase: ShutdownPhase) => void): void {
  handlers.push(handler);
  if (hooked) return;
  hooked = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received; stopping`);
      runHandlers("stop");
      // Supervisors escalate on their own schedule, so do not linger.
      setTimeout(() => {
        runHandlers("force");
        process.exit(signal === "SIGINT" ? 130 : 143);
      }, SHUTDOWN_GRACE_MS);
    });
  }
}
