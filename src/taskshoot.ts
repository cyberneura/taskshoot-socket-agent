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

/**
 * Known limitation: the CLI offers neither a server-side type filter nor a
 * pagination cursor for this list, so only the newest 100 unread rows are
 * reachable. Consequences, all bounded by the same missing cursor:
 * - 100+ unread rows of unsubscribed types could push mentions out of the
 *   window (mitigated by the caller's mark-read cleanup);
 * - during a first-run seed, backlog hidden behind a full page of protected
 *   rows cannot be reached (requires 100+ mentions within a minute of first
 *   boot — logged when detected);
 * - after long downtime with 100+ unread mentions, older hidden rows are
 *   only reached on later polls, so cross-poll ordering is not guaranteed.
 * Adding `--types` and a `--before <id>` cursor to `taskshoot notifications
 * list` would remove all three for good.
 */
export async function listUnreadNotifications(): Promise<Notification[]> {
  const { items } = await runJson<{ items: Notification[] }>([
    "notifications",
    "list",
    "--unread-only",
    "--limit",
    "100",
  ]);
  return items;
}

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
export async function markRead(notificationId: string): Promise<void> {
  try {
    await execFileAsync(config.taskshootBin, ["notifications", "read", notificationId]);
  } catch (error) {
    console.error(`[taskshoot-socket-agent] failed to mark ${notificationId} read:`, error);
  }
}
