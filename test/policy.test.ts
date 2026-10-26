import assert from "node:assert/strict";
import { test } from "node:test";

import { effectivePolicy } from "../src/runner.js";

test("codex under workspace-write is given the safe policy", () => {
  // Arrange / Act
  // The sandbox blocks writes outside the run directory, so work it was told
  // it may do would only fail halfway.
  const policy = effectivePolicy("work", "codex", "workspace-write");

  // Assert
  assert.equal(policy, "safe");
});

test("the work policy reaches backends that can write", () => {
  // Arrange / Act / Assert
  assert.equal(effectivePolicy("work", "codex", "danger-full-access"), "work");
  assert.equal(effectivePolicy("work", "claude", "workspace-write"), "work");
  assert.equal(effectivePolicy("work", "hermes", "workspace-write"), "work");
});

test("safe is never widened", () => {
  // Arrange / Act / Assert
  assert.equal(effectivePolicy("safe", "claude", "workspace-write"), "safe");
  assert.equal(effectivePolicy("safe", "codex", "danger-full-access"), "safe");
});
