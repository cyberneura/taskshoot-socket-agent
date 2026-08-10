import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The config module reads the environment at import time, so the state dir
// has to be pinned before anything imports it.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tssa-state-test-"));
process.env.TSSA_STATE_DIR = stateDir;

const { State } = await import("../src/state.js");

function freshDir(): void {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
}

test("the handled ledger survives a restart", () => {
  // Arrange
  freshDir();
  const first = new State();
  // Act
  first.markHandled("n-1");
  const second = new State();
  // Assert
  assert.equal(second.isHandled("n-1"), true);
  assert.equal(second.isHandled("n-2"), false);
});

test("first run is detected only once persist() has written the file", () => {
  // Arrange
  freshDir();
  // Act / Assert: no file yet
  const first = new State();
  assert.equal(first.isFirstRun, true);
  // Act: an empty seed still persists (nothing was marked handled)
  first.persist();
  // Assert: the next start is no longer a first run
  const second = new State();
  assert.equal(second.isFirstRun, false);
});

test("a corrupt state file is moved aside and treated as a first run", () => {
  // Arrange
  freshDir();
  fs.writeFileSync(path.join(stateDir, "state.json"), "{not json");
  // Act
  const state = new State();
  // Assert
  assert.equal(state.isFirstRun, true);
  const backups = fs.readdirSync(stateDir).filter((f) => f.includes("corrupt"));
  assert.equal(backups.length, 1);
});

test("sessions are capped and evict the oldest task", () => {
  // Arrange
  freshDir();
  const state = new State();
  // Act: one more session than the cap (200)
  for (let i = 0; i < 201; i++) {
    state.saveSession(`task-${i}`, `session-${i}`);
  }
  // Assert
  assert.equal(state.sessionFor("task-0"), undefined);
  assert.equal(state.sessionFor("task-200"), "session-200");
});
