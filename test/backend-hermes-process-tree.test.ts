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
process.exit(3);
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

test("settles even when a tool subprocess outlives hermes holding the pipe", async () => {
  // Act
  const error = await runHermes("p", { systemPromptAppend: "policy" }).then(
    () => null,
    (thrown) => thrown,
  );

  // Assert
  // Reaching this line at all is the assertion that matters: without the
  // exit-based fallback the promise would never settle.
  assert.ok(error, "a non-zero exit must reject");
  assert.match(error.message, /exited with/);

  // Clean up the grandchild this test deliberately leaked.
  const { readFileSync } = await import("node:fs");
  const pid = Number(readFileSync(grandchildPidFile, "utf8"));
  if (alive(pid)) process.kill(pid, "SIGKILL");
});
