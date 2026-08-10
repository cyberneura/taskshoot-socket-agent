/**
 * Single-instance guard. Two daemons on one host would both pass the
 * in-memory queue checks and reply to the same mention, and would race on
 * the state file — so a second instance must refuse to start.
 *
 * A pid file (not flock) keeps this dependency-free; the stale check makes a
 * crash recoverable. The remaining check-then-write race window is
 * irrelevant under supervisor/launchd, which start one instance at a time.
 */
import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";

function lockPath(): string {
  return path.join(config.stateDir, "daemon.pid");
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireSingleInstanceLock(): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  const file = lockPath();
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    } catch {
      // Unreadable lock file: treat as stale.
    }
    if (Number.isInteger(holder) && holder !== process.pid && pidIsAlive(holder)) {
      throw new Error(`another taskshoot-socket-agent is running (pid ${holder})`);
    }
    fs.writeFileSync(file, String(process.pid));
  }

  process.on("exit", () => {
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(file);
      }
    } catch {
      // A stale pid file is handled by the liveness check on the next start.
    }
  });
}
