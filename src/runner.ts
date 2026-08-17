/**
 * Picks the agent backend and runs one mention through it.
 *
 * Backends live in `./backends/`; the contract they share is in
 * `./backends/types.ts`. `TSSA_AGENT_BACKEND` selects one, defaulting to
 * `claude` so hosts that predate this switch keep their behaviour.
 */
import { runClaude } from "./backends/claude.js";
import { HERMES_REPLY_NOTE, runHermes } from "./backends/hermes.js";
import type { AgentBackend } from "./backends/types.js";
import { config } from "./config.js";

export type { AgentRunResult, RunError } from "./backends/types.js";

const backends: Record<typeof config.agentBackend, AgentBackend> = {
  claude: runClaude,
  hermes: runHermes,
};

export const runAgent: AgentBackend = (prompt, options) =>
  backends[config.agentBackend](prompt, options);

/** Policy text the selected backend needs added to the shared policy, if any. */
export function backendPolicyNote(): string {
  return config.agentBackend === "hermes" ? HERMES_REPLY_NOTE : "";
}
