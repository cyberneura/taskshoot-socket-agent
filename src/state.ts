/**
 * Persistent daemon state:
 *
 * - handled notification ids — the daemon's idempotency ledger. The WebSocket
 *   catch-up deliberately resends an overlap window, and the polling backstop
 *   re-reads whatever mark-read failed to clear, so the same notification can
 *   arrive many times. Replying to a mention is not idempotent, so the ledger
 *   is what actually prevents double replies.
 * - Agent SDK session ids per task — a later mention in the same task thread
 *   resumes the same session, so the conversation keeps its context.
 */
import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";

const HANDLED_LIMIT = 1000;
/** Sessions kept, newest tasks last. One entry per task; without a cap the
 * file (rewritten on every notification) grows for the daemon's lifetime. */
const SESSIONS_LIMIT = 200;

interface StateFile {
  handled: string[];
  sessions: Record<string, string>;
}

function stateFilePath(): string {
  return path.join(config.stateDir, "state.json");
}

function load(): StateFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFilePath(), "utf8");
  } catch {
    return null; // no file yet: a genuine first run
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      handled: Array.isArray(parsed.handled) ? parsed.handled : [],
      sessions: typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {},
    };
  } catch (error) {
    // A corrupt ledger is NOT a first run, but its contents are gone either
    // way. Keep the evidence aside and fall back to first-run seeding (which
    // suppresses replies rather than duplicating them) — and say so loudly.
    const backup = `${stateFilePath()}.corrupt-${Date.now()}`;
    console.error(`[state] state file is corrupt; moving it to ${backup}:`, error);
    try {
      fs.renameSync(stateFilePath(), backup);
    } catch {
      // The unreadable file stays; the next save overwrites it.
    }
    return null;
  }
}

export class State {
  private data: StateFile;
  private handledSet: Set<string>;
  /** True when no (readable) state file existed — the daemon's very first
   * run on this host. The caller seeds the ledger with the existing unread
   * backlog in that case, so that old mentions accumulated before the daemon
   * existed are not suddenly answered in bulk. */
  readonly isFirstRun: boolean;

  constructor() {
    fs.mkdirSync(config.stateDir, { recursive: true });
    const loaded = load();
    this.isFirstRun = loaded === null;
    this.data = loaded ?? { handled: [], sessions: {} };
    this.handledSet = new Set(this.data.handled);
  }

  isHandled(notificationId: string): boolean {
    return this.handledSet.has(notificationId);
  }

  markHandled(notificationId: string): void {
    if (this.handledSet.has(notificationId)) return;
    this.handledSet.add(notificationId);
    this.data.handled.push(notificationId);
    if (this.data.handled.length > HANDLED_LIMIT) {
      const dropped = this.data.handled.splice(0, this.data.handled.length - HANDLED_LIMIT);
      for (const id of dropped) this.handledSet.delete(id);
    }
    this.save();
  }

  sessionFor(taskId: string): string | undefined {
    return this.data.sessions[taskId];
  }

  saveSession(taskId: string, sessionId: string): void {
    // Re-insert so JS object key order doubles as recency order.
    delete this.data.sessions[taskId];
    this.data.sessions[taskId] = sessionId;
    const keys = Object.keys(this.data.sessions);
    for (const stale of keys.slice(0, Math.max(0, keys.length - SESSIONS_LIMIT))) {
      delete this.data.sessions[stale];
    }
    this.save();
  }

  /** Persist the current state unconditionally. Called after first-run
   * seeding: with zero seeded ids nothing else would write the file, and the
   * next start would wrongly run first-run seeding again — swallowing any
   * mention that arrived while the daemon was down. */
  persist(): void {
    this.save();
  }

  private save(): void {
    // Write-then-rename: a crash mid-write must not truncate the ledger,
    // because a lost ledger means every recent mention gets answered again.
    const file = stateFilePath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, file);
  }
}
