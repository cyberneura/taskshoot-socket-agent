/**
 * Keep one `taskshoot listen` subprocess running and hand each notification
 * line to the callback.
 *
 * The CLI reconnects forever on transient network failures itself. It exits
 * non-zero for a rejected subscription (bad key / unknown types) — but also
 * for local failures such as an unwritable state file or a dead stdout, so a
 * non-zero exit is a strong hint, not proof. Either way the response is the
 * same: keep restarting with backoff and log loudly, because a genuinely
 * rejected subscription needs a human, and the polling backstop keeps
 * mentions flowing in the meantime.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

import { config } from "./config.js";
import type { Notification } from "./taskshoot.js";

const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 300_000;
/** A listener that survived this long was healthy; reset the backoff. */
const STABLE_MS = 120_000;

export function startListener(onNotification: (notification: Notification) => void): void {
  let delay = RESTART_MIN_MS;

  const start = () => {
    const startedAt = Date.now();
    const child = spawn(config.taskshootBin, ["listen", "--types", config.types], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`[listen] started (pid ${child.pid})`);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        console.error(`[listen] ignoring a non-JSON line: ${line.slice(0, 200)}`);
        return;
      }
      const m = message as { type?: string; notification?: Notification };
      if (m.type === "notification_created" && m.notification?.id) {
        onNotification(m.notification);
      }
    });

    // The CLI's connection log; forwarded so the daemon log tells the whole story.
    const errRl = readline.createInterface({ input: child.stderr });
    errRl.on("line", (line) => console.error(`[listen] ${line}`));

    child.on("exit", (code, signal) => {
      if (Date.now() - startedAt >= STABLE_MS) delay = RESTART_MIN_MS;
      if (code !== null && code !== 0) {
        // Likely a rejected subscription, which a restart cannot fix — but a
        // rotated key or a freed disk can, so keep trying at the maximum
        // interval instead of dying silently.
        delay = RESTART_MAX_MS;
        console.error(
          `[listen] exited with code ${code} — likely a rejected subscription ` +
            `(check the API key and TSSA_NOTIFICATION_TYPES), though local failures ` +
            `(state file, stdout) exit non-zero too. Retrying in ${delay / 1000}s.`,
        );
      } else {
        console.error(`[listen] exited (code ${code}, signal ${signal}); restarting in ${delay / 1000}s`);
      }
      setTimeout(start, delay);
      delay = Math.min(delay * 2, RESTART_MAX_MS);
    });
  };

  start();
}
