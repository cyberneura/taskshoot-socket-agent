/**
 * Claude Agent SDK backend. One SDK run per mention, in-process.
 *
 * The daemon runs unattended on a host the operator has dedicated to the bot,
 * so tool approvals cannot be interactive (there is no human at the prompt):
 * permissionMode bypassPermissions. Deliberately NO PreToolUse allow hook —
 * a hook's "allow" decision skips the normal permission evaluation entirely,
 * including the host's deny rules, whereas bypassPermissions on its own
 * still honors them. The deny rules are this daemon's enforcement layer, so
 * a blanket hook would defeat it.
 *
 * SECURITY: bypassing permissions means a prompt injection in a task thread
 * can steer the agent. The system-prompt policy is guidance, not enforcement;
 * enforcement is the host's Claude settings deny lists (all of user /
 * project / local settings are loaded) and host isolation. See the README
 * before deploying this anywhere.
 */
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";

import { config } from "../config.js";
import { isShuttingDown, onShutdown } from "../shutdown.js";
import { runError, type AgentRunResult, type RunOptions } from "./types.js";

/** In-flight runs, so shutdown can cut them off instead of letting them post. */
const liveAborts = new Set<AbortController>();
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // Refusing to *start* runs is not enough: a run already executing tools will
  // happily post its comment during the shutdown grace, and the ledger entry
  // that records it is written after the SDK returns — by a daemon that is
  // about to exit. The restarted daemon then answers the same mention again.
  onShutdown(() => {
    for (const controller of liveAborts) controller.abort();
  });
}

export async function runClaude(prompt: string, options: RunOptions): Promise<AgentRunResult> {
  registerCleanup();
  // A run started now would be cut off part-way through the shutdown grace,
  // possibly after posting — and the ledger entry recording it is written by
  // the daemon that is about to exit. Leaving the mention unread makes the
  // next daemon answer it exactly once.
  if (isShuttingDown()) throw runError(new Error("daemon is shutting down"), false);

  const abortController = new AbortController();
  liveAborts.add(abortController);
  const timeoutId = setTimeout(
    () => abortController.abort(),
    config.agentTimeoutMinutes * 60 * 1000,
  );

  try {
    let result = "";
    let sessionId = "";
    const response = claudeQuery({
      prompt,
      options: {
        cwd: config.agentCwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // "local" included: .claude/settings.local.json is where a host
        // operator most likely put their deny rules, and those are part of
        // the enforcement layer here.
        settingSources: ["user", "project", "local"],
        abortController,
        ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: options.systemPromptAppend,
        },
      },
    });
    try {
      for await (const message of response) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        } else if (message.type === "result") {
          // error_max_turns / error_during_execution etc. end the iteration
          // normally instead of throwing. Treating them as a completed run
          // would mark the mention handled with no reply ever posted, so they
          // must surface as failures for the caller's retry path.
          if (message.subtype !== "success") {
            throw new Error(`agent run ended with ${message.subtype}`);
          }
          result = message.result;
        }
      }
    } catch (error) {
      throw runError(error, sessionId !== "", sessionId || undefined);
    }
    return { result, sessionId };
  } finally {
    clearTimeout(timeoutId);
    liveAborts.delete(abortController);
  }
}
