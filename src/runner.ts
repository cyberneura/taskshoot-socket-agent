/**
 * Picks the agent backend and runs one mention through it.
 *
 * Backends live in `./backends/`; the contract they share is in
 * `./backends/types.ts`. `TSSA_AGENT_BACKEND` selects one, defaulting to
 * `claude` so hosts that predate this switch keep their behaviour.
 */
import { runClaude } from "./backends/claude.js";
import { runCodex } from "./backends/codex.js";
import { HERMES_REPLY_NOTE, runHermes } from "./backends/hermes.js";
import type { AgentBackend } from "./backends/types.js";
import { config } from "./config.js";
import type { Policy } from "./prompt.js";

export type { AgentRunResult, RunError } from "./backends/types.js";

const backends: Record<typeof config.agentBackend, AgentBackend> = {
  claude: runClaude,
  hermes: runHermes,
  codex: runCodex,
};

export const runAgent: AgentBackend = (prompt, options) =>
  backends[config.agentBackend](prompt, options);

/** Policy text the selected backend needs added to the shared policy, if any. */
export function backendPolicyNote(): string {
  return config.agentBackend === "hermes" ? HERMES_REPLY_NOTE : "";
}

/**
 * The policy the agent is actually given. Codex's `workspace-write` sandbox
 * blocks writes outside the run directory, so a `work` policy there would
 * send the agent into edits that fail; it gets `safe` instead.
 */
export function effectivePolicy(
  policy: Policy = config.policy,
  backend: typeof config.agentBackend = config.agentBackend,
  codexSandbox: typeof config.codexSandbox = config.codexSandbox,
): Policy {
  if (policy === "work" && backend === "codex" && codexSandbox === "workspace-write") {
    return "safe";
  }
  return policy;
}
