/**
 * The contract every agent backend implements.
 *
 * One call = one mention answered. The backend is responsible for running an
 * agent that can use tools (it posts the reply itself via the `taskshoot`
 * CLI); the returned `result` is only a log line for the daemon.
 */

export interface AgentRunResult {
  result: string;
  /** Handle for continuing this conversation on the next mention in the same
   * task. Opaque to the daemon: the Claude backend returns an SDK session id,
   * the Hermes backend returns a session name it chose. Persisted per task and
   * handed back as `resumeSessionId`. */
  sessionId: string;
}

/** Attached to errors thrown out of a run: whether the session had already
 * initialized when the failure happened. A resume that failed BEFORE init is
 * "the stored session is unusable" and safe to retry fresh; a failure AFTER
 * init may have already posted a comment, so retrying it would double-reply. */
export interface RunError extends Error {
  sessionEstablished?: boolean;
  /** The session the failed run was using, when the backend knows it. The
   * daemon persists this so a retry continues the same conversation: a run
   * that failed after posting its comment would otherwise be retried in a
   * brand-new session, where the agent cannot see its own earlier reply and
   * posts a second one. */
  sessionId?: string;
}

export interface RunOptions {
  /** Operating policy for the responder. How it reaches the agent differs per
   * backend — see each implementation. */
  systemPromptAppend: string;
  resumeSessionId?: string;
}

export type AgentBackend = (prompt: string, options: RunOptions) => Promise<AgentRunResult>;

export function runError(
  error: unknown,
  sessionEstablished: boolean,
  sessionId?: string,
): RunError {
  const wrapped: RunError = error instanceof Error ? error : new Error(String(error));
  wrapped.sessionEstablished = sessionEstablished;
  if (sessionId) wrapped.sessionId = sessionId;
  return wrapped;
}
