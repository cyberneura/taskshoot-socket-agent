/**
 * The hermes backend is exercised through a fake `hermes` executable, so the
 * assertions cover what the daemon actually depends on: the argv it builds,
 * the policy file it leaves in the run directory, and how failures are
 * classified for the caller's retry path.
 *
 * `config` is read once at import time, so every case shares one environment
 * and the fake binary switches behaviour through FAKE_HERMES_MODE instead
 * (the child inherits the parent's env at spawn time).
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-hermes-"));
const workdir = path.join(dir, "workspace");
const bin = path.join(dir, "fake-hermes");
const argvFile = path.join(dir, "argv.json");

await writeFile(
  bin,
  `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}));
switch (process.env.FAKE_HERMES_MODE) {
  case "fail-quiet":
    process.stderr.write("boom");
    process.exit(3);
  default:
    process.stdout.write("done");
}
`,
);
await chmod(bin, 0o755);

process.env.TSSA_AGENT_BACKEND = "hermes";
process.env.TSSA_HERMES_BIN = bin;
process.env.TSSA_HERMES_WORKDIR = workdir;
process.env.TSSA_STATE_DIR = dir;

const { runHermes } = await import("../src/backends/hermes.js");

async function recordedRun() {
  return JSON.parse(await readFile(argvFile, "utf8")) as { argv: string[]; cwd: string };
}

test("names a new session, passes --yolo, and writes the policy into the run directory", async () => {
  // Arrange
  process.env.FAKE_HERMES_MODE = "ok";

  // Act
  const run = await runHermes("the prompt", { systemPromptAppend: "POLICY BODY" });

  // Assert
  const recorded = await recordedRun();
  assert.equal(recorded.argv[0], "-z");
  assert.equal(recorded.argv[1], "the prompt");
  assert.ok(recorded.argv.includes("--yolo"), "runs without tool confirmations");
  const sessionFlag = recorded.argv.indexOf("-c");
  assert.ok(sessionFlag !== -1, "names the session so it can be resumed");
  assert.equal(recorded.argv[sessionFlag + 1], run.sessionId);
  assert.match(run.sessionId, /^tssa-/);
  assert.equal(run.result, "done");

  const policy = await readFile(path.join(workdir, "AGENTS.md"), "utf8");
  assert.match(policy, /POLICY BODY/);
  // realpath on both sides: macOS resolves /var to /private/var for the child.
  assert.equal(await realpath(recorded.cwd), await realpath(workdir));
});

test("resumes the stored session instead of inventing a new one", async () => {
  // Arrange
  process.env.FAKE_HERMES_MODE = "ok";

  // Act
  const run = await runHermes("p", {
    systemPromptAppend: "policy",
    resumeSessionId: "tssa-existing",
  });

  // Assert
  const recorded = await recordedRun();
  assert.equal(recorded.argv[recorded.argv.indexOf("-c") + 1], "tssa-existing");
  assert.equal(run.sessionId, "tssa-existing");
});

test("a run that started is never retried, even when it produced no output", async () => {
  // Arrange
  // `hermes -z` prints its answer only at the end, so a run that posted its
  // comment and then failed emits nothing. Treating silence as "the session
  // never established" would make the daemon re-run the mention and reply
  // twice, so anything past a successful spawn counts as established.
  process.env.FAKE_HERMES_MODE = "fail-quiet";

  // Act
  const error = await runHermes("p", { systemPromptAppend: "policy" }).then(
    () => null,
    (thrown) => thrown,
  );

  // Assert
  assert.ok(error, "a non-zero exit must reject");
  assert.equal(error.sessionEstablished, true);
  assert.match(error.message, /boom/);
});
