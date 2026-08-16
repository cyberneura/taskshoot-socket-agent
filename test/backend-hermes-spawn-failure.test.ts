/**
 * Separate file because `config` snapshots the environment at import time:
 * pointing the backend at a missing binary has to happen before the module is
 * loaded, and node:test gives each file its own process.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-hermes-spawn-"));

process.env.TSSA_AGENT_BACKEND = "hermes";
process.env.TSSA_HERMES_BIN = path.join(dir, "does-not-exist");
process.env.TSSA_HERMES_WORKDIR = path.join(dir, "workspace");
process.env.TSSA_STATE_DIR = dir;

const { runHermes } = await import("../src/backends/hermes.js");

test("a binary that cannot be spawned is retryable", async () => {
  // Act
  const error = await runHermes("p", { systemPromptAppend: "policy" }).then(
    () => null,
    (thrown) => thrown,
  );

  // Assert
  // Nothing ran, so no comment can have been posted — the only case where a
  // fresh retry is safe.
  assert.ok(error, "a spawn failure must reject");
  assert.equal(error.sessionEstablished, false);
});
