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
import { config } from "./config.js";
import { startListener } from "./listen.js";
import { acquireSingleInstanceLock } from "./lock.js";
import { buildMentionPrompt, buildSystemPromptAppend, cliTaskRef } from "./prompt.js";
import { runAgent, type RunError } from "./runner.js";
import { State } from "./state.js";
import {
  clearActivity,
  cliTaskArgs,
  listUnreadNotifications,
  markRead,
  markReadIds,
  setActivity,
  whoAmI,
  type Notification,
} from "./taskshoot.js";

/** The "thinking" indicator shown on the thread while a mention is being
 * answered. Refreshed while the run is alive; the TTL bounds how long a stale
 * indicator survives a crash. Refresh well inside the TTL so one missed
 * refresh does not blink the indicator off. */
const ACTIVITY_TEXT = {
  en: "Thinking about a reply to the mention…",
  ja: "メンションの回答を考えています…",
};
const ACTIVITY_TTL_SECONDS = 90;
const ACTIVITY_REFRESH_MS = 30_000;

async function main(): Promise<void> {
  // Captured before any startup work: whoAmI() can retry for minutes, and the
  // first-run backlog cutoff must predate everything this process might have
  // been expected to answer.
  const bootedAt = Date.now();
  acquireSingleInstanceLock();
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
    queue.push(notification);
    console.log(`[${source}] queued ${notification.id} (${notification.title})`);
    if (drainingEnabled) void drain();
  };

  const drain = async () => {
    if (working) return;
    working = true;
    try {
      for (let next = queue.shift(); next; next = queue.shift()) {
        // Re-check the ledger at dequeue time, and keep the id in queuedIds
        // until the run finished: an agent run takes minutes, and a poll (or
        // the WS catch-up) firing mid-run must not re-enqueue the mention we
        // are answering right now — that was a real double-reply path.
        if (!state.isHandled(next.id)) {
          await handle(next);
        }
        queuedIds.delete(next.id);
      }
    } finally {
      working = false;
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
    // Show "thinking…" on the thread while the agent works, and keep it
    // alive across the (minutes-long) run. Cleared in the finally: posting a
    // reply clears it server-side, but a NO_REPLY or failed run posts
    // nothing. All activity calls are chained onto one promise so the final
    // clear runs strictly after any in-flight refresh — an overtaken refresh
    // would otherwise recreate the indicator for a full TTL after the run
    // ended (the same race the web frontend serializes per task).
    const activityArgs = cliTaskArgs(notification);
    let activityTimer: NodeJS.Timeout | undefined;
    let activityChain: Promise<void> = Promise.resolve();
    let queuedActivityOps = 0;
    const chainActivity = (op: () => Promise<void>): Promise<void> => {
      queuedActivityOps += 1;
      activityChain = activityChain.then(op, op).finally(() => {
        queuedActivityOps -= 1;
      });
      return activityChain;
    };
    if (activityArgs) {
      await chainActivity(() =>
        setActivity(activityArgs, ACTIVITY_TEXT, ACTIVITY_TTL_SECONDS),
      );
      activityTimer = setInterval(() => {
        // Coalesce: a refresh slower than the interval must not queue ticks
        // behind itself — the backlog would outlive the run and delay the
        // final clear (and every later mention in this serial queue). A
        // skipped tick costs nothing: the TTL is three intervals long.
        if (queuedActivityOps === 0) {
          void chainActivity(() =>
            setActivity(activityArgs, ACTIVITY_TEXT, ACTIVITY_TTL_SECONDS),
          );
        }
      }, ACTIVITY_REFRESH_MS);
    }
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
      console.error(`agent run failed for ${notification.id}; the backstop will retry:`, error);
    } finally {
      if (activityTimer) clearInterval(activityTimer);
      // Chained: waits for any refresh still in flight before clearing.
      if (activityArgs) await chainActivity(() => clearActivity(activityArgs));
    }
  };

  const poll = async () => {
    try {
      const items = await listUnreadNotifications();
      // Oldest first, so replies land in thread order.
      items.sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const notification of items) {
        // Rows this daemon will never answer must not stay unread, or they
        // pile up until they push real mentions past the capped list:
        // - unsubscribed types (the daemon owns this bot's inbox, nothing
        //   else reads it),
        // - handled-but-unread rows (a mark-read that failed earlier; once
        //   their ids aged out of the ledger they would even be re-answered).
        if (!wantedTypes.has(notification.notification_type)) {
          await markRead(notification.id);
          continue;
        }
        if (state.isHandled(notification.id)) {
          await markRead(notification.id);
          continue;
        }
        enqueue(notification, "poll");
      }
    } catch (error) {
      console.error("polling backstop failed:", error);
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
    // only respond to mentions from now on. Marking read matters beyond
    // tidiness: the list is capped at 100, so pre-existing unread rows beyond
    // the cap would otherwise surface in later polls (and get answered) as
    // the newer rows drain — and unread rows of unsubscribed types would
    // crowd mentions out of the backstop's window. Nothing else consumes a
    // bot's notification inbox.
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
      if (backlog.length === 0) {
        // The list API has no pagination cursor, so a page consisting
        // entirely of protected rows (queued / newer than the cutoff) would
        // hide any older backlog behind it — that takes 100+ mentions within
        // a minute of first boot. It cannot be reached from here; those rows
        // would surface in later polls and be answered. Say so, loudly.
        if (items.length >= 100) {
          console.error(
            "first run: the unread page is full of new notifications; " +
              "backlog hidden behind it (if any) will be ANSWERED by later polls",
          );
        }
        break;
      }
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
  drainingEnabled = true;
  void drain();
  setInterval(poll, config.pollMinutes * 60 * 1000);
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
