/**
 * taskshoot-socket-agent — answer Taskshoot mentions in real time.
 *
 * Pipeline: `taskshoot listen` (WebSocket, JSON Lines) → serial queue →
 * Claude Agent SDK run → the agent posts its reply with `taskshoot task
 * comment` itself.
 *
 * The WebSocket is not a source of truth: the push has no ACK, and the
 * cursor catch-up on reconnect is capped server-side. A polling backstop
 * re-reads unread notifications on an interval; both paths converge on the
 * same handled-id ledger, which is what prevents double replies.
 */
import { ActivityIndicator } from "./activity.js";
import { preflightHermes } from "./backends/hermes.js";
import { config } from "./config.js";
import { startListener } from "./listen.js";
import { acquireSingleInstanceLock } from "./lock.js";
import { buildMentionPrompt, buildSystemPromptAppend, cliTaskRef } from "./prompt.js";
import { insertByCreatedAt } from "./queue.js";
import { runAgent, type RunError } from "./runner.js";
import { isShuttingDown, onShutdown } from "./shutdown.js";
import { State } from "./state.js";
import {
  cliTaskArgs,
  listUnreadNotifications,
  markRead,
  markReadIds,
  markReadIdsBestEffort,
  whoAmI,
  type Notification,
} from "./taskshoot.js";

/** Answerable notifications one poll may queue. Runs are serial, so a sweep
 * that queued thousands would take days to drain anyway — but it would also
 * acquire an activity indicator and a 30-second refresh timer per task up
 * front, and `src/activity.ts` is dimensioned for about 100 of those. The
 * rest are left unread, so the next sweep finds them again. */
const MAX_ENQUEUE_PER_POLL = 100;

async function main(): Promise<void> {
  // Captured before any startup work: whoAmI() can retry for minutes, and the
  // first-run backlog cutoff must predate everything this process might have
  // been expected to answer.
  const bootedAt = Date.now();
  acquireSingleInstanceLock();
  // Only the hermes backend is checked: this daemon spawns that binary itself,
  // whereas Claude Code is located by the Agent SDK and second-guessing it here
  // could refuse to start a host that works.
  if (config.agentBackend === "hermes") await preflightHermes();
  const me = await whoAmI();
  console.log(`authenticated as ${me.display_name} (${me.id})`);

  const state = new State();
  const systemPromptAppend = buildSystemPromptAppend(me.display_name, config.extraSystemPrompt);
  const wantedTypes = new Set(config.types.split(",").map((t) => t.trim()));

  // Mentions are processed strictly one at a time. Parallel agent runs on the
  // same host would race on repositories and on the session store, and a
  // burst of mentions is better served slightly late than twice.
  const queue: Notification[] = [];
  const queuedIds = new Set<string>();
  // The "thinking…" indicator starts the moment a mention is enqueued (not
  // when its serial turn comes up) and clears when its run finished. Each
  // queued mention holds one refcount on its task's indicator; the release
  // is looked up by notification id at dequeue time.
  const activity = new ActivityIndicator();
  const activityHolds = new Map<
    string,
    { ready: Promise<void>; release: () => Promise<void> }
  >();
  let working = false;
  // Draining stays off until first-run seeding has finished: a handle() that
  // completes mid-seed would write state.json early (a crash then makes the
  // restart skip seeding and answer the remaining backlog), and a handle()
  // that fails mid-seed would release its queuedIds entry and let the seed
  // misfile that mention as backlog. Enqueued work waits; nothing is lost.
  let drainingEnabled = false;

  const enqueue = (notification: Notification, source: string) => {
    if (!wantedTypes.has(notification.notification_type)) return;
    if (state.isHandled(notification.id) || queuedIds.has(notification.id)) return;
    queuedIds.add(notification.id);
    // Ordered by created_at, not appended: a poll admits a bounded slice per
    // sweep, so backlog older than a live WebSocket row can arrive after it.
    insertByCreatedAt(queue, notification);
    const taskArgs = cliTaskArgs(notification);
    if (notification.task && taskArgs) {
      // Keyed by the stable task id: the CLI args for the same task can
      // change between mentions (untracked task gaining a ref).
      activityHolds.set(
        notification.id,
        activity.acquire(notification.task.id, taskArgs),
      );
    }
    console.log(`[${source}] queued ${notification.id} (${notification.title})`);
    if (drainingEnabled && !isShuttingDown()) void drain();
  };

  // A sweep left answerable rows behind (admission cap). They stay unread, so
  // the next sweep finds them — but waiting a whole poll interval to start it
  // would idle the daemon between batches, which is exactly the downtime
  // recovery this backstop exists for. Cleared by the refill in `drain`.
  let sweepWasCapped = false;
  // Sweeps do not overlap: two in flight would list the same rows and race on
  // the cleanup, and the refill below can start one right after a batch.
  let sweeping = false;

  const drain = async () => {
    if (working) return;
    working = true;
    try {
      // Stop pulling work the moment shutdown starts: a run begun now would be
      // killed part-way, possibly after posting, and the ledger entry recording
      // it would never be written. What stays queued stays unread, and the next
      // daemon answers it exactly once.
      for (let next = queue.shift(); next && !isShuttingDown(); next = queue.shift()) {
        // Re-check the ledger at dequeue time, and keep the id in queuedIds
        // until the run finished: an agent run takes minutes, and a poll (or
        // the WS catch-up) firing mid-run must not re-enqueue the mention we
        // are answering right now — that was a real double-reply path.
        const hold = activityHolds.get(next.id);
        if (!state.isHandled(next.id)) {
          // The initial set must land before the run: a fast reply posted
          // ahead of it would have nothing to clear server-side, and the
          // late set would show "thinking" after the answer.
          if (hold) await hold.ready;
          // Re-checked: the loop condition was evaluated before that await,
          // and a signal arriving in between must not start a run.
          if (isShuttingDown()) break;
          await handle(next);
        }
        queuedIds.delete(next.id);
        // Released after the run (posting the reply already cleared the
        // indicator server-side, but a NO_REPLY or failed run posts
        // nothing) — and also for skipped duplicates, or the refcount leaks
        // and the indicator never clears.
        activityHolds.delete(next.id);
        if (hold) await hold.release();
      }
    } finally {
      working = false;
    }
    // The queue is empty here. If the last sweep was capped, start the next
    // one now rather than at the next timer tick: a batch of fast NO_REPLY
    // runs can drain in seconds, and the rows behind it are already known to
    // exist. Each pass marks its batch handled and read, so this terminates
    // when the backlog does.
    if (sweepWasCapped && drainingEnabled) {
      sweepWasCapped = false;
      console.log("[poll] the previous sweep was capped; sweeping again for the rest");
      void poll();
    }
  };

  const handle = async (notification: Notification) => {
    const taskId = notification.task?.id;
    const resumeSessionId = taskId ? state.sessionFor(taskId) : undefined;
    const prompt = buildMentionPrompt(notification, Boolean(resumeSessionId));
    console.log(
      `handling ${notification.id} on ${cliTaskRef(notification) ?? "(no task)"}` +
        (resumeSessionId ? ` (resuming session ${resumeSessionId})` : ""),
    );
    try {
      let run;
      try {
        run = await runAgent(prompt, { systemPromptAppend, resumeSessionId });
      } catch (error) {
        // Retry with a fresh session ONLY when the resume never established
        // (the stored session expired or was cleaned up) — otherwise this
        // mention would never be answered. A failure after the session
        // initialized may have already posted a comment (e.g. max turns hit
        // after replying), so re-running it here would double-reply; those
        // go to the backstop like any other failure.
        const established = (error as RunError).sessionEstablished === true;
        if (!resumeSessionId || established) throw error;
        console.error(`resume of session ${resumeSessionId} failed; retrying fresh:`, error);
        run = await runAgent(prompt, { systemPromptAppend });
      }
      console.log(`agent finished: ${run.result.slice(0, 500)}`);
      if (taskId && run.sessionId) state.saveSession(taskId, run.sessionId);
      // Handled = the agent ran to completion (including a deliberate
      // NO_REPLY). Failures — thrown SDK errors and error results such as
      // error_max_turns alike — fall through WITHOUT marking, so the polling
      // backstop retries them.
      state.markHandled(notification.id);
      await markRead(notification.id);
    } catch (error) {
      // Keep the session of a failed run: the backstop will retry this
      // notification, and without the session the retry starts a fresh
      // conversation where the agent cannot see a reply it may already have
      // posted — and posts a second one. Resuming instead puts its own earlier
      // comment back in context, where the policy tells it not to repeat.
      const failedSessionId = (error as RunError).sessionId;
      if (taskId && failedSessionId) state.saveSession(taskId, failedSessionId);
      console.error(`agent run failed for ${notification.id}; the backstop will retry:`, error);
    }
  };

  const poll = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const items = await listUnreadNotifications();
      // Oldest first, so replies land in thread order.
      items.sort((a, b) => a.created_at.localeCompare(b.created_at));

      // Rows this daemon will never answer must not stay unread. Leaving them
      // would make every poll walk more pages, and once their ids age out of
      // the ledger the handled ones would even be re-answered:
      // - unsubscribed types (the daemon owns this bot's inbox, nothing else
      //   reads it),
      // - handled-but-unread rows (a mark-read that failed earlier).
      const cleanup: string[] = [];
      const answerable: Notification[] = [];
      for (const notification of items) {
        if (
          !wantedTypes.has(notification.notification_type) ||
          state.isHandled(notification.id)
        ) {
          cleanup.push(notification.id);
        } else {
          answerable.push(notification);
        }
      }

      // Queue the mentions FIRST. The cleanup below is a subprocess call, and
      // a sweep that finds thousands of stale rows would otherwise hold the
      // one notification this backstop exists to recover behind all of them.
      const admitted = answerable.slice(0, MAX_ENQUEUE_PER_POLL);
      for (const notification of admitted) enqueue(notification, "poll");
      if (answerable.length > admitted.length) {
        // The rest stay unread, so the next sweep lists them again. Admitting
        // them all instead would acquire an activity indicator and a refresh
        // timer per task, which src/activity.ts is dimensioned for ~100 of.
        // `drain` starts that next sweep as soon as this batch is done.
        sweepWasCapped = true;
        console.error(
          `[poll] ${answerable.length} answerable notifications; queued the oldest ` +
            `${admitted.length} and will sweep again once they are done`,
        );
      }
      // One subprocess per 500 rows rather than per row.
      await markReadIdsBestEffort(cleanup);
    } catch (error) {
      console.error("polling backstop failed:", error);
    } finally {
      sweeping = false;
    }
  };

  // The listener starts BEFORE first-run seeding: a mention created while
  // the seed is running is then held in the queue, and the seed skips
  // anything already queued — so it cannot be filed away as pre-existing
  // backlog. (Started after seeding, the same mention would be listed by the
  // seed, marked handled, and the later WS delivery dropped.)
  startListener((notification) => enqueue(notification, "ws"));

  if (state.isFirstRun) {
    // Very first run on this host: the unread backlog predates the daemon.
    // Answering weeks-old mentions in bulk would be noise (and the requesters
    // have long moved on), so mark the backlog read and seed the ledger, and
    // only respond to mentions from now on. Marking read is what files the
    // backlog away: the poll walks the unread list with a cursor, so anything
    // left unread here would be answered on a later sweep. Nothing else
    // consumes a bot's notification inbox.
    //
    // Ordering, for crash safety: batches are marked READ first (a crash then
    // leaves them read = swallowed backlog, the intended outcome, and the
    // state file does not exist yet so the restart seeds again), and the
    // ledger + state file are only written after every batch is read (a
    // crash mid-ledger leaves a partially handled but fully read backlog,
    // which the poll can no longer see). Writing the state file first would
    // be the dangerous order: a restart would skip seeding and answer the
    // rest of the backlog.
    //
    // Notifications the WS (already listening) delivered while we seed are
    // in queuedIds: they are new work, not backlog — never mark them read
    // or handled here; a crash before their run completes must leave them
    // recoverable by the backstop.
    // Backlog = older than the daemon's start (with a margin for clock skew
    // between this host and the server's created_at). The margin errs toward
    // answering: a mention from just before boot is answered by the poll
    // below rather than swallowed. The time cutoff also covers the window in
    // which `taskshoot listen` was still connecting — a mention created then
    // is not in queuedIds, but it is not backlog either.
    const backlogCutoff = new Date(bootedAt - 60_000).toISOString();
    const seeded: string[] = [];
    for (;;) {
      const items = await listUnreadNotifications();
      const backlog = items.filter(
        (n) => !queuedIds.has(n.id) && n.created_at < backlogCutoff,
      );
      // The cursor lifts this from "the newest page" to "the newest 5,000
      // rows", which is the difference between hiding backlog behind ~100
      // protected rows (queued or newer than the cutoff) and behind 5,000 of
      // them. It is not unbounded: listUnreadNotifications logs when it stops
      // at the page cap, and anything past it stays unread for the next poll
      // — which would answer it. Reaching that takes 5,000 notifications
      // within a minute of first boot.
      if (backlog.length === 0) break;
      await markReadIds(backlog.map((n) => n.id));
      seeded.push(...backlog.map((n) => n.id));
    }
    for (const id of seeded) state.markHandled(id);
    // Persist even when the backlog was empty: the state file's existence is
    // what marks first-run seeding as done.
    state.persist();
    console.log(`first run: marked ${seeded.length} pre-existing notifications read and seeded the ledger`);
  }

  // One immediate sweep BEFORE draining starts: after downtime it collects
  // what arrived while the daemon was down; after first-run seeding it
  // collects the unread rows the backlog cutoff deliberately left for it.
  // Draining only starts once this poll has merged its (older) rows into the
  // queue — otherwise a WS-delivered newer mention on the same task would be
  // handled first and resume the session out of thread order.
  await poll();
  // The WS listener may have queued newer mentions before the poll appended
  // older ones; one sort puts the whole startup backlog in thread order
  // before the first handle runs.
  queue.sort((a, b) => a.created_at.localeCompare(b.created_at));
  // Registers the signal handlers even when no backend needs cleanup, so the
  // daemon always stops admitting work on the first signal.
  onShutdown(() => {});
  drainingEnabled = true;
  void drain();
  setInterval(poll, config.pollMinutes * 60 * 1000);
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
