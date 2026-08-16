/**
 * Own file: the preflight timeout is a startup-path concern and needs its own
 * `hermes` binary (config snapshots the environment at import time).
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-preflight-"));
const bin = path.join(dir, "hanging-hermes");

// Never answers --version.
await writeFile(bin, `#!/usr/bin/env node\nsetTimeout(() => {}, 120000);\n`);
await chmod(bin, 0o755);

process.env.TSSA_AGENT_BACKEND = "hermes";
process.env.TSSA_HERMES_BIN = bin;
process.env.TSSA_HERMES_WORKDIR = path.join(dir, "workspace");
process.env.TSSA_STATE_DIR = dir;

const { preflightHermes } = await import("../src/backends/hermes.js");

test("a hanging --version fails startup instead of blocking it forever", async (t) => {
  // Arrange
  t.mock.timers.enable({ apis: ["setTimeout"] });

  // Act
  const failure = preflightHermes().then(
    () => null,
    (error) => error,
  );
  t.mock.timers.tick(30_000);
  const error = await failure;

  // Assert
  // Blocking here would leave the daemon alive to its supervisor while it
  // answered nothing — worse to notice than a crash loop.
  assert.ok(error, "startup must not hang");
  assert.match(error.message, /did not finish within/);
});
