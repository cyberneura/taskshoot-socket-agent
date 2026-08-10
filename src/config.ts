/**
 * Runtime configuration, all from environment variables.
 *
 * Taskshoot credentials are NOT configured here: every Taskshoot call goes
 * through the `taskshoot` CLI, which resolves its own credentials
 * (TASKSHOOT_CLI_API_KEY / ~/.config/taskshoot/config.yml). The Claude Agent
 * SDK likewise uses the Claude Code authentication already present on the
 * host. This daemon only wires the two together.
 */
import { homedir } from "node:os";
import path from "node:path";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

export const config = {
  /** Notification types to subscribe to. Mentions only by default: task
   * assignment is deliberately left to a slower polling loop elsewhere, so a
   * human handing over work is not answered twice. */
  types: process.env.TSSA_NOTIFICATION_TYPES ?? "task_mentioned",

  /** Backstop polling interval. The listener catches up from a saved cursor
   * on reconnect, but that catch-up is capped server-side and the push
   * itself has no ACK — whatever falls through those cracks only surfaces
   * here. */
  pollMinutes: intEnv("TSSA_POLL_MINUTES", 30),

  /** Hard timeout for one Agent SDK run. */
  agentTimeoutMinutes: intEnv("TSSA_AGENT_TIMEOUT_MINUTES", 20),

  /** Working directory the agent runs in. */
  agentCwd: process.env.TSSA_AGENT_CWD ?? path.join(homedir(), "workspace"),

  /** Where session ids and handled notification ids are persisted. */
  stateDir:
    process.env.TSSA_STATE_DIR ??
    path.join(homedir(), ".local", "state", "taskshoot-socket-agent"),

  /** The `taskshoot` binary (must be on PATH by default). */
  taskshootBin: process.env.TSSA_TASKSHOOT_BIN ?? "taskshoot",

  /** Extra text appended to the agent's system prompt (site policy). */
  extraSystemPrompt: process.env.TSSA_EXTRA_SYSTEM_PROMPT ?? "",
};
