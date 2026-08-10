import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPromptAppend, cliTaskRef } from "../src/prompt.js";
import type { Notification } from "../src/taskshoot.js";

function notification(task: Notification["task"]): Notification {
  return {
    id: "n-1",
    notification_type: "task_mentioned",
    title: "t",
    body: "b",
    read: false,
    created_at: "2026-08-10T00:00:00Z",
    task,
  };
}

test("cliTaskRef uses KEY-N for tracked and uuid --project for untracked tasks", () => {
  // Arrange
  const tracked = notification({
    id: "uuid-1",
    project_key: "DEV",
    number: 12,
    title: "t",
    org_code_name: "org",
    ref: "DEV-12",
    bot_ready: false,
  });
  const untracked = notification({ ...tracked.task!, number: null, ref: null });
  // Act / Assert
  assert.equal(cliTaskRef(tracked), "DEV-12");
  assert.equal(cliTaskRef(untracked), "uuid-1 --project DEV");
  assert.equal(cliTaskRef(notification(null)), null);
});

test("the system prompt carries the bot name and the site extra", () => {
  // Arrange / Act
  const prompt = buildSystemPromptAppend("millais", "EXTRA POLICY LINE");
  // Assert
  assert.ok(prompt.includes('"millais"'));
  assert.ok(prompt.includes("NO_REPLY"));
  assert.ok(prompt.endsWith("EXTRA POLICY LINE"));
});
