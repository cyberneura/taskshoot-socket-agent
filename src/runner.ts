/**
 * One Claude Agent SDK run per mention.
 *
 * The daemon runs unattended on a host the operator has dedicated to the bot,
 * so tool approvals cannot be interactive (there is no human at the prompt):
 * permissionMode bypass, plus a PreToolUse hook as a belt-and-braces answer
 * for any approval prompt that still surfaces while running unattended.
 *
 * SECURITY: bypassing permissions means a prompt injection in a task thread
 * can steer the agent. The system-prompt policy is guidance, not enforcement;
 * enforcement is the host's Claude settings deny lists (all of user /
 * project / local settings are loaded) and host isolation. See the README
 * before deploying this anywhere.
 */
import {
  query as claudeQuery,
  type HookCallback,
} from "@anthropic-ai/claude-agent-sdk";

import { config } from "./config.js";

const approveUnattendedToolUse: HookCallback = async () => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason:
      "taskshoot-socket-agent runs unattended; tool policy is enforced by host settings.",
  },
});

export interface AgentRunResult {
  result: string;
  sessionId: string;
}

/** Attached to errors thrown out of a run: whether the session had already
 * initialized when the failure happened. A resume that failed BEFORE init is
 * "the stored session is unusable" and safe to retry fresh; a failure AFTER
 * init may have already posted a comment, so retrying it would double-reply. */
export interface RunError extends Error {
  sessionEstablished?: boolean;
}

export async function runAgent(
  prompt: string,
  options: { systemPromptAppend: string; resumeSessionId?: string },
): Promise<AgentRunResult> {
  const abortController = new AbortController();
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
        hooks: { PreToolUse: [{ hooks: [approveUnattendedToolUse] }] },
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
      const runError: RunError =
        error instanceof Error ? error : new Error(String(error));
      runError.sessionEstablished = sessionId !== "";
      throw runError;
    }
    return { result, sessionId };
  } finally {
    clearTimeout(timeoutId);
  }
}
