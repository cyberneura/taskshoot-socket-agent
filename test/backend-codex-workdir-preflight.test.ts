/**
 * Own file: config snapshots the environment at import time, and this needs a
 * work directory inside a temporary directory with the default sandbox.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-codex-preflight-"));
const bin = path.join(dir, "fake-codex");

await writeFile(bin, `#!/usr/bin/env node\nprocess.stdout.write("codex-cli 0.160.0\\n");\n`);
await chmod(bin, 0o755);

process.env.TSSA_AGENT_BACKEND = "codex";
process.env.TSSA_CODEX_BIN = bin;
process.env.TSSA_CODEX_WORKDIR = path.join(dir, "workspace");
process.env.TSSA_STATE_DIR = dir;
delete process.env.TSSA_CODEX_SANDBOX;

const { preflightCodex } = await import("../src/backends/codex.js");

test("startup refuses a work directory the sandbox could replace", async () => {
  // Arrange
  // The run may write in tmpdir(), so it could rename the work directory and
  // leave a link in its place for the next, unsandboxed policy install.

  // Act
  const startup = preflightCodex();

  // Assert
  await assert.rejects(startup, /TSSA_CODEX_WORKDIR must not be inside/);
});
