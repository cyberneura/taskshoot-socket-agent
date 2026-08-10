/**
 * Per-task "thinking…" indicator, shown from the moment a mention is
 * received (enqueued) until its run finished — not just while the agent is
 * running. Mentions are handled serially, so a mention queued behind a long
 * run would otherwise show nothing for minutes.
 *
 * Refcounted per task: several queued mentions on the same task share one
 * indicator, and the clear only goes out when the last of them finished —
 * otherwise the first run's clear would blink the indicator off while a
 * sibling is still queued. All calls for one task ride a single promise
 * chain, so a clear runs strictly after any in-flight refresh; an overtaken
 * refresh would recreate the indicator for a full TTL after the run ended
 * (the same race the web frontend serializes per task).
 */
import { clearActivity, setActivity } from "./taskshoot.js";

/** Refreshed while any mention for the task is queued or running; the TTL
 * bounds how long a stale indicator survives a crash. Refresh well inside
 * the TTL so one missed refresh does not blink the indicator off. */
const ACTIVITY_TEXT = {
  en: "Thinking about a reply…",
  ja: "回答を考えています…",
};
const ACTIVITY_TTL_SECONDS = 90;
const ACTIVITY_REFRESH_MS = 30_000;

/** Global cap on concurrent activity CLI subprocesses across all tasks. A
 * downtime backlog can enqueue ~100 distinct tasks in one synchronous poll
 * sweep; without a cap their initial sets — and their synchronized 30-second
 * refreshes, for as long as the serial agent queue takes to drain — would
 * all fan out at once, starving the process/API capacity the agent needs. */
const MAX_CONCURRENT_OPS = 4;
let activeOps = 0;
const opWaiters: Array<() => void> = [];

async function withOpSlot(op: () => Promise<void>): Promise<void> {
  // while, not if: a caller arriving between a slot release and the woken
  // waiter actually running can take the slot first.
  while (activeOps >= MAX_CONCURRENT_OPS) {
    await new Promise<void>((resolve) => opWaiters.push(resolve));
  }
  activeOps += 1;
  try {
    await op();
  } finally {
    activeOps -= 1;
    opWaiters.shift()?.();
  }
}

interface Entry {
  count: number;
  chain: Promise<void>;
  queuedOps: number;
  timer?: NodeJS.Timeout;
}

export class ActivityIndicator {
  // Entries are kept after their count drops to zero so a re-acquired task
  // reuses the same chain — a fresh chain could run its set concurrently
  // with the old entry's still-in-flight clear. Bounded by distinct tasks
  // mentioned over the process lifetime.
  private readonly entries = new Map<string, Entry>();

  /** Start (or join) the indicator for a task. `ready` settles once the
   * initial set (or whatever was in flight at acquire time) has landed —
   * await it before running the agent, or a fast reply could be posted
   * before the set and the late set would show "thinking" after the answer.
   * Call `release` once when this mention is done; the indicator clears
   * when the last holder releases. */
  acquire(taskArgs: string[]): { ready: Promise<void>; release: () => Promise<void> } {
    const key = taskArgs.join("\u0000");
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { count: 0, chain: Promise.resolve(), queuedOps: 0 };
      this.entries.set(key, entry);
    }
    const held = entry;
    held.count += 1;
    let ready = held.chain;
    if (held.count === 1) {
      ready = this.chainOp(held, () =>
        setActivity(taskArgs, ACTIVITY_TEXT, ACTIVITY_TTL_SECONDS),
      );
      held.timer = setInterval(() => {
        // Coalesce: a refresh slower than the interval must not queue ticks
        // behind itself — the backlog would outlive the run and delay the
        // final clear. A skipped tick costs nothing: the TTL is three
        // intervals long.
        if (held.queuedOps === 0) {
          void this.chainOp(held, () =>
            setActivity(taskArgs, ACTIVITY_TEXT, ACTIVITY_TTL_SECONDS),
          );
        }
      }, ACTIVITY_REFRESH_MS);
    }
    let released = false;
    const release = () => {
      if (released) return Promise.resolve();
      released = true;
      held.count -= 1;
      if (held.count > 0) {
        // The server clears the indicator when this mention's reply is
        // posted, but siblings are still queued or running — re-set it now
        // rather than leaving a gap until the next refresh tick.
        return this.chainOp(held, () =>
          setActivity(taskArgs, ACTIVITY_TEXT, ACTIVITY_TTL_SECONDS),
        );
      }
      if (held.timer) clearInterval(held.timer);
      held.timer = undefined;
      return this.chainOp(held, () => clearActivity(taskArgs));
    };
    return { ready, release };
  }

  private chainOp(entry: Entry, op: () => Promise<void>): Promise<void> {
    entry.queuedOps += 1;
    const run = () => withOpSlot(op);
    entry.chain = entry.chain.then(run, run).finally(() => {
      entry.queuedOps -= 1;
    });
    return entry.chain;
  }
}
