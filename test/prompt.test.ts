import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPromptAppend, cliTaskRef } from "../src/prompt.js";
import { cliTaskArgs } from "../src/taskshoot.js";
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

test("cliTaskArgs mirrors cliTaskRef as argv (tracked / untracked / no task)", () => {
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
  assert.deepEqual(cliTaskArgs(tracked), ["DEV-12"]);
  assert.deepEqual(cliTaskArgs(untracked), ["uuid-1", "--project", "DEV"]);
  assert.equal(cliTaskArgs(notification(null)), null);
});

test("the system prompt tells the responder to carry knowledge through the thread", () => {
  // Arrange / Act
  const prompt = buildSystemPromptAppend("millais", "");
  // Assert
  assert.ok(prompt.includes("Carrying knowledge forward"));
  // Reading the thread back is the half that saves rework, and it has to cover
  // every author: a task handed over by another agent carries its findings
  // under that agent's name, so a self-only read misses the actual handoff.
  assert.ok(prompt.includes("not only your own"));
  // The note has to ride along in the one reply it already posts. Without
  // this the instruction fights the reply policy: a second comment breaks
  // "at most ONE reply", and a note on a NO_REPLY mention breaks the silence.
  assert.ok(prompt.includes("do not add a second comment"));
  assert.ok(prompt.includes("NO_REPLY means silence"));
  // "don't repeat yourself" must not turn into "don't answer again". A repeat
  // request while the task is still unassigned needs the same answer as last
  // time; staying silent would leave the requester with nothing.
  assert.ok(prompt.includes("not about withholding replies"));
});

test("a backend note sits between the shared policy and the site policy", () => {
  // Arrange / Act
  const prompt = buildSystemPromptAppend("millais", "SITE POLICY", "BACKEND NOTE");

  // Assert
  // The site policy is configured per host and has to stay the last word: a
  // backend note placed after it would silently override a site restriction.
  assert.ok(prompt.indexOf("BACKEND NOTE") > prompt.indexOf("Taskshoot mention responder"));
  assert.ok(prompt.indexOf("SITE POLICY") > prompt.indexOf("BACKEND NOTE"));
  assert.ok(prompt.trimEnd().endsWith("SITE POLICY"));
});

test("omitting the backend note leaves the prompt unchanged", () => {
  // Arrange / Act
  // The backend that needs no clarification must see byte-identical text.
  const withNote = buildSystemPromptAppend("millais", "SITE POLICY", "");
  const without = buildSystemPromptAppend("millais", "SITE POLICY");

  // Assert
  assert.equal(withNote, without);
});

test("the system prompt carries the bot name and the site extra", () => {
  // Arrange / Act
  const prompt = buildSystemPromptAppend("millais", "EXTRA POLICY LINE");
  // Assert
  assert.ok(prompt.includes('"millais"'));
  assert.ok(prompt.includes("NO_REPLY"));
  assert.ok(prompt.endsWith("EXTRA POLICY LINE"));
});
