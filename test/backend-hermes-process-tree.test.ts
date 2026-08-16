/**
 * The grandchild case, in its own file so the fake binary can differ from the
 * other suites (`config` snapshots the environment at import time).
 *
 * A Hermes run spawns tool subprocesses. If one outlives Hermes holding the
 * inherited stdout pipe, `close` never fires — the run's promise would stay
 * pending and the daemon's serial queue would stop draining, which is worse
 * than the timeout it was meant to enforce.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-hermes-tree-"));
const bin = path.join(dir, "fake-hermes");
const grandchildPidFile = path.join(dir, "grandchild.pid");

/** Waits for a pid to disappear; returns whether it did. */
async function waitGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

// Leaves a detached grandchild that keeps stdout open, then exits non-zero.
await writeFile(
  bin,
  `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));
process.exit(Number(process.env.FAKE_HERMES_EXIT ?? "3"));
`,
);
await chmod(bin, 0o755);

process.env.TSSA_AGENT_BACKEND = "hermes";
process.env.TSSA_HERMES_BIN = bin;
process.env.TSSA_HERMES_WORKDIR = path.join(dir, "workspace");
process.env.TSSA_STATE_DIR = dir;

const { runHermes } = await import("../src/backends/hermes.js");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("settles and takes the tool subprocess down with it", async () => {
  // Act
  const error = await runHermes("p", { systemPromptAppend: "policy" }).then(
    () => null,
    (thrown) => thrown,
  );

  // Assert
  // Settling at all is the first assertion: without the exit-based fallback
  // the promise never settles, because the grandchild holds the pipe open.
  assert.ok(error, "a non-zero exit must reject");
  assert.match(error.message, /exited with/);

  // And the grandchild must be gone. Hermes exiting non-zero says nothing
  // about the tools it started, and as the group leader it takes none of them
  // with it — a survivor is an unattended --yolo process still free to post a
  // late comment while the backstop retries this mention.
  const { readFileSync } = await import("node:fs");
  const pid = Number(readFileSync(grandchildPidFile, "utf8"));
  assert.equal(await waitGone(pid), true, "the run's process group must not outlive it");
});

test("a clean exit also takes its tool subprocesses down", async () => {
  // Arrange
  // Hermes finishing successfully says nothing about the tools it started; a
  // background browser or shell left behind would keep acting unattended after
  // the mention is marked handled.
  process.env.FAKE_HERMES_EXIT = "0";

  // Act
  const run = await runHermes("p", { systemPromptAppend: "policy" });

  // Assert
  assert.match(run.sessionId, /^tssa-/);
  const { readFileSync } = await import("node:fs");
  const pid = Number(readFileSync(grandchildPidFile, "utf8"));
  assert.equal(await waitGone(pid), true, "a clean run must not leave descendants");
});
