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
