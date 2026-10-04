/**
 * Runs an agent CLI as a child process: one process per mention.
 *
 * Shared by the backends that shell out (`hermes`, `codex`). What differs per
 * backend — argv, where the policy goes, how a session is named and how a
 * failure is classified — stays in the backend; what must not differ is here.
 *
 * The agent is a child process that starts children of its own (browser, shell),
 * so every ending has to account for the whole group. The rules, in one place
 * because fixing them one case at a time is how they got missed:
 *
 * | Ending | Settle | Group |
 * |---|---|---|
 * | spawn failed | reject, retryable | nothing exists |
 * | exit 0 | resolve | terminate — tools may still be running |
 * | exit non-zero / signal | reject | terminate |
 * | timeout | reject | terminate (SIGTERM, then SIGKILL after a grace) |
 * | daemon shutting down | — | terminate every live run, then exit |
 *
 * Two asymmetries are deliberate. `exit` (not `close`) settles the run,
 * because a descendant holding the inherited pipes keeps `close` from ever
 * firing — which would leave the daemon's serial queue stuck. And the SIGKILL
 * escalation is never cancelled: the run settling means the agent is gone, which
 * is exactly when a tool that ignored SIGTERM would be left behind for good.
 *
 */
import { spawn } from "node:child_process";

import { config } from "../config.js";
import { isShuttingDown, onShutdown } from "../shutdown.js";

export interface ChildOutput {
  stdout: string;
  stderr: string;
}

/** What a failed run carries, so the backend can classify it for the retry
 * path: whether the process ever started, and whatever it printed before it
 * ended. */
export interface ChildError extends Error, ChildOutput {
  spawned: boolean;
}

function childError(error: unknown, spawned: boolean, stdout: string, stderr: string): ChildError {
  const wrapped = (error instanceof Error ? error : new Error(String(error))) as ChildError;
  wrapped.spawned = spawned;
  wrapped.stdout = stdout;
  wrapped.stderr = stderr;
  return wrapped;
}

/** SIGTERM to SIGKILL grace for the run's process group. */
const KILL_GRACE_MS = 10_000;
/** How long the startup check waits for `<bin> --version`. */
const PREFLIGHT_TIMEOUT_MS = 30_000;
/** How often the escalation re-checks whether the group is still there. */
const GROUP_POLL_MS = 200;
/** How long to wait for `close` after `exit` before settling anyway. */
const CLOSE_FALLBACK_MS = 2_000;

/**
 * Signals the run's whole process group, not just the agent itself.
 *
 * The child is spawned detached, so it leads its own group and the negative
 * pid reaches its tool subprocesses too. Failures are ignored on purpose: the
 * group is already gone in the common case (the process exited between the
 * timeout firing and this call), and there is nothing to recover either way.
 */
/**
 * Signals the run's whole process group. Returns whether the group was still
 * there to receive it.
 *
 * Existence is probed with signal 0 first, because a group id is just a number
 * and the kernel reuses it: the escalation fires ten seconds after the run
 * ended, and by then that number can belong to somebody else's process group.
 * Same reason there is no fallback to the positive pid.
 */
function killTree(child: { pid?: number }, signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
  } catch {
    return false; // already gone — do not signal a recycled id
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Runs whose process group may still exist. Used to clean up on shutdown. */
const liveRuns = new Set<{ pid?: number }>();
let cleanupRegistered = false;

/**
 * Ends every running group when the daemon stops.
 *
 * `detached` puts each run outside the daemon's own process group, so neither
 * supervisor's `stopasgroup` nor launchd reaches it: without this a restart
 * would leave the old run free to post its reply — never recorded in the
 * ledger, because the daemon that would record it is gone — while the new
 * daemon retries the same mention and replies again.
 */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  onShutdown((phase) => {
    // SIGTERM first so a run can wind down, then SIGKILL from the force phase
    // — which runs immediately before the process exits. The per-run
    // escalation cannot cover this: it is armed only when a run finishes, and
    // its grace is longer than the daemon's, so a group that ignored SIGTERM
    // would outlive the daemon and post a late comment while the restarted
    // one retries the mention.
    for (const child of liveRuns) killTree(child, phase === "stop" ? "SIGTERM" : "SIGKILL");
  });
}

/**
 * Fails fast when the configured agent binary is not runnable.
 *
 * Without this the daemon starts perfectly, then every mention dies at spawn
 * and stays unread while the backstop retries it — the misconfiguration is
 * only visible in the logs of runs that already looked like failures.
 *
 * `backend` and `envVar` only shape the error text; `hint` says how to fix it.
 */
export async function preflightBinary(
  bin: string,
  backend: string,
  envVar: string,
  hint: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" });
    // Bounded: a wrapper that hangs here would otherwise stop the daemon
    // before authentication and the listener ever start — it would look alive
    // to the supervisor while answering nothing, which is harder to notice
    // than a crash loop.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `\`${bin} --version\` did not finish within ` +
            `${PREFLIGHT_TIMEOUT_MS / 1000}s. Check ${envVar}.`,
        ),
      );
    }, PREFLIGHT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `TSSA_AGENT_BACKEND=${backend} but \`${bin} --version\` could not run ` +
            `(${error.message}). ${hint} or set ${envVar}.`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`\`${bin} --version\` exited with ${code}`));
    });
  });
}

/**
 * Runs `bin args` in `cwd` until it ends or the hard timeout fires.
 *
 * `label` names the agent in error messages. Rejects with a `ChildError`;
 * a rejection with `spawned: false` means nothing ran at all.
 */
export async function runChild(
  bin: string,
  args: string[],
  cwd: string,
  label: string,
): Promise<ChildOutput> {
  registerCleanup();
  // Checked here, synchronously before the spawn, and not only by the caller:
  // a signal can arrive while the backend is preparing its run directory, and
  // spawning is what posts a reply the ledger never records.
  if (isShuttingDown()) throw childError(new Error("daemon is shutting down"), false, "", "");

  return await new Promise<ChildOutput>((resolve, reject) => {
    // detached: the run gets its own process group. The agent spawns tool
    // subprocesses (browser, shell), and killing only the parent would leave
    // them running unattended past the hard timeout — free to finish a browser
    // action or post a late comment while the backstop retries the mention.
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    liveRuns.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawned = false;
    let settled = false;
    let closeFallback: NodeJS.Timeout | undefined;

    /** `exit` + `close` + the fallback can all fire; only the first one wins. */
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };

    const timer = setTimeout(
      () => {
        timedOut = true;
        terminateGroup();
      },
      config.agentTimeoutMinutes * 60 * 1000,
    );

    /**
     * Ends the run's whole process group.
     *
     * Called for every abnormal end, not just the timeout: the agent exiting
     * non-zero says nothing about the tool subprocesses it started, and as the
     * group leader it takes none of them with it. A survivor is an unattended
     * process still free to act — and to post a late comment while the
     * backstop retries the mention.
     *
     * The SIGKILL escalation is deliberately NOT cancelled when the run
     * settles: settling means the agent is gone, which is exactly when a
     * subprocess that ignored SIGTERM would otherwise be left alive for good.
     * It is unref'd so it never keeps a process alive on its own, and it is a
     * no-op once the group is gone.
     */
    const terminateGroup = () => {
      if (!killTree(child, "SIGTERM")) {
        // Nothing left of the group: no escalation to schedule, and nothing
        // for the daemon's shutdown to find.
        liveRuns.delete(child);
        return;
      }
      if (!graceTimer) {
        // Watched rather than slept through. A pgid is only reassigned once
        // the group is empty, so a group observed alive continuously since our
        // SIGTERM is still ours — but a single check ten seconds later cannot
        // tell "still alive" from "died and the number was reused". Sampling
        // shrinks that blind spot to one interval, and observing the group
        // gone even once cancels the escalation for good.
        //
        // The residual race cannot be closed with pid/pgid APIs alone; the
        // alternative — never escalating — leaves a descendant that ignored
        // SIGTERM running unattended, which is worse.
        const startedAt = Date.now();
        graceTimer = setInterval(() => {
          const stillThere = killTree(child, 0);
          if (!stillThere) {
            clearInterval(graceTimer);
            // Only now is the group certainly gone. Until then it stays in
            // liveRuns so the daemon's shutdown can still find it.
            liveRuns.delete(child);
            return;
          }
          if (Date.now() - startedAt >= KILL_GRACE_MS) {
            clearInterval(graceTimer);
            killTree(child, "SIGKILL");
            liveRuns.delete(child);
          }
        }, GROUP_POLL_MS);
        graceTimer.unref();
      }
    };
    let graceTimer: NodeJS.Timeout;

    const clearTimers = () => {
      clearTimeout(timer);
      if (closeFallback) clearTimeout(closeFallback);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("spawn", () => {
      spawned = true;
    });

    child.on("error", (error) => {
      clearTimers();
      // Nothing was started when the spawn itself failed; otherwise the group
      // may exist and is cleaned up on the normal schedule.
      if (spawned) terminateGroup();
      else liveRuns.delete(child);
      settle(() => reject(childError(error, spawned, stdout, stderr)));
    });

    // `close` waits for the pipes, and a surviving grandchild can hold them
    // open after the agent itself is gone — which would leave this promise (and
    // the daemon's serial queue behind it) pending forever. `exit` is the
    // process actually ending, so it arms a short fallback that settles the
    // run with whatever output arrived.
    child.on("exit", (code, signal) => {
      closeFallback = setTimeout(() => finish(code, signal), CLOSE_FALLBACK_MS);
    });

    child.on("close", (code, signal) => finish(code, signal));

    function finish(code: number | null, signal: NodeJS.Signals | null) {
      clearTimers();
      // Unconditional, including a clean exit: the agent finishing says nothing
      // about the tools it started, and a background browser or shell that
      // inherited the pipes would otherwise keep acting unattended after the
      // mention is marked handled.
      terminateGroup();
      if (timedOut) {
        settle(() =>
          reject(
            childError(
              new Error(
                `${label} run exceeded ${config.agentTimeoutMinutes} minutes and was killed`,
              ),
              spawned,
              stdout,
              stderr,
            ),
          ),
        );
        return;
      }
      if (code !== 0 || signal) {
        settle(() =>
          reject(
            childError(
              new Error(
                `${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}: ` +
                  `${stderr.trim().slice(-500) || "(no stderr)"}`,
              ),
              spawned,
              stdout,
              stderr,
            ),
          ),
        );
        return;
      }
      settle(() => resolve({ stdout, stderr }));
    }
  });
}
