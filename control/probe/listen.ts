// Listen-only companion to run.ts.
//
//   bun run control/probe/listen.ts [--duration <seconds>] [--session <key>] [--all-sessions]
//
// Connects, subscribes, and never sends a chat message — so the gateway never
// registers it as a run-scoped tool recipient. This is the position of a
// dashboard that attaches to an in-flight session: the source says such
// clients get tool lifecycle via the session.tool mirror instead of run-scoped
// agent events. Running this alongside run.ts is what verifies that claim,
// and the background/cron delivery question, on the wire.

import { join } from "node:path";
import { homedir } from "node:os";
import { resolveConfigValue } from "../control-plane/src/gateway-config";
import { loadOrCreateIdentity } from "./identity";
import { CaptureSink } from "./capture";
import { ProbeConnection } from "./connection";
import { CAPTURE_DIR, IDENTITY_PATH, pruneCaptures } from "./paths";

const AGENT_ID = process.env.PROBE_AGENT_ID ?? "example";
const DEFAULT_SESSION_KEY = `agent:${AGENT_ID}:${process.env.PROBE_SESSION ?? "probe"}`;

interface Args {
  durationSeconds: number;
  sessionKeys: string[];
  allSessions: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { durationSeconds: 120, sessionKeys: [], allSessions: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--duration") args.durationSeconds = Number(argv[++i]);
    else if (arg === "--session") args.sessionKeys.push(argv[++i]);
    else if (arg === "--all-sessions") args.allSessions = true;
  }
  if (args.sessionKeys.length === 0) args.sessionKeys.push(DEFAULT_SESSION_KEY);
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
  if (!gw?.url || !token) throw new Error(`no gateway url/token in ${configPath}`);
  return { url: gw.url, token };
}

function timestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").split(".")[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const identity = loadOrCreateIdentity(IDENTITY_PATH);
  const { url, token } = await loadGatewayConfig();

  pruneCaptures();
  const capturePath = join(CAPTURE_DIR, `listen-${timestamp()}.jsonl`);
  const sink = new CaptureSink({
    path: capturePath,
    allowedSessionKeys: args.sessionKeys,
    allowAll: args.allSessions,
  });

  if (args.allSessions) {
    console.warn("WARNING: --all-sessions records every session's content. Treat as sensitive.");
  }

  const conn = new ProbeConnection({
    url,
    token,
    identity,
    sink,
    displayName: "Banter gateway probe",
  });

  sink.recordMarker("listen.start", {
    sessionKeys: args.sessionKeys,
    allSessions: args.allSessions,
    durationSeconds: args.durationSeconds,
  });

  await conn.ready();
  console.log("handshake ok (listen-only — sending nothing)");

  await conn.call("sessions.subscribe", {});
  for (const key of args.sessionKeys) {
    await conn.call("sessions.messages.subscribe", { key });
  }
  sink.recordMarker("listen.subscribed", { sessionKeys: args.sessionKeys });
  console.log(`subscribed; listening ${args.durationSeconds}s`);
  console.log(`capture: ${capturePath}`);

  await Bun.sleep(args.durationSeconds * 1000);

  sink.recordMarker("listen.end");
  sink.close();
  conn.close();
  console.log("done");
}

await main();
