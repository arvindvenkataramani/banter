// Probe history inspector — read-only session discovery and chat.history
// fetch, for verifying what the real transcript actually contains (tool
// block shapes, abort-artifact text, etc.) without touching the dashboard
// or any session file on disk directly.
//
//   bun run control/probe/history.ts --list
//   bun run control/probe/history.ts --session agent:example:main
//   bun run control/probe/history.ts --session agent:example:main --raw
//
// Uses the same paired probe identity as run.ts. Read-only: never calls
// chat.send or any mutating RPC.

import { loadOrCreateIdentity } from "./identity";
import { CaptureSink } from "./capture";
import { ProbeConnection } from "./connection";
import { CAPTURE_DIR, IDENTITY_PATH, pruneCaptures } from "./paths";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveConfigValue } from "../control-plane/src/gateway-config";

const DISPLAY_NAME = "Banter gateway probe";

interface Args {
  list: boolean;
  session: string | null;
  raw: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, session: null, raw: false, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--session") args.session = argv[++i];
    else if (arg === "--raw") args.raw = true;
    else if (arg === "--limit") args.limit = Number(argv[++i]);
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
  if (!gw?.url || !token) throw new Error(`no gateway url/token in ${configPath}`);
  return { url: gw.url, token };
}

function timestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").split(".")[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.list && !args.session) {
    console.error("usage: bun run control/probe/history.ts --list | --session <key> [--raw] [--limit N]");
    process.exit(1);
  }

  const identity = loadOrCreateIdentity(IDENTITY_PATH);
  const { url, token } = await loadGatewayConfig();

  pruneCaptures();
  const capturePath = join(CAPTURE_DIR, `${timestamp()}-history.jsonl`);
  // Only the explicitly requested session is captured in full — sessions.list
  // responses (session metadata only, no message content) fall back to the
  // envelope-only redaction path, same discipline as run.ts.
  const sink = new CaptureSink({
    path: capturePath,
    allowedSessionKeys: args.session ? [args.session] : [],
    allowAll: false,
  });

  const conn = new ProbeConnection({ url, token, identity, sink, displayName: DISPLAY_NAME });

  try {
    await conn.ready();
  } catch (err) {
    console.error(`handshake failed: ${(err as Error).message}`);
    sink.close();
    process.exit(1);
  }

  if (args.list) {
    const payload = (await conn.call("sessions.list", {})) as { sessions?: Array<Record<string, unknown>> };
    for (const s of payload.sessions ?? []) {
      console.log(`${s.key}\tupdatedAt=${s.updatedAt}\tmodel=${s.model ?? ""}`);
    }
  }

  if (args.session) {
    const payload = (await conn.call("chat.history", { sessionKey: args.session, limit: args.limit })) as {
      messages?: Array<Record<string, unknown>>;
      hasMore?: boolean;
    };
    const messages = payload.messages ?? [];
    console.log(`${messages.length} messages (hasMore=${payload.hasMore === true})`);
    for (const m of messages) {
      if (args.raw) {
        console.log(JSON.stringify(m));
        continue;
      }
      const content = m.content;
      if (Array.isArray(content)) {
        const types = content.map((b) => (b as Record<string, unknown>)?.type).join(",");
        console.log(`[${m.role}] blocks: ${types}`);
      } else {
        console.log(`[${m.role}] text (len ${String(content ?? "").length})`);
      }
    }
  }

  sink.close();
  conn.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
