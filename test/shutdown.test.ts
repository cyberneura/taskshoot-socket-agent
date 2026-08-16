/**
 * Own file: the shutdown module installs process-wide signal handlers and
 * latches, so it must not leak into other suites.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-shutdown-"));

process.env.TSSA_AGENT_BACKEND = "hermes";
// Never spawned: the run must be refused before it gets this far.
process.env.TSSA_HERMES_BIN = path.join(dir, "unused");
process.env.TSSA_HERMES_WORKDIR = path.join(dir, "workspace");
process.env.TSSA_STATE_DIR = dir;

const { isShuttingDown, onShutdown } = await import("../src/shutdown.js");
const { runHermes } = await import("../src/backends/hermes.js");

test("a stop signal closes the intake, then escalates before exiting", async () => {
  // Arrange
  const phases: string[] = [];
  onShutdown((phase) => {
    phases.push(phase);
  });
  // Keep the process alive past the handler's exit timer; asserting on
  // process.exit is not the point here.
  const exit = process.exit;
  let exitCode: number | undefined;
  // @ts-expect-error test double
  process.exit = (code?: number) => {
    exitCode = code;
  };
  assert.equal(isShuttingDown(), false);

  // Act
  process.emit("SIGTERM");
  await new Promise((r) => setTimeout(r, 2_200));

  // Assert
  // Both phases matter: `stop` gives running work a chance to wind down, and
  // `force` is the only point guaranteed to run before exit — without it a
  // process ignoring SIGTERM outlives the daemon.
  assert.deepEqual(phases, ["stop", "force"]);
  assert.equal(isShuttingDown(), true);
  assert.equal(exitCode, 143);
  process.exit = exit;
});

test("no new run starts once shutdown began", async () => {
  // The daemon is already shutting down from the previous case.
  // Act
  const error = await runHermes("p", { systemPromptAppend: "policy" }).then(
    () => null,
    (thrown) => thrown,
  );

  // Assert
  // Starting here would risk posting a reply that the ledger never records,
  // which the restarted daemon would then post a second time.
  assert.ok(error, "the run must be refused");
  assert.match(error.message, /shutting down/);
  assert.equal(error.sessionEstablished, false);
});
