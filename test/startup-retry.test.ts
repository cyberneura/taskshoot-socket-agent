/**
 * Startup retry of `whoAmI()` (CYBERNEURA-DEV-1062). A host reboot brought
 * the daemon up while the API still answered 503, and the immediate fatal
 * exit left it FATAL under supervisord. Transient failures must be retried;
 * authentication failures must still stop startup at once.
 *
 * Own file: the end-to-end cases need a fake `taskshoot` binary, and config
 * snapshots the environment at import time.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "tssa-whoami-"));
const bin = path.join(dir, "fake-taskshoot");

// Fails the first FAIL_TIMES calls with FAIL_STDERR (exit 1, like the real
// CLI's `error: {error:#}`), then prints the identity. The call count lives in
// a file because each attempt is a new process.
await writeFile(
  bin,
  `#!/usr/bin/env node
const fs = require("node:fs");
const counter = process.env.FAKE_COUNTER;
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
fs.writeFileSync(counter, String(n));
if (n <= Number(process.env.FAKE_FAIL_TIMES)) {
  process.stderr.write(process.env.FAKE_FAIL_STDERR + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ id: "bot-id", display_name: "Bot" }));
`,
);
await chmod(bin, 0o755);

process.env.TSSA_TASKSHOOT_BIN = bin;
process.env.TSSA_STATE_DIR = dir;

const { isTransientCliError, retryTransientCliErrors, whoAmI, STARTUP_RETRY_DEFAULTS } =
  await import("../src/taskshoot.js");

/** The shape `execFile` rejects with when the child exits non-zero. */
function cliFailure(stderr: string) {
  return Object.assign(new Error(`Command failed: taskshoot --json me\n${stderr}`), {
    code: 1,
    killed: false,
    signal: null,
    stderr,
  });
}

/** Retry options on a fake clock: sleeping advances time, nothing waits. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  return {
    sleeps,
    logs,
    options: {
      ...STARTUP_RETRY_DEFAULTS,
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
      log: (message: string) => logs.push(message),
    },
  };
}

test("server-side and connection failures are transient", () => {
  // Arrange
  const transient = [
    cliFailure("error: API error 503: <html>Service Temporarily Unavailable</html>"),
    cliFailure("error: API error 502: Bad Gateway"),
    cliFailure("error: API error 429: Too Many Requests"),
    cliFailure("error: API error 408: Request Timeout"),
    // Both observed in the log of the 2026-10-13 reboot.
    cliFailure(
      "error: request failed: error sending request for url (https://example.test/api/user/me): " +
        "client error (Connect): tcp connect error: Connection refused (os error 111)",
    ),
    cliFailure(
      "error: request failed: error sending request for url (https://example.test/api/user/me): " +
        "client error (Connect): invalid peer certificate: UnknownIssuer",
    ),
    // execFile's own timeout.
    Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null }),
  ];

  // Act / Assert
  for (const error of transient) {
    assert.equal(isTransientCliError(error), true, error.message);
  }
});

test("authentication, missing CLI and unknown failures are permanent", () => {
  // Arrange
  const permanent: unknown[] = [
    cliFailure("error: API error 401: Invalid API key"),
    cliFailure("error: API error 403: Forbidden"),
    cliFailure("error: API error 404: Not Found"),
    // No key configured: the CLI fails before any request is made.
    cliFailure("error: no API key configured. Run `taskshoot config` to set one"),
    // A 2xx body that is not JSON, parsed by this daemon.
    new SyntaxError("Unexpected token < in JSON at position 0"),
    Object.assign(new Error("spawn taskshoot ENOENT"), { code: "ENOENT" }),
    "not an error object",
    null,
  ];

  // Act / Assert
  for (const error of permanent) {
    assert.equal(isTransientCliError(error), false, String(error));
  }
});

test("a transient failure is retried with growing delays until it succeeds", async () => {
  // Arrange
  const clock = fakeClock();
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls <= 2) throw cliFailure("error: API error 503: down");
    return "ok";
  };

  // Act
  const result = await retryTransientCliErrors("taskshoot me", fn, clock.options);

  // Assert
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(clock.sleeps, [5_000, 10_000]);
  // One line per retry, carrying the CLI's reason rather than the stack.
  assert.equal(clock.logs.length, 2);
  assert.match(clock.logs[0]!, /taskshoot me failed \(attempt 1\): error: API error 503: down; retrying in 5s/);
});

test("an authentication failure is thrown at once without waiting", async () => {
  // Arrange
  const clock = fakeClock();
  const failure = cliFailure("error: API error 401: Invalid API key");
  let calls = 0;
  const fn = async () => {
    calls++;
    throw failure;
  };

  // Act
  const error = await retryTransientCliErrors("taskshoot me", fn, clock.options).then(
    () => null,
    (e: unknown) => e,
  );

  // Assert
  assert.equal(error, failure, "the original error reaches the fatal path");
  assert.equal(calls, 1);
  assert.deepEqual(clock.sleeps, []);
});

test("backoff is capped at 60s and gives up once the 15-minute budget is spent", async () => {
  // Arrange
  const clock = fakeClock();
  const failure = cliFailure("error: API error 503: down");
  let calls = 0;
  const fn = async () => {
    calls++;
    throw failure;
  };

  // Act
  const error = await retryTransientCliErrors("taskshoot me", fn, clock.options).then(
    () => null,
    (e: unknown) => e,
  );

  // Assert
  assert.equal(error, failure, "the last transient error is rethrown unchanged");
  assert.deepEqual(clock.sleeps.slice(0, 6), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  assert.ok(Math.max(...clock.sleeps) <= 60_000);
  // The final attempt lands exactly on the deadline, not a full delay past it.
  const total = clock.sleeps.reduce((a, b) => a + b, 0);
  assert.equal(total, 15 * 60_000);
  assert.equal(calls, clock.sleeps.length + 1);
  assert.match(clock.logs.at(-1)!, /giving up/);
});

test("whoAmI retries a 503 from the real CLI process and then authenticates", async (t) => {
  // Arrange
  const clock = fakeClock();
  process.env.FAKE_COUNTER = path.join(dir, "count-503");
  process.env.FAKE_FAIL_TIMES = "2";
  process.env.FAKE_FAIL_STDERR = "error: API error 503: <html>503 Service Temporarily Unavailable</html>";
  t.after(() => {
    delete process.env.FAKE_FAIL_TIMES;
  });

  // Act
  const me = await whoAmI(clock.options);

  // Assert
  assert.deepEqual(me, { id: "bot-id", display_name: "Bot" });
  assert.equal(clock.sleeps.length, 2);
});

test("whoAmI fails at once on a 401 from the real CLI process", async () => {
  // Arrange
  const clock = fakeClock();
  process.env.FAKE_COUNTER = path.join(dir, "count-401");
  process.env.FAKE_FAIL_TIMES = "100";
  process.env.FAKE_FAIL_STDERR = "error: API error 401: Invalid API key";

  // Act
  const error = await whoAmI(clock.options).then(
    () => null,
    (e: unknown) => e as Error,
  );

  // Assert
  assert.ok(error, "an authentication failure must stop startup");
  assert.match(error.message, /API error 401/);
  assert.deepEqual(clock.sleeps, []);
});
