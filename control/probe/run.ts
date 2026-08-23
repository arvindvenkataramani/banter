// Probe CLI — drives scripted chats and captures every frame.
//
//   bun run control/probe/run.ts --pair
//   bun run control/probe/run.ts --scenario text-slow-tool-text
//   bun run control/probe/run.ts --all
//
// Pairing: run --pair once, approve the device with `openclaw devices approve`,
// then run scenarios. The probe is its own device and is revocable on its own.

import { join } from "node:path";
import { homedir } from "node:os";
import { resolveConfigValue } from "../control-plane/src/gateway-config";
import { loadOrCreateIdentity } from "./identity";
import { CaptureSink } from "./capture";
import { ProbeConnection } from "./connection";
import { SCENARIOS, findScenario, type Scenario } from "./scenarios";
import { CAPTURE_DIR, IDENTITY_PATH, pruneCaptures } from "./paths";

const DISPLAY_NAME = "Banter gateway probe";

// A scratch agent — scenarios run destructive-ish shell commands and should
// not land in a session anyone is reading.
const AGENT_ID = process.env.PROBE_AGENT_ID ?? "example";
const SESSION_NAME = process.env.PROBE_SESSION ?? "probe";
const SESSION_KEY = `agent:${AGENT_ID}:${SESSION_NAME}`;

// Local inference, not Anthropic. Some agent fallback chains include
// anthropic/* entries, so the model is pinned per-session rather than left to
// the agent default.
const MODEL = process.env.PROBE_MODEL ?? "lmstudio/qwen/qwen3-coder-30b";

const DEFAULT_WAIT_MS = 25_000;
const QUIET_PERIOD_MS = 4_000;
// A cold local model can take this long to emit its first token.
const COLD_START_GRACE_MS = 90_000;
// Gap between scenarios, so the session write lock is fully released.
const SESSION_SETTLE_MS = 8_000;

interface Args {
  pair: boolean;
  all: boolean;
  scenarioIds: string[];
  allSessions: boolean;
  model: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pair: false,
    all: false,
    scenarioIds: [],
    allSessions: false,
    model: MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pair") args.pair = true;
    else if (arg === "--all") args.all = true;
    else if (arg === "--all-sessions") args.allSessions = true;
    else if (arg === "--scenario") args.scenarioIds.push(argv[++i]);
    else if (arg === "--model") args.model = argv[++i];
  }
  return args;
}

async function loadGatewayConfig(): Promise<{ url: string; token: string }> {
  const configPath =
    process.env.BANTER_CONFIG_PATH ??
    join(
      process.env.BANTER_PROD ?? join(homedir(), "services", "banter"),
      "control",
      "control-plane",
      "data",
      "config.json",
    );
  const config = await Bun.file(configPath).json();
  const gw = config?.integrations?.openclaw?.gateway;
  const token = resolveConfigValue(gw?.token);
  if (!gw?.url || !token) {
    throw new Error(`no gateway url/token in ${configPath}`);
  }
  return { url: gw.url, token };
}

function timestamp(): string {
  // Filesystem-safe ISO: 2026-08-06T14-32-05
  return new Date().toISOString().replace(/:/g, "-").split(".")[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const identity = loadOrCreateIdentity(IDENTITY_PATH);
  const { url, token } = await loadGatewayConfig();

  console.log(`probe device id: ${identity.deviceId}`);
  console.log(`identity file:   ${IDENTITY_PATH}`);

  const pruned = pruneCaptures();
  if (pruned.length > 0) {
    console.log(`pruned ${pruned.length} old capture(s)`);
  }

  const capturePath = join(CAPTURE_DIR, `${timestamp()}.jsonl`);
  const sink = new CaptureSink({
    path: capturePath,
    allowedSessionKeys: [SESSION_KEY],
    allowAll: args.allSessions,
  });

  if (args.allSessions) {
    console.warn(
      "WARNING: --all-sessions records every session's content, including " +
        "conversations unrelated to this test. Treat the capture as sensitive.",
    );
  }

  const conn = new ProbeConnection({ url, token, identity, sink, displayName: DISPLAY_NAME });

  sink.recordMarker("probe.start", {
    deviceId: identity.deviceId,
    sessionKey: SESSION_KEY,
    allSessions: args.allSessions,
    model: args.model,
  });

  try {
    await conn.ready();
  } catch (err) {
    console.error(`\nhandshake failed: ${(err as Error).message}`);
    console.error(
      "\nIf this says the device is not paired, find the pending request id " +
        "with `openclaw devices list`, then:\n" +
        "  openclaw devices approve <request-id>\n" +
        `then run again. The device appears as "${DISPLAY_NAME}".`,
    );
    sink.recordMarker("probe.handshake_failed", { message: (err as Error).message });
    sink.close();
    process.exit(1);
  }

  console.log("handshake ok");
  sink.recordMarker("probe.connected");

  if (args.pair) {
    console.log(
      `\nPaired and connected. Verify with:\n  openclaw devices list\n` +
        `Look for "${DISPLAY_NAME}" (${identity.deviceId.slice(0, 12)}…).`,
    );
    sink.close();
    conn.close();
    return;
  }

  await conn.subscribe(SESSION_KEY);
  sink.recordMarker("probe.subscribed", { sessionKey: SESSION_KEY });
  console.log(`subscribed to ${SESSION_KEY}`);

  // Route the session at local inference before any scenario runs. Wait for
  // the gateway to go quiet — a fixed sleep raced the /model turn and tripped
  // "session file changed while embedded prompt lock was released".
  const modelSettled = watchForQuiet(conn, 0);
  await sendChat(conn, `/model ${args.model}`);
  await modelSettled;
  sink.recordMarker("probe.model_set", { model: args.model });
  console.log(`model set to ${args.model}`);

  const scenarios = args.all
    ? SCENARIOS
    : args.scenarioIds
        .map((id) => {
          const found = findScenario(id);
          if (!found) throw new Error(`unknown scenario: ${id}`);
          return found;
        });

  if (scenarios.length === 0) {
    console.error("nothing to run — pass --all or --scenario <id>");
    console.error(`available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    sink.close();
    conn.close();
    process.exit(1);
  }

  for (const scenario of scenarios) {
    await runScenario(conn, sink, scenario);
  }

  sink.recordMarker("probe.done");
  sink.close();
  conn.close();

  console.log(`\ncapture written to ${capturePath}`);
}

async function runScenario(conn: ProbeConnection, sink: CaptureSink, scenario: Scenario) {
  console.log(`\n=== ${scenario.id} ===`);
  console.log(scenario.intent);

  sink.recordMarker("scenario.start", {
    scenario: scenario.id,
    intent: scenario.intent,
    prompt: scenario.prompt,
  });

  // The gateway releases the session write lock shortly after a run ends.
  // Sending the next scenario too soon fails the run with "session file
  // changed while embedded prompt lock was released".
  await Bun.sleep(SESSION_SETTLE_MS);

  const settled = watchForQuiet(conn, scenario.extraWaitMs ?? 0);
  await sendChat(conn, scenario.prompt);
  sink.recordMarker("scenario.sent", { scenario: scenario.id });

  await settled;

  sink.recordMarker("scenario.end", { scenario: scenario.id });
  console.log("done");
}

async function sendChat(conn: ProbeConnection, message: string) {
  await conn.call("chat.send", {
    sessionKey: SESSION_KEY,
    message,
    idempotencyKey: `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
}

// A run is over when the gateway stops talking. Waiting on a lifecycle end
// event would be tighter, but that is one of the things under test — the probe
// must not assume the shape of what it is measuring.
//
// Two guards keep the quiet heuristic from ending a run early:
// - the countdown arms only after the first event, so model cold-start
//   silence doesn't count as quiet;
// - a scenario's extraWaitMs widens the quiet threshold too, because a
//   deliberate in-run silence (sleep 8 with no mid-tool events) must not
//   read as completion.
// A lifecycle end/error event ends the run outright. That is a convenience,
// not a claim about the protocol — lifecycle events are captured like every
// other family and nothing downstream depends on this reading.
function watchForQuiet(conn: ProbeConnection, extraWaitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let sawEvent = false;
    let lastEventAt = Date.now();
    let finished = false;
    // Silence is not completion: a local model thinks for long stretches
    // without emitting anything, before the run starts and during it. The
    // turn is over when the gateway says so — chat final/aborted/error, or
    // lifecycle end/error — plus a short grace for trailing transcript
    // events. Silence thresholds remain only as backstops.
    const stuckRunSilenceMs = DEFAULT_WAIT_MS + extraWaitMs;
    const coldDeadline = Date.now() + COLD_START_GRACE_MS;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      unsubscribe();
      resolve();
    };

    const unsubscribe = conn.onEvent((event, payload) => {
      sawEvent = true;
      lastEventAt = Date.now();

      const chatState = event === "chat" ? String(payload.state ?? "") : "";
      const lifecyclePhase =
        event === "agent" && payload.stream === "lifecycle"
          ? String((payload.data as Record<string, unknown> | undefined)?.phase ?? "")
          : "";
      if (
        ["final", "aborted", "error"].includes(chatState) ||
        ["end", "error"].includes(lifecyclePhase)
      ) {
        setTimeout(finish, QUIET_PERIOD_MS);
      }
    });

    const timer = setInterval(() => {
      if (!sawEvent) {
        if (Date.now() >= coldDeadline) finish();
        return;
      }
      if (Date.now() - lastEventAt >= stuckRunSilenceMs) finish();
    }, 500);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
