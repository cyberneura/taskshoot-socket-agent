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
  listUnreadNotifications,
  markAllRead,
  markRead,
  whoAmI,
  type Notification,
} from "./taskshoot.js";

async function main(): Promise<void> {
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

  const enqueue = (notification: Notification, source: string) => {
    if (!wantedTypes.has(notification.notification_type)) return;
    if (state.isHandled(notification.id) || queuedIds.has(notification.id)) return;
    queuedIds.add(notification.id);
    queue.push(notification);
    console.log(`[${source}] queued ${notification.id} (${notification.title})`);
    void drain();
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
    }
  };

  const poll = async () => {
    try {
      const items = await listUnreadNotifications();
      // Oldest first, so replies land in thread order.
      items.sort((a, b) => (a.id < b.id ? -1 : 1));
      for (const notification of items) {
        // Handled but still unread = a mark-read that failed earlier. Retry
        // it here: left alone, such rows pile up until they push real
        // mentions past the list limit, and once their ids age out of the
        // ledger they would be answered a second time.
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

  if (state.isFirstRun) {
    // Very first run on this host: the unread backlog predates the daemon.
    // Answering weeks-old mentions in bulk would be noise (and the requesters
    // have long moved on), so seed the ledger and mark the whole backlog
    // read, and only respond to mentions from now on. Marking read matters
    // beyond tidiness: the list is capped at 100, so pre-existing unread
    // rows beyond the cap would otherwise surface in later polls (and get
    // answered) as the newer rows drain — and unread rows of unsubscribed
    // types would crowd mentions out of the backstop's window. Nothing else
    // consumes a bot's notification inbox.
    // This runs BEFORE the listener starts, so anything arriving from now on
    // is seen by the WS (or the next poll) and answered — the seed can only
    // contain what predates it.
    const items = await listUnreadNotifications();
    for (const notification of items) state.markHandled(notification.id);
    await markAllRead();
    // Persist even when the backlog was empty: the state file's existence is
    // what marks first-run seeding as done.
    state.persist();
    console.log(`first run: seeded the ledger with ${items.length} pre-existing notifications`);
  }

  startListener((notification) => enqueue(notification, "ws"));
  setInterval(poll, config.pollMinutes * 60 * 1000);
  if (!state.isFirstRun) {
    // One immediate sweep so mentions that arrived while the daemon was down
    // are answered now, not up to pollMinutes later.
    await poll();
  }
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
