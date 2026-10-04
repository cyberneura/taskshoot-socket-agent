/**
 * The codex backend is exercised through a fake `codex` executable that prints
 * what the real CLI was observed to print (codex-cli 0.151): JSON Lines on
 * stdout for a run that started its thread, and a bare error on stderr for a
 * resume that could not find the session.
 *
 * `config` is read once at import time, so every case shares one environment
 * and the fake binary switches behaviour through FAKE_CODEX_MODE instead.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-codex-"));
const workdir = path.join(dir, "workspace");
const bin = path.join(dir, "fake-codex");
const argvFile = path.join(dir, "argv.json");

await writeFile(
  bin,
  `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv, cwd: process.cwd() }));
const resume = argv.indexOf("resume");
const threadId = resume === -1 ? "thread-new" : argv[resume + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
switch (process.env.FAKE_CODEX_MODE) {
  case "resume-gone":
    process.stderr.write("Error: thread/resume: thread/resume failed: no rollout found for thread id " + threadId + " (code -32600)\\n");
    process.exit(1);
  case "resume-busy":
    process.stderr.write("Error: thread/resume: thread/resume failed: thread " + threadId + " already has an active writer\\n");
    process.exit(1);
  case "stream-error-exit-0":
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    emit({ type: "error", message: "stream disconnected before completion" });
    process.exit(0);
  case "recovered-error":
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    emit({ type: "error", message: "Reconnecting... 1/5" });
    emit({ type: "item.completed", item: { type: "agent_message", text: "replied after reconnect" } });
    emit({ type: "turn.completed" });
    break;
  case "dead-before-thread":
    process.stderr.write("boom\\n");
    process.exit(1);
  case "turn-failed":
  case "turn-failed-exit-0":
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    emit({ type: "turn.failed", error: { message: "model rejected" } });
    process.exit(process.env.FAKE_CODEX_MODE === "turn-failed" ? 1 : 0);
  default:
    emit({ type: "thread.started", thread_id: threadId });
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { type: "agent_message", text: "thinking aloud" } });
    emit({ type: "item.completed", item: { type: "command_execution", command: "taskshoot task comment" } });
    emit({ type: "item.completed", item: { type: "agent_message", text: "replied" } });
    emit({ type: "turn.completed" });
}
`,
);
await chmod(bin, 0o755);

process.env.TSSA_AGENT_BACKEND = "codex";
process.env.TSSA_CODEX_BIN = bin;
process.env.TSSA_CODEX_WORKDIR = workdir;
process.env.TSSA_STATE_DIR = dir;
delete process.env.TSSA_CODEX_SANDBOX;
delete process.env.TSSA_CODEX_MODEL;

const { runCodex } = await import("../src/backends/codex.js");

async function recordedRun() {
  return JSON.parse(await readFile(argvFile, "utf8")) as { argv: string[]; cwd: string };
}

async function failure(run: Promise<unknown>) {
  return await run.then(
    () => null,
    (thrown) => thrown,
  );
}

test("starts a session, takes its id from thread.started, and writes the policy into the run directory", async () => {
  // Arrange
  process.env.FAKE_CODEX_MODE = "ok";

  // Act
  const run = await runCodex("the prompt", { systemPromptAppend: "POLICY BODY" });

  // Assert
  const recorded = await recordedRun();
  assert.equal(recorded.argv[0], "exec");
  assert.ok(recorded.argv.includes("--json"), "the session id is only in the event stream");
  assert.ok(recorded.argv.includes("--skip-git-repo-check"), "the run directory is not a repository");
  assert.ok(!recorded.argv.includes("resume"));
  assert.equal(recorded.argv.at(-1), "the prompt");
  assert.equal(run.sessionId, "thread-new");
  // The last agent message is the answer; earlier ones are narration.
  assert.equal(run.result, "replied");

  const policy = await readFile(path.join(workdir, "AGENTS.md"), "utf8");
  assert.match(policy, /POLICY BODY/);
  // realpath on both sides: macOS resolves /var to /private/var for the child.
  assert.equal(await realpath(recorded.cwd), await realpath(workdir));
});

test("sandboxes writes by default but leaves the network open for the taskshoot CLI", async () => {
  // Arrange
  process.env.FAKE_CODEX_MODE = "ok";

  // Act
  await runCodex("p", { systemPromptAppend: "policy" });

  // Assert
  const { argv } = await recordedRun();
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(argv.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(
    argv.includes("sandbox_workspace_write.writable_roots=[]"),
    "writable roots from the host's codex config must not be inherited",
  );
  assert.ok(!argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!argv.includes("--model"), "an unset model is left to the host's codex config");
});

test("resumes the stored session, with the options ahead of the subcommand", async () => {
  // Arrange
  process.env.FAKE_CODEX_MODE = "ok";

  // Act
  const run = await runCodex("next prompt", {
    systemPromptAppend: "policy",
    resumeSessionId: "thread-stored",
  });

  // Assert
  const { argv } = await recordedRun();
  const resume = argv.indexOf("resume");
  assert.deepEqual(argv.slice(resume), ["resume", "thread-stored", "next prompt"]);
  // `codex exec [OPTIONS] resume ...`: an option after the subcommand would be
  // read as part of the prompt.
  assert.ok(argv.indexOf("--json") < resume);
  assert.ok(argv.indexOf("--sandbox") < resume);
  assert.equal(run.sessionId, "thread-stored");
});

test("a resume of a session codex no longer has is reported as unusable, so the mention is retried fresh", async () => {
  // Arrange
  process.env.FAKE_CODEX_MODE = "resume-gone";

  // Act
  const error = await failure(
    runCodex("p", { systemPromptAppend: "policy", resumeSessionId: "thread-lost" }),
  );

  // Assert
  assert.ok(error, "exit 1 must reject");
  assert.equal(error.sessionUnusable, true);
  assert.equal(error.sessionEstablished, false);
  assert.equal(error.sessionId, undefined);
});

test("a resume refused because an earlier run still holds the thread keeps the stored session", async () => {
  // Arrange
  // After an abrupt daemon death the previous codex process can still be
  // writing the thread. Starting fresh here would run a second agent next to
  // it, and both could post.
  process.env.FAKE_CODEX_MODE = "resume-busy";

  // Act
  const error = await failure(
    runCodex("p", { systemPromptAppend: "policy", resumeSessionId: "thread-stored" }),
  );

  // Assert
  assert.ok(error);
  assert.notEqual(error.sessionUnusable, true);
});

test("a resume that died for another reason keeps the stored session", async () => {
  // Arrange
  // An expired login or a crash at startup also ends before thread.started.
  // Calling that "unusable" would replace a valid conversation with an empty
  // one on the retry.
  process.env.FAKE_CODEX_MODE = "dead-before-thread";

  // Act
  const error = await failure(
    runCodex("p", { systemPromptAppend: "policy", resumeSessionId: "thread-stored" }),
  );

  // Assert
  assert.ok(error);
  assert.notEqual(error.sessionUnusable, true);
  assert.equal(error.sessionEstablished, false);
  assert.match(error.message, /boom/);
});

test("a turn that failed after the thread started reports its session, so a retry can continue it", async () => {
  // Arrange
  // The first mention on a task has no stored session; the id exists only in
  // the failed run's output. A retry without it could not see a reply the run
  // may already have posted.
  process.env.FAKE_CODEX_MODE = "turn-failed";

  // Act
  const error = await failure(runCodex("p", { systemPromptAppend: "policy" }));

  // Assert
  assert.ok(error);
  assert.equal(error.sessionEstablished, true);
  assert.equal(error.sessionId, "thread-new");
  assert.notEqual(error.sessionUnusable, true);
});

test("a stream error that ends the run without a turn outcome is a failed run, even on exit 0", async () => {
  // Arrange
  process.env.FAKE_CODEX_MODE = "stream-error-exit-0";

  // Act
  const error = await failure(runCodex("p", { systemPromptAppend: "policy" }));

  // Assert
  assert.ok(error, "resolving would mark an unanswered mention as handled");
  assert.match(error.message, /stream disconnected/);
  assert.equal(error.sessionEstablished, true);
  assert.equal(error.sessionId, "thread-new");
});

test("an error event the run recovered from does not fail it", async () => {
  // Arrange
  // Codex reports a dropped connection as an error event and then carries on.
  // Failing here would re-run a mention that was answered.
  process.env.FAKE_CODEX_MODE = "recovered-error";

  // Act
  const run = await runCodex("p", { systemPromptAppend: "policy" });

  // Assert
  assert.equal(run.result, "replied after reconnect");
});

test("a failed turn is a failed run even when codex exits 0", async () => {
  // Arrange
  process.env.FAKE_CODEX_MODE = "turn-failed-exit-0";

  // Act
  const error = await failure(runCodex("p", { systemPromptAppend: "policy" }));

  // Assert
  assert.ok(error, "resolving would mark an unanswered mention as handled");
  assert.match(error.message, /model rejected/);
  assert.equal(error.sessionId, "thread-new");
});
