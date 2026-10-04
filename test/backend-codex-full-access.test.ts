/**
 * The non-default codex settings, in their own file because `config` snapshots
 * the environment at import time.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-codex-full-"));
const bin = path.join(dir, "fake-codex");
const argvFile = path.join(dir, "argv.json");

await writeFile(
  bin,
  `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
`,
);
await chmod(bin, 0o755);

process.env.TSSA_AGENT_BACKEND = "codex";
process.env.TSSA_CODEX_BIN = bin;
process.env.TSSA_CODEX_WORKDIR = path.join(dir, "workspace");
process.env.TSSA_STATE_DIR = dir;
process.env.TSSA_CODEX_SANDBOX = "danger-full-access";
process.env.TSSA_CODEX_MODEL = "some-model";

const { runCodex } = await import("../src/backends/codex.js");

test("danger-full-access drops the sandbox entirely and the model is passed through", async () => {
  // Arrange — the environment above

  // Act
  await runCodex("p", { systemPromptAppend: "policy" });

  // Assert
  const argv = JSON.parse(await readFile(argvFile, "utf8")) as string[];
  assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!argv.includes("--sandbox"), "the two are mutually exclusive");
  assert.equal(argv[argv.indexOf("--model") + 1], "some-model");
});
