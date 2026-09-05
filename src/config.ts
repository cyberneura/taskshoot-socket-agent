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

function enumEnv<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(" | ")}, got ${raw}`);
  }
  return raw as T;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

const stateDir =
  process.env.TSSA_STATE_DIR ?? path.join(homedir(), ".local", "state", "taskshoot-socket-agent");

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

  /** Which agent runs a mention. `claude` uses the Claude Agent SDK in-process;
   * `hermes` shells out to the Hermes Agent CLI. Default stays `claude` so
   * existing hosts are unaffected by adding a backend. */
  agentBackend: enumEnv("TSSA_AGENT_BACKEND", ["claude", "hermes"], "claude"),

  /** Hard timeout for one agent run. */
  agentTimeoutMinutes: intEnv("TSSA_AGENT_TIMEOUT_MINUTES", 20),

  /** Working directory the agent runs in. */
  agentCwd: process.env.TSSA_AGENT_CWD ?? path.join(homedir(), "workspace"),

  /** The `hermes` binary (backend `hermes` only; must be on PATH by default). */
  hermesBin: process.env.TSSA_HERMES_BIN ?? "hermes",

  /** Working directory for the `hermes` backend. Separate from `agentCwd`
   * because the backend writes its policy to `AGENTS.md` there and must own
   * that file — see src/backends/hermes.ts. */
  hermesWorkdir:
    process.env.TSSA_HERMES_WORKDIR ?? path.join(stateDir, "hermes-workspace"),

  /** Where session ids and handled notification ids are persisted. */
  stateDir,

  /** The `taskshoot` binary (must be on PATH by default). */
  taskshootBin: process.env.TSSA_TASKSHOOT_BIN ?? "taskshoot",

  /** Extra text appended to the agent's system prompt (site policy). */
  extraSystemPrompt: process.env.TSSA_EXTRA_SYSTEM_PROMPT ?? "",

  /** Sentry DSN. Empty (the default) disables reporting entirely.
   *
   * Environment only: this repository is public, so a DSN must never be
   * committed to it. Hosts that want reporting pass it through whatever they
   * already use for secrets (a k8s Secret, a `.env` read by the start script,
   * ...). */
  sentryDsn: process.env.TSSA_SENTRY_DSN ?? "",

  /** Sentry `environment`. Empty (the default) lets the SDK decide.
   *
   * Deliberately not defaulted to the host name: the SDK already puts the
   * hostname in `server_name`, so that would add no information while creating
   * one Sentry environment per host — and per pod on Kubernetes, where the
   * name changes on every restart. */
  sentryEnvironment: process.env.TSSA_SENTRY_ENVIRONMENT ?? "",
};

// The hermes backend runs in its own directory (it owns that directory's
// AGENTS.md), so TSSA_AGENT_CWD would be silently ignored. Fail instead: an
// operator who set it meant the agent to run somewhere specific, and finding
// out from behaviour is far more expensive than finding out at startup.
if (config.agentBackend === "hermes" && process.env.TSSA_AGENT_CWD) {
  throw new Error(
    "TSSA_AGENT_CWD has no effect with TSSA_AGENT_BACKEND=hermes; " +
      "use TSSA_HERMES_WORKDIR (the hermes backend needs a directory it owns)",
  );
}
