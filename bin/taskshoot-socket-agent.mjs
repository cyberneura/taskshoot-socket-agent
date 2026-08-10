#!/usr/bin/env node
/**
 * Installed entry point (`bin` in package.json). Kept as a hand-written
 * wrapper rather than a shebang in src/main.ts so that `--version` /
 * `--help` answer without importing the daemon — importing dist/main.js
 * starts it (it takes the single-instance lock and connects immediately),
 * so there would otherwise be no safe way to smoke-test an install.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`taskshoot-socket-agent ${pkg.version}

Answers Taskshoot mentions in near real time: subscribes to the notification
WebSocket via \`taskshoot listen\` and runs one Claude Agent SDK session per
mention. Takes no arguments — it is configured entirely through environment
variables and runs until stopped.

Usage:
  taskshoot-socket-agent          start the daemon (foreground)
  taskshoot-socket-agent --help
  taskshoot-socket-agent --version

Environment:
  TSSA_NOTIFICATION_TYPES   notification types to subscribe to (task_mentioned)
  TSSA_POLL_MINUTES         polling backstop interval (30)
  TSSA_AGENT_TIMEOUT_MINUTES  hard timeout for one agent run (20)
  TSSA_AGENT_CWD            working directory for the agent (~/workspace)
  TSSA_STATE_DIR            session ids + handled-notification ledger
  TSSA_TASKSHOOT_BIN        the taskshoot CLI binary (taskshoot)
  TSSA_EXTRA_SYSTEM_PROMPT  site policy appended to the agent's system prompt

Requires the \`taskshoot\` CLI (>= 0.7.0, authenticated) and Claude Code on
PATH. Full documentation: ${pkg.homepage ?? pkg.repository?.url ?? ""}`);
  process.exit(0);
}

if (args.length > 0) {
  console.error(`unknown argument: ${args[0]} (try --help)`);
  process.exit(2);
}

try {
  await import("../dist/main.js");
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      "taskshoot-socket-agent is not built: run `pnpm install && pnpm build` in the source checkout.",
    );
    process.exit(1);
  }
  throw error;
}
