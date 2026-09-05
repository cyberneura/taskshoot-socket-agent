import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { captureError, flushSentry, initSentry } from "../src/sentry.js";

/**
 * Two things are being protected here.
 *
 * 1. The *off* path. Reporting is opt-in. A helper that throws, or that loads
 *    the SDK when nobody asked for it, would add a way for the daemon to fall
 *    over — or to fall over differently — on hosts that never configured it.
 *
 * 2. That turning reporting *on* does not change how the process behaves. The
 *    SDK's defaults change it in four ways and reporting itself adds a fifth
 *    (see `src/sentry.ts`); each was confirmed by measurement, not only by
 *    reading, so each has a test that runs the real thing.
 *
 * The behavioural cases run in child processes on purpose: they depend on
 * process-level listeners and on module state that `Sentry.init` installs
 * globally, neither of which can be undone from inside the test process.
 *
 * The DSN points at `127.0.0.1:1` so that nothing here depends on name
 * resolution or on reaching Sentry; the transport fails locally and the SDK
 * swallows it.
 */
const TEST_DSN = "https://0123456789abcdef0123456789abcdef@127.0.0.1:1/1";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Exactly what the daemon should end up with: the 17 SDK defaults minus the
 * nine suppressed in `src/sentry.ts`. Asserted as a set so that a rename or an
 * addition upstream fails here rather than quietly changing what runs.
 */
const EXPECTED_INTEGRATIONS = [
  "Context",
  "ConversationId",
  "FunctionToString",
  "Http",
  "InboundFilters",
  "LinkedErrors",
  "NodeFetch",
  "RequestData",
];

/**
 * A DSN pointing at a socket that accepts and never answers.
 *
 * `TEST_DSN` refuses instantly, which makes the flush finish in milliseconds —
 * fine for "did it exit", useless for "what was true *while* it was flushing".
 * With a black hole the flush runs for its full timeout, so a timer inside the
 * child gets to observe the window.
 */
async function withBlackHoleDsn<T>(
  body: (dsn: string) => T | Promise<T>,
): Promise<T> {
  const net = await import("node:net");
  const server = net.createServer((socket) => {
    // Accept, then never respond. The error listener is for the moment the
    // child exits mid-handshake: without it the reset would surface as an
    // uncaught exception in the test process.
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    return await body(
      `https://0123456789abcdef0123456789abcdef@127.0.0.1:${port}/1`,
    );
  } finally {
    server.close();
  }
}

/**
 * Run `script` in a child process, optionally with reporting enabled.
 *
 * The timeout matters: the liveness timer inside the child is only registered
 * after `initSentry` returns, so a child that stalls before that would block
 * `spawnSync` — and with the parent blocked, the black-hole server's `finally`
 * would never run either.
 */
function runChild(
  script: string,
  withSentry: boolean,
  dsn: string = TEST_DSN,
  env: NodeJS.ProcessEnv = {},
) {
  // `initSentry` swallows its own failures, so "it returned" proves nothing.
  // The marker is printed only when a client exists *and has a transport*: a
  // client built from a rejected DSN exists too, with `enabled` still unset,
  // so checking the option would pass for a client that can send nothing.
  const prelude = withSentry
    ? `import { initSentry } from "./src/sentry.js";` +
      `await initSentry(${JSON.stringify(dsn)}, "test");` +
      `{ const s = await import("@sentry/node");` +
      `  const c = s.getClient();` +
      `  if (c && c.getTransport()) console.log("SENTRY_READY"); }`
    : "";
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", prelude + script],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 20_000,
      // The `NODE_DEBUG=esm` trace with the SDK loaded is a few megabytes;
      // the default 1 MB would fail that case with ENOBUFS instead of with
      // the assertion it is meant to fail with.
      maxBuffer: 64 * 1024 * 1024,
      // A proxy in the parent's environment would take the transport off the
      // loopback DSN and onto the network, and the black-hole timings with
      // it. The SDK honours `http_proxy` even for an https DSN.
      env: {
        ...process.env,
        https_proxy: "",
        http_proxy: "",
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        ...env,
      },
    },
  );
}

/**
 * Assert that a failure mode kills the process the same way with and without
 * reporting enabled.
 *
 * `SURVIVED` on stdout means the script's timer ran, i.e. the process outlived
 * the failure. The exit codes are compared as well, and `marker` — a string
 * from the intended error — must appear on both children's stderr: a child
 * that died for an unrelated reason (a module that failed to load, say) exits
 * 1 just like the intended failure would, so the exit code alone cannot tell
 * them apart. An earlier version of this test had exactly that false positive.
 */
function assertSameFatalBehaviour(name: string, script: string, marker: string) {
  const withTimer = `${script} setTimeout(() => { console.log("SURVIVED"); process.exit(7); }, 3000);`;
  const off = runChild(withTimer, false);
  const on = runChild(withTimer, true);

  assert.equal(off.error, undefined, `${name}: child failed to start (off)`);
  assert.equal(on.error, undefined, `${name}: child failed to start (on)`);
  assert.ok(
    on.stdout.includes("SENTRY_READY"),
    `${name}: reporting never initialised, so this proves nothing`,
  );
  assert.ok(
    off.stderr.includes(marker) && on.stderr.includes(marker),
    `${name}: the intended failure did not happen (off: ${off.stderr.slice(-300)} | on: ${on.stderr.slice(-300)})`,
  );
  assert.ok(
    !off.stdout.includes("SURVIVED"),
    `${name}: the process is expected to die without reporting`,
  );
  assert.ok(
    !on.stdout.includes("SURVIVED"),
    `${name}: enabling reporting must not keep the process alive`,
  );
  assert.equal(
    on.status,
    off.status,
    `${name}: exit code changed when reporting was enabled`,
  );
}

test("with no DSN, every entry point is a silent no-op", async () => {
  // Arrange / Act — none of these may throw, and a flush must not wait for its
  // timeout when there is no client to flush.
  await initSentry("", "");
  captureError("test", new Error("boom"));
  const started = Date.now();
  await flushSentry(30_000);

  // Assert
  assert.ok(
    Date.now() - started < 1_000,
    "flushSentry must return immediately when reporting is disabled",
  );
});

test("with no DSN, the SDK is not loaded at all", () => {
  // `NODE_DEBUG=esm` makes the loader trace every resolution to stderr. The
  // trace for our own module is asserted first: without it, an empty trace
  // (the variable renamed upstream, say) would pass this for the wrong reason.
  const result = runChild(
    `const { initSentry, captureError, flushSentry } = await import("./src/sentry.js");` +
      `await initSentry("", ""); captureError("test", new Error("boom"));` +
      `await flushSentry(); process.exit(0);`,
    false,
    TEST_DSN,
    { NODE_DEBUG: "esm" },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.slice(-2000));
  assert.ok(
    result.stderr.includes("src/sentry"),
    "the loader trace is empty, so this proves nothing",
  );
  assert.ok(
    !result.stderr.includes("@sentry/"),
    "the SDK was loaded without a DSN",
  );
});

test("events do not carry spawn arguments or captured object values", async () => {
  // Two SDK paths copy data wholesale into the event: `NodeSystemError` puts a
  // system error's own properties (for `spawn`, including `spawnargs`) into a
  // context, and a plain object captured as an exception is serialised into
  // `extra.__serialized__`. The hermes backend passes the prompt as an
  // argument, so the first of these would ship task content. Both values are
  // planted and must not appear anywhere in the outgoing event. The object's
  // `message` is planted too and is expected *in* the event: it becomes the
  // exception text, as any error's message would, and seeing it there shows
  // the event was inspected after the SDK built it rather than before.
  const result = await withBlackHoleDsn((dsn) =>
    runChild(
      `const sdk = await import("@sentry/node");` +
        `sdk.getClient().on("beforeSendEvent", (ev) => console.log("EVENT:" + JSON.stringify(ev)));` +
        `const { spawn } = await import("node:child_process");` +
        `const c = spawn("/nonexistent/hermes", ["-z", "PLANTED_PROMPT"]);` +
        `c.on("error", (e) => sdk.captureException(e));` +
        `sdk.captureException({ message: "PLANTED_MESSAGE", api_key: "PLANTED_VALUE" });` +
        `setTimeout(() => process.exit(0), 800);`,
      true,
      dsn,
    ),
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  const events = result.stdout.split("\n").filter((l) => l.startsWith("EVENT:"));
  assert.equal(events.length, 2, `expected two events: ${result.stdout}${result.stderr}`);
  assert.ok(
    events.some((e) => e.includes("ENOENT")) &&
      events.some((e) => e.includes("PLANTED_MESSAGE")),
    `both events must have been built by the SDK: ${events.join("\n")}`,
  );
  assert.ok(
    !result.stdout.includes("PLANTED_PROMPT"),
    "spawn arguments reached the event",
  );
  assert.ok(
    !result.stdout.includes("PLANTED_VALUE"),
    "a captured object's values reached the event",
  );
});

test("exception text is cut, so a quoted input cannot ship whole", async () => {
  // The Node SDK sends `exception.value` untouched unless `maxValueLength` is
  // set (the 250 default belongs to the browser SDK). The bound is what makes
  // "an error that quotes its input" a limited exposure rather than an open
  // one, so it is asserted on a real event.
  const result = await withBlackHoleDsn((dsn) =>
    runChild(
      `const { captureError } = await import("./src/sentry.js");` +
        `const sdk = await import("@sentry/node");` +
        `sdk.getClient().on("beforeSendEvent", (ev) =>` +
        `  console.log("LEN:" + ev.exception.values[0].value.length));` +
        `captureError("test", new Error("x".repeat(2000)));` +
        `setTimeout(() => process.exit(0), 800);`,
      true,
      dsn,
    ),
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  const line = result.stdout.split("\n").find((l) => l.startsWith("LEN:"));
  assert.ok(line, `no event observed: ${result.stdout}${result.stderr}`);
  const length = Number(line.slice("LEN:".length));
  assert.ok(
    length < 300,
    `a 2000-character message arrived at ${length} characters; it must be cut`,
  );
});

test("fatal reports are filed as crashes, not as handled errors", async () => {
  // The SDK's own crash handlers send `level: fatal` and
  // `mechanism.handled: false`; Sentry shows and filters on both. Our
  // replacement handlers must not downgrade the daemon's death to a handled
  // error. The plain path is checked alongside, so that this is known to be
  // the option's doing rather than a default that happens to match.
  const result = await withBlackHoleDsn((dsn) =>
    runChild(
      `const { captureError } = await import("./src/sentry.js");` +
        `const sdk = await import("@sentry/node");` +
        `sdk.getClient().on("beforeSendEvent", (ev) => {` +
        `  const m = ev.exception?.values?.[0]?.mechanism;` +
        `  console.log("EVENT:" + ev.level + ":" + m?.handled + ":" + m?.type); });` +
        `captureError("plain", new Error("plain"));` +
        `Promise.reject(new Error("floating"));` +
        `setTimeout(() => { console.log("SURVIVED"); process.exit(7); }, 3000);`,
      true,
      dsn,
    ),
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes("EVENT:error:true:plain"),
    `a plain report should stay a handled error: ${result.stdout}${result.stderr}`,
  );
  assert.ok(
    result.stdout.includes("EVENT:fatal:false:unhandledRejection"),
    `a fatal report must be filed as a crash: ${result.stdout}${result.stderr}`,
  );
  assert.ok(!result.stdout.includes("SURVIVED"));
});

test("a malformed DSN does not stop the daemon", () => {
  // Runs in a child process: `Sentry.init` returns normally even for a DSN it
  // rejects, so this path still installs a process-level handler. Keeping it
  // out of the test process is the only way to leave no global state behind.
  const result = runChild(
    `const { initSentry, captureError, flushSentry } = await import("./src/sentry.js");` +
      `await initSentry("not-a-dsn", "");` +
      `captureError("test", new Error("boom"));` +
      `await flushSentry(1000);` +
      `console.log("DONE");`,
    false,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("DONE"), result.stderr);
  assert.equal(result.status, 0, "a typo in the DSN must not stop the daemon");
});

test("captureError swallows bad payloads", () => {
  // Arrange: run where reporting is actually on, so the call reaches the SDK.
  const result = runChild(
    `const { captureError } = await import("./src/sentry.js");` +
      `captureError("test", "not an error object");` +
      `captureError("test", undefined);` +
      `captureError("test", new Error("boom"), { note: "extra" });` +
      `console.log("DONE");`,
    true,
  );

  // Assert
  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"));
  assert.ok(result.stdout.includes("DONE"), "captureError must not throw");
  assert.equal(result.status, 0);
});

test("enabling reporting does not add the integrations that change behaviour", () => {
  // Arrange / Act
  const result = runChild(
    `const sdk = await import("@sentry/node");` +
      `const client = sdk.getClient();` +
      `console.log("NAMES:" + Object.keys(client?._integrations ?? {}).join(","));`,
    true,
  );

  // Assert
  assert.equal(result.error, undefined);
  assert.ok(
    result.stdout.includes("SENTRY_READY"),
    `reporting never initialised, so this proves nothing: ${result.stderr}`,
  );
  const line = result.stdout.split("\n").find((l) => l.startsWith("NAMES:"));
  assert.ok(line, `no integration list in output: ${result.stdout}`);
  const names = line.slice("NAMES:".length).split(",").filter(Boolean);

  // The whole set, not "these nine must be absent". Absence checks are keyed on
  // names the SDK owns: if `ChildProcess` were renamed upstream, the filter in
  // src/sentry.ts would silently stop suppressing it *and* this test would
  // still pass. This repository has no CI, so `pnpm test` after an SDK bump
  // is the only place a rename can be caught — it has to
  // fail loudly.
  assert.deepEqual(
    names.slice().sort(),
    EXPECTED_INTEGRATIONS.slice().sort(),
    "the integration set changed; check what the new one does before accepting it",
  );
});

test("SENTRY_TRACES_SAMPLE_RATE in the environment does not turn tracing on", () => {
  // With the option omitted the SDK reads that variable and starts sending a
  // transaction for every span; `tracesSampleRate: null` is what stops it.
  // A span is started by hand because nothing in the daemon starts one — the
  // integrations that would are not loaded — so without it there would be
  // nothing to observe either way. The variable's presence in the child is
  // printed so a run where it never arrived is told apart from a real pass.
  const result = runChild(
    `const sdk = await import("@sentry/node");` +
      `const c = sdk.getClient(); let tx = 0;` +
      `c.on("beforeEnvelope", (e) => { for (const [h] of e[1]) if (h.type === "transaction") tx++; });` +
      `sdk.startSpan({ name: "manual" }, () => {}); await sdk.flush(500);` +
      `console.log("ENV:" + process.env.SENTRY_TRACES_SAMPLE_RATE + " RATE:" + c.getOptions().tracesSampleRate + " TX:" + tx);`,
    true,
    TEST_DSN,
    { SENTRY_TRACES_SAMPLE_RATE: "1" },
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes("ENV:1 "),
    `the variable never reached the child, so this proves nothing: ${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("RATE:null TX:0"),
    `tracing must stay off under the variable: ${result.stdout}${result.stderr}`,
  );
});

test("enabling reporting does not hand the agent child a trace context", () => {
  // `init` registers a global OpenTelemetry propagator, and the Agent SDK
  // runs `propagation.inject()` when it spawns `claude`, copying the result
  // into the child's environment. With the propagator in place that is
  // `SENTRY-TRACE` and `BAGGAGE` (which carries the DSN's public key). The
  // same call the Agent SDK makes is made here; it must come back empty.
  const result = runChild(
    `const otel = await import("@opentelemetry/api");` +
      `const carrier = {}; otel.propagation.inject(otel.context.active(), carrier);` +
      `console.log("KEYS:" + JSON.stringify(Object.keys(carrier)));`,
    true,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes("KEYS:[]"),
    `the propagator must not be registered: ${result.stdout}${result.stderr}`,
  );
});

test("SENTRY_TRACE and SENTRY_BAGGAGE in the environment do not reach an envelope", async () => {
  // With `SENTRY_USE_ENVIRONMENT` set, `init` copies both into the scope the
  // later captures fork from, and every `sentry-*` baggage entry then travels
  // in every envelope's `trace` header. `initSentry` replaces that context
  // right after `init`; this runs with the gate open, so it checks the
  // replacement rather than the gate. The variable's presence in the child
  // is printed so a run where it never arrived is told apart from a real
  // pass.
  const result = await withBlackHoleDsn((dsn) =>
    runChild(
      `const { captureError } = await import("./src/sentry.js");` +
        `const sdk = await import("@sentry/node");` +
        `sdk.getClient().on("beforeEnvelope", (e) => console.log("HEADER:" + JSON.stringify(e[0])));` +
        `console.log("ENV:" + process.env.SENTRY_BAGGAGE);` +
        `captureError("test", new Error("e")); await sdk.flush(500); process.exit(0);`,
      true,
      dsn,
      {
        SENTRY_USE_ENVIRONMENT: "1",
        SENTRY_TRACE: "0123456789abcdef0123456789abcdef-0123456789abcdef-1",
        SENTRY_BAGGAGE: "sentry-transaction=PLANTED_BAGGAGE,sentry-release=PLANTED_RELEASE",
      },
    ),
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes("ENV:sentry-transaction=PLANTED_BAGGAGE"),
    `the variable never reached the child, so this proves nothing: ${result.stdout}`,
  );
  const headers = result.stdout.split("\n").filter((l) => l.startsWith("HEADER:"));
  assert.ok(headers.length > 0, `no envelope observed: ${result.stdout}${result.stderr}`);
  assert.ok(
    !headers.some((h) => h.includes("PLANTED_")),
    `environment baggage reached an envelope: ${headers.join("\n")}`,
  );
});

test("a propagator the host registered before init is left alone", () => {
  // OpenTelemetry refuses a second global registration, so when the host
  // already has a propagator Sentry's never goes in — and the removal must
  // then not happen either, or enabling reporting would take the host's own
  // trace propagation down process-wide. The propagator is registered before
  // `initSentry`, so this cannot use the shared prelude.
  const result = runChild(
    `const otel = await import("@opentelemetry/api");` +
      `otel.propagation.setGlobalPropagator({ inject: (c, carrier) => { carrier["x-host"] = "1"; }, extract: (c) => c, fields: () => ["x-host"] });` +
      `const { initSentry } = await import("./src/sentry.js");` +
      `await initSentry(${JSON.stringify(TEST_DSN)}, "test");` +
      `const sdk = await import("@sentry/node");` +
      `if (sdk.getClient()?.getTransport()) console.log("SENTRY_READY");` +
      `const carrier = {}; otel.propagation.inject(otel.context.active(), carrier);` +
      `console.log("KEYS:" + JSON.stringify(Object.keys(carrier)));`,
    false,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes('KEYS:["x-host"]'),
    `the host's propagator must survive: ${result.stdout}${result.stderr}`,
  );
});

test("SENTRY_SPOTLIGHT in the environment does not add a destination", () => {
  // `init` honours that variable after the integration filter has run, so
  // the filter cannot catch it; only the `spotlight: false` option can. The
  // integration is checked by name because that is the whole effect: with it
  // present every event is also posted to a local sidecar URL.
  const result = runChild(
    `const sdk = await import("@sentry/node");` +
      `console.log("NAMES:" + sdk.getClient().getIntegrationByName("Spotlight")?.name);`,
    true,
    TEST_DSN,
    { SENTRY_SPOTLIGHT: "1" },
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes("NAMES:undefined"),
    `Spotlight must stay off regardless of the environment: ${result.stdout}${result.stderr}`,
  );
});

test("a stack-shaped line in an error message does not get a file read", async () => {
  // The SDK parses frames out of the error text, and `ContextLines` reads the
  // file each frame names. Error messages here quote CLI output and child
  // stderr, so a crafted line would turn a report into a file read. The frame
  // itself is expected in the event (the parser is the SDK's and stays); the
  // file's content must not be.
  const { writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const planted = join(tmpdir(), `tssa-planted-${process.pid}.txt`);
  await writeFile(planted, "PLANTED_FILE_CONTENT\n");
  try {
    const result = await withBlackHoleDsn((dsn) =>
      runChild(
        `const { captureError } = await import("./src/sentry.js");` +
          `const sdk = await import("@sentry/node");` +
          `sdk.getClient().on("beforeSendEvent", (ev) => console.log("EVENT:" + JSON.stringify(ev)));` +
          `captureError("test", new Error("Command failed\\n    at injected (${planted}:1:1)"));` +
          `setTimeout(() => process.exit(0), 800);`,
        true,
        dsn,
      ),
    );

    assert.equal(result.error, undefined);
    assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
    const line = result.stdout.split("\n").find((l) => l.startsWith("EVENT:"));
    assert.ok(line, `no event observed: ${result.stdout}${result.stderr}`);
    // Parsed, not string-searched: the path is in the message text as well,
    // so "the event mentions the path" would hold even if no frame were built.
    const event = JSON.parse(line.slice("EVENT:".length));
    const frames = event.exception.values[0].stacktrace?.frames ?? [];
    assert.ok(
      frames.some((f: { filename?: string }) => f.filename === planted),
      "the crafted line should have become a frame, or this proves nothing",
    );
    assert.ok(
      !line.includes("PLANTED_FILE_CONTENT"),
      "a file named in the error text was read into the event",
    );
  } finally {
    await unlink(planted);
  }
});

test("enabling reporting does not install an ESM loader hook", () => {
  // `init` registers `import-in-the-middle` unless told not to — independent of
  // tracing, which is what the option next to it guards. That would route every
  // later dynamic import through a hook chain and add a worker thread to a
  // long-lived process.
  //
  // The SDK sets `globalThis._sentryEsmLoaderHookRegistered` just before it
  // registers the hook, and `tsx` (which this runner uses for `src/`) does not
  // interfere with that: with the option left at its default the flag reads
  // `true` under tsx as well, so the source module can be checked directly and
  // the test does not depend on a `dist/` build.
  const result = runChild(
    `console.log("HOOK:" + String(globalThis._sentryEsmLoaderHookRegistered));`,
    true,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes("HOOK:undefined"),
    `the ESM loader hook must stay unregistered: ${result.stdout}${result.stderr}`,
  );
});

test("flushing is bounded by its timeout, not by the SDK's own flush", () => {
  // `Client.flush(t)` waits up to `t` twice — once for event processing, once
  // for the transport — so trusting it would let a fatal exit take double the
  // documented 500 ms. The client's flush is replaced with one that takes far
  // longer than the timeout; `flushSentry` must return without it.
  const result = runChild(
    `const { flushSentry } = await import("./src/sentry.js");` +
      `const sdk = await import("@sentry/node");` +
      `sdk.getClient().flush = () => new Promise((r) => setTimeout(() => r(true), 3000));` +
      `const t0 = Date.now(); await flushSentry(200);` +
      `console.log("ELAPSED:" + (Date.now() - t0)); process.exit(0);`,
    true,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  const line = result.stdout.split("\n").find((l) => l.startsWith("ELAPSED:"));
  assert.ok(line, `no timing in output: ${result.stdout}${result.stderr}`);
  const elapsed = Number(line.slice("ELAPSED:".length));
  assert.ok(
    elapsed < 1500,
    `flushSentry(200) took ${elapsed} ms; the SDK's flush must not set the bound`,
  );
});

test("an unhandled rejection still kills the process", () => {
  assertSameFatalBehaviour(
    "unhandled rejection",
    `Promise.reject(new Error("floating"));`,
    "floating",
  );
});

test("an AbortError rejection still kills the process", () => {
  // The SDK's integration ignores AbortError by default and cannot be told not
  // to; shutdown in backends/claude.ts aborts its controllers, so this is the
  // rejection most likely to appear in practice.
  assertSameFatalBehaviour(
    "AbortError rejection",
    `const e = new Error("aborted"); e.name = "AbortError"; Promise.reject(e);`,
    "aborted",
  );
});

test("a fatal error during a signal shutdown leaves the exit to the shutdown", () => {
  // `shutdown.ts` runs its `force` cleanup (SIGKILL for hermes groups that
  // ignored `stop`) when its grace period ends, immediately before exiting
  // 130/143. A fatal error inside that period must not exit first: doing so
  // cancels the timer and the cleanup with it. Without reporting the process
  // dies on the spot and the cleanup is lost either way; with a handler in
  // place there is no reason to keep that.
  const result = runChild(
    `const { onShutdown } = await import("./src/shutdown.js");` +
      `onShutdown((phase) => console.log("PHASE:" + phase));` +
      `process.kill(process.pid, "SIGTERM");` +
      `setTimeout(() => Promise.reject(new Error("floating")), 100);` +
      `setTimeout(() => { console.log("SURVIVED"); process.exit(7); }, 6000);`,
    true,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(result.stdout.includes("PHASE:stop"), `the signal was not handled: ${result.stdout}`);
  assert.ok(
    result.stderr.includes("floating"),
    `the fatal error did not happen: ${result.stderr.slice(-300)}`,
  );
  assert.ok(
    result.stdout.includes("PHASE:force"),
    `the force cleanup must still run: ${result.stdout}${result.stderr}`,
  );
  assert.equal(result.status, 143, "the signal shutdown must own the exit code");
  assert.ok(!result.stdout.includes("SURVIVED"));
});

test("a burst of rejections still exits, with the same code", () => {
  // Note what this does *not* cover: the handler's re-entrancy guard is not
  // observable from outside. Without it every rejection starts its own flush,
  // but the first `process.exit(1)` still wins, so the exit code is unchanged
  // — removing the guard does not fail this test. The guard is there to avoid
  // the redundant work and the race between those flushes, not to change what
  // a caller can see.
  const result = runChild(
    `Promise.reject(new Error("first"));` +
      `Promise.reject(new Error("second"));` +
      `Promise.reject(new Error("third"));` +
      `setTimeout(() => { console.log("SURVIVED"); process.exit(7); }, 2500);`,
    true,
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"));
  assert.ok(!result.stdout.includes("SURVIVED"));
  assert.equal(result.status, 1);
});

test("the intake is closed while a fatal error is being reported", async () => {
  // Observed *during* the flush, not at exit. Checking only at exit would also
  // pass if `closeIntake()` were moved to just before `process.exit`, which is
  // the implementation this test exists to rule out: in that version work can
  // still start while the report is in flight.
  const result = await withBlackHoleDsn((dsn) =>
    runChild(
      `const { isShuttingDown } = await import("./src/shutdown.js");` +
        `console.log("BEFORE:" + isShuttingDown());` +
        `const t = setInterval(() => console.log("DURING:" + isShuttingDown()), 60);` +
        `t.unref?.();` +
        `Promise.reject(new Error("floating"));` +
        `setTimeout(() => { console.log("SURVIVED"); process.exit(7); }, 3000);`,
      true,
      dsn,
    ),
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(
    result.stdout.includes("BEFORE:false"),
    `the intake should start open: ${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("DURING:"),
    `the flush window was too short to observe: ${result.stdout}`,
  );
  assert.ok(
    !result.stdout.includes("DURING:false"),
    `the intake must already be closed while the report is in flight: ${result.stdout}`,
  );
  assert.ok(!result.stdout.includes("SURVIVED"));
});

test("an uncaught exception still kills the process, with the intake closed", async () => {
  // The SDK's own handler would report and exit without ever closing the
  // intake. Suppressing it and handling this ourselves is what makes the two
  // fatal paths symmetric — and adding a listener *without* suppressing it
  // stops the SDK exiting at all, so this also guards that trap.
  const result = await withBlackHoleDsn((dsn) =>
    runChild(
      `const { isShuttingDown } = await import("./src/shutdown.js");` +
        `const t = setInterval(() => console.log("DURING:" + isShuttingDown()), 60);` +
        `t.unref?.();` +
        `setTimeout(() => { console.log("SURVIVED"); process.exit(7); }, 3000);` +
        `throw new Error("boom");`,
      true,
      dsn,
    ),
  );

  assert.equal(result.error, undefined);
  assert.ok(result.stdout.includes("SENTRY_READY"), result.stderr);
  assert.ok(!result.stdout.includes("SURVIVED"), "the process must still die");
  assert.equal(result.status, 1);
  assert.ok(
    result.stdout.includes("DURING:") && !result.stdout.includes("DURING:false"),
    `the intake must be closed while the report is in flight: ${result.stdout}`,
  );
});

test("a failed child-process spawn still kills the process", () => {
  // `startListener` spawns `taskshoot listen` with no error handler on purpose:
  // a failed spawn should crash the daemon so the supervisor restarts it. A
  // failed spawn emits no `exit`, so nothing else would recover it.
  assertSameFatalBehaviour(
    "failed spawn",
    `const { spawn } = await import("node:child_process");` +
      `spawn("no-such-binary-for-this-test", []);`,
    "no-such-binary-for-this-test",
  );
});
