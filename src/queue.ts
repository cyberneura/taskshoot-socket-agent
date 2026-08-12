import type { Notification } from "./taskshoot.js";

/**
 * Insert a notification into the pending queue, keeping it ordered by
 * `created_at` (oldest first).
 *
 * Appending instead would put a live WebSocket row ahead of older backlog
 * that a later poll admits — the poll only sees a bounded slice per sweep, so
 * the rest arrives after rows that are newer than it. Replies would then land
 * out of thread order, which matters most when several mentions share a task
 * and the agent resumes that task's session.
 *
 * Ties keep insertion order (`>` rather than `>=`): `created_at` has
 * millisecond resolution, and two rows sharing one are as good as
 * simultaneous — there is nothing better to break the tie with, and the
 * arrival order is at least stable.
 */
export function insertByCreatedAt(
  queue: Notification[],
  notification: Notification,
): void {
  const at = queue.findIndex((queued) => queued.created_at > notification.created_at);
  if (at === -1) {
    queue.push(notification);
  } else {
    queue.splice(at, 0, notification);
  }
}
