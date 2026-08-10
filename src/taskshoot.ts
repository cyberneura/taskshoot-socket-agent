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
 * Known limitation: the CLI has no server-side type filter for this list, so
 * 100+ unread notifications of unsubscribed types (e.g. task_assigned piling
 * up on a busy bot) could push mentions past the limit and blind the polling
 * backstop. The caller's mark-read cleanup keeps handled rows from
 * contributing to that pile; a --types filter on `notifications list` would
 * remove the limitation for good.
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
