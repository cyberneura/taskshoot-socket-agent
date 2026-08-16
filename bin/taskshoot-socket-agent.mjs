#!/usr/bin/env node
/**
 * Installed entry point (`bin` in package.json). Kept as a hand-written
 * wrapper rather than a shebang in src/main.ts so that `--version` /
 * `--help` answer without importing the daemon — importing dist/main.js
 * starts it (it takes the single-instance lock and connects immediately),
 * so there would otherwise be no safe way to smoke-test an install.
 */
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const distMain = new URL("../dist/main.js", import.meta.url);

/** An install can silently skip the compile step (pnpm without
 * `--allow-build`, npm installing a git url globally), leaving a linked
 * executable with nothing behind it. `--version` therefore doubles as the
 * install check — it is the only invocation that can be run safely, since
 * starting the daemon takes the single-instance lock and connects. */
const NOT_BUILT =
  "taskshoot-socket-agent is installed but not built (dist/ is missing).\n" +
  "Reinstall allowing the build step:\n" +
  "  pnpm add -g --allow-build=taskshoot-socket-agent github:cyberneura/taskshoot-socket-agent\n" +
  "From a source checkout: pnpm install && pnpm build";

if (args.includes("--version") || args.includes("-V")) {
  console.log(pkg.version);
  if (!existsSync(distMain)) {
    console.error(NOT_BUILT);
    process.exit(1);
  }
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`taskshoot-socket-agent ${pkg.version}

Answers Taskshoot mentions in near real time: subscribes to the notification
WebSocket via \`taskshoot listen\` and runs one agent per mention. Takes no
arguments — it is configured entirely through environment variables and runs
until stopped.

Usage:
  taskshoot-socket-agent          start the daemon (foreground)
  taskshoot-socket-agent --help
  taskshoot-socket-agent --version

Environment:
  TSSA_NOTIFICATION_TYPES   notification types to subscribe to (task_mentioned)
  TSSA_POLL_MINUTES         polling backstop interval (30)
  TSSA_AGENT_BACKEND        which agent answers: claude | hermes (claude)
  TSSA_AGENT_TIMEOUT_MINUTES  hard timeout for one agent run (20)
  TSSA_AGENT_CWD            working directory for the agent, backend claude
                            only (~/workspace)
  TSSA_HERMES_BIN           the hermes CLI binary, backend hermes (hermes)
  TSSA_HERMES_WORKDIR       run directory for backend hermes; it owns the
                            AGENTS.md there (<state dir>/hermes-workspace)
  TSSA_STATE_DIR            session ids + handled-notification ledger
  TSSA_TASKSHOOT_BIN        the taskshoot CLI binary (taskshoot)
  TSSA_EXTRA_SYSTEM_PROMPT  site policy appended to the agent's operating policy

Requires the \`taskshoot\` CLI (>= 0.7.0, authenticated) on PATH, plus the
agent for the chosen backend: Claude Code (claude) or the hermes CLI (hermes).

SECURITY: the agent runs unattended with tools auto-approved. On backend
hermes there are no deny lists at all — host isolation is the only boundary.
Full documentation: ${pkg.homepage ?? pkg.repository?.url ?? ""}`);
  process.exit(0);
}

if (args.length > 0) {
  console.error(`unknown argument: ${args[0]} (try --help)`);
  process.exit(2);
}

if (!existsSync(distMain)) {
  console.error(NOT_BUILT);
  process.exit(1);
}

await import("../dist/main.js");
