/**
 * Thin wrapper around the `taskshoot` CLI for the daemon's own needs
 * (identity check and the notification backstop). The agent replies through
 * the CLI itself — this wrapper never posts comments.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "./config.js";

const execFileAsync = promisify(execFile);

export interface NotificationTask {
  id: string;
  project_key: string;
  number: number | null;
  title: string;
  org_code_name: string;
  ref: string | null;
  bot_ready: boolean;
}

export interface Notification {
  id: string;
  notification_type: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
  task: NotificationTask | null;
}

async function runJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(config.taskshootBin, ["--json", ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

export async function whoAmI(): Promise<{ id: string; display_name: string }> {
  return runJson(["me"]);
}

/** One page of `notifications list`; the server caps a page at this. */
const NOTIFICATION_PAGE_SIZE = 100;

/** Pages to walk in one call (= 5,000 rows). A backlog that deep means
 * something is wrong upstream, and walking it forever would keep the poll —
 * and the mentions behind it — waiting. Reaching this is logged. */
const MAX_NOTIFICATION_PAGES = 50;

/** Whether the installed CLI knows `notifications list --before` (added
 * alongside `--types`; CYBERNEURA-DEV-402). Cached like `activityAvailable`:
 * on an older CLI this degrades to the single newest page rather than
 * failing every poll. */
let cursorCheck: Promise<boolean> | null = null;

function cursorAvailable(): Promise<boolean> {
  cursorCheck ??= (async () => {
    try {
      const { stdout } = await execFileAsync(config.taskshootBin, [
        "notifications",
        "list",
        "--help",
      ]);
      if (stdout.includes("--before")) return true;
    } catch {
      // fall through to the warning: an unusable --help means an unusable flag
    }
    console.error(
      "[poll] `taskshoot notifications list --before` is unavailable (older CLI); " +
        "only the newest 100 unread notifications are reachable",
    );
    return false;
  })();
  return cursorCheck;
}

/**
 * Unread notifications, newest first, up to `MAX_NOTIFICATION_PAGES` pages.
 *
 * The cursor is what widens this past one page: a page holds at most 100, so
 * without it the newest 100 rows were all a poll could see, and unread rows
 * of types this daemon does not answer could push real mentions out of that
 * window. `--before <id>` walks the pages behind it (CYBERNEURA-DEV-402).
 *
 * **Still bounded, just far higher.** Hitting the page cap is logged rather
 * than reported to the caller: the rows beyond it stay unread, so the next
 * poll starts on them once these are marked read. Callers must not read
 * "no more rows here" as "no more rows anywhere".
 *
 * Deliberately **not** filtered with `--types`: the caller marks unwanted
 * types read (nothing else consumes a bot's inbox), which needs them listed.
 */
export async function listUnreadNotifications(): Promise<Notification[]> {
  return collectUnreadPages(
    (before) => {
      const args = [
        "notifications",
        "list",
        "--unread-only",
        "--limit",
        String(NOTIFICATION_PAGE_SIZE),
      ];
      if (before) args.push("--before", before);
      return runJson<{ items: Notification[] }>(args).then((r) => r.items);
    },
    cursorAvailable,
  );
}

/** The paging loop, with the subprocess handed in so it can be tested.
 * `hasCursor` is only consulted when a second page is actually needed. */
export async function collectUnreadPages(
  fetchPage: (before?: string) => Promise<Notification[]>,
  hasCursor: () => Promise<boolean>,
): Promise<Notification[]> {
  const all = [...(await fetchPage())];
  if (all.length < NOTIFICATION_PAGE_SIZE) return all;
  if (!(await hasCursor())) return all;

  // A full page always has a last row, but the index signature does not say
  // so; treating a missing one as the end keeps the loop from spinning on a
  // cursor it cannot advance.
  const cursorOf = (items: Notification[]) => items[items.length - 1]?.id;

  let before = cursorOf(all);
  for (let pageNumber = 1; before && pageNumber < MAX_NOTIFICATION_PAGES; pageNumber++) {
    const items = await fetchPage(before);
    all.push(...items);
    // A short page is the end of the backlog. Stopping on `length === 0`
    // instead would cost one extra request per poll for no new rows.
    if (items.length < NOTIFICATION_PAGE_SIZE) return all;
    before = cursorOf(items);
  }
  if (!before) return all;
  // "may remain": a backlog that ends exactly on the cap is indistinguishable
  // from one that continues without spending another request to find out.
  console.error(
    `[poll] stopped after ${MAX_NOTIFICATION_PAGES} pages (${all.length} unread); ` +
      "older notifications may remain and are left for the next poll",
  );
  return all;
}

/** Exported for tests: the page size the loop treats as "a full page". */
export const NOTIFICATION_PAGE_SIZE_FOR_TESTS = NOTIFICATION_PAGE_SIZE;
export const MAX_NOTIFICATION_PAGES_FOR_TESTS = MAX_NOTIFICATION_PAGES;

/** Mark specific notifications read (first-run seeding). Unlike the
 * per-notification variant this throws on failure: seeding relies on the
 * read flag to keep the pre-existing backlog out of future polls. */
export async function markReadIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await execFileAsync(config.taskshootBin, ["notifications", "read", ...ids]);
}

/** Task reference arguments for the CLI: ["KEY-N"] for tracked tasks,
 * ["<uuid>", "--project", "<KEY>"] for untracked ones. */
export function cliTaskArgs(notification: Notification): string[] | null {
  const task = notification.task;
  if (!task) return null;
  if (task.ref) return [task.ref];
  return [task.id, "--project", task.project_key];
}

/** Hard cap on one activity CLI call. The indicator is cosmetic, but its
 * calls sit on the serial handling chain — without a timeout a stalled call
 * (network black hole) would wedge every later mention behind it. */
const ACTIVITY_EXEC_TIMEOUT_MS = 15_000;

/** Whether the installed CLI knows `task activity` (added in 0.8.0). Checked
 * once; on an older CLI the indicator is skipped rather than failing every
 * mention. The promise itself is cached (not just the result): activity
 * calls for different tasks run concurrently, and each racing caller would
 * otherwise spawn its own `--help` subprocess. */
let activityCheck: Promise<boolean> | null = null;

function activityAvailable(): Promise<boolean> {
  activityCheck ??= (async () => {
    try {
      await execFileAsync(config.taskshootBin, ["task", "activity", "--help"], {
        timeout: ACTIVITY_EXEC_TIMEOUT_MS,
      });
      return true;
    } catch {
      console.error(
        "[activity] `taskshoot task activity` is unavailable (CLI < 0.8.0); the working indicator is disabled",
      );
      return false;
    }
  })();
  return activityCheck;
}

/** Transient "working on it" indicator on the task thread. Best-effort: the
 * indicator is cosmetic, so failures are logged and never interrupt the run.
 * The TTL bounds how long a stale indicator can outlive a crashed run. */
export async function setActivity(
  taskArgs: string[],
  text: { en: string; ja: string },
  ttlSeconds: number,
): Promise<void> {
  if (!(await activityAvailable())) return;
  try {
    await execFileAsync(
      config.taskshootBin,
      [
        "task",
        "activity",
        ...taskArgs,
        "--text",
        text.en,
        "--text-ja",
        text.ja,
        "--ttl",
        String(ttlSeconds),
      ],
      { timeout: ACTIVITY_EXEC_TIMEOUT_MS },
    );
  } catch (error) {
    console.error("[activity] set failed:", error);
  }
}

/** Take the indicator down now. Also called after the agent posted its reply
 * (the server clears on post, but a NO_REPLY or failed run posts nothing). */
export async function clearActivity(taskArgs: string[]): Promise<void> {
  if (!(await activityAvailable())) return;
  try {
    await execFileAsync(config.taskshootBin, ["task", "activity", ...taskArgs, "--clear"], {
      timeout: ACTIVITY_EXEC_TIMEOUT_MS,
    });
  } catch (error) {
    console.error("[activity] clear failed:", error);
  }
}

/** Mark a notification read. Failures are logged, not thrown: the handled-id
 * ledger is what prevents double replies, and a mention must not be retried
 * (and answered twice) because mark-read hiccuped. Rows left unread by a
 * failure here are retried by the polling sweep. */
/** Ids per `notifications read` call. One call for thousands of ids would
 * build an argv megabytes long; chunking keeps it far below any limit while
 * still replacing a subprocess per row with one per 500. */
const MARK_READ_CHUNK = 500;

/** Mark many notifications read, best effort. Cleanup rows are not worth
 * failing a poll over: an id that stays unread is simply listed again next
 * time. (`markReadIds` throws instead, because seeding relies on the read
 * flag to keep the pre-existing backlog out of future polls.) */
export async function markReadIdsBestEffort(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += MARK_READ_CHUNK) {
    const chunk = ids.slice(i, i + MARK_READ_CHUNK);
    try {
      await execFileAsync(config.taskshootBin, ["notifications", "read", ...chunk]);
    } catch (error) {
      console.error(
        `[taskshoot-socket-agent] failed to mark ${chunk.length} notifications read:`,
        error,
      );
    }
  }
}

export async function markRead(notificationId: string): Promise<void> {
  try {
    await execFileAsync(config.taskshootBin, ["notifications", "read", notificationId]);
  } catch (error) {
    console.error(`[taskshoot-socket-agent] failed to mark ${notificationId} read:`, error);
  }
}
