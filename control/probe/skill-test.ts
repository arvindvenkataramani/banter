// Skill invocation test — sends a natural request to an agent and reports
// whether a skill was actually invoked, from the wire rather than from the
// agent's own account of itself.
//
//   bun run control/probe/skill-test.ts --agent example --message "tell me a bedtime story"
//   bun run control/probe/skill-test.ts --agent example --message "..." --expect bedtime-stories
//   bun run control/probe/skill-test.ts --agent example --message "..." --timeout 1800
//
// Skill visibility (`openclaw skills list --agent <id>`) says an agent *may*
// use a skill. It does not say the agent will recognise a request as calling
// for it, nor that it can run what the skill instructs. Those are behaviours,
// and the only honest way to check them is to ask and watch.
//
// Sends to `agent:<id>:skill-test` — a scratch session, so a test request
// never lands in a conversation anyone is reading.

import { CaptureSink } from "./capture";
import { loadOrCreateIdentity } from "./identity";
import { ProbeConnection } from "./connection";
import { CAPTURE_DIR, IDENTITY_PATH, pruneCaptures } from "./paths";
import { join } from "node:path";
import { loadGatewayConfig } from "./gateway";

const DISPLAY_NAME = "Banter gateway probe";

/** Trailing silence that counts as the turn being over. */
const QUIET_PERIOD_MS = 3_000;
/** Silence before the first event — model cold start is not completion. */
const COLD_START_GRACE_MS = 180_000;

interface Args {
  agent: string | null;
  message: string | null;
  expect: string | null;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { agent: null, message: null, expect: null, timeoutMs: 900_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent") args.agent = argv[++i];
    else if (arg === "--message") args.message = argv[++i];
    else if (arg === "--expect") args.expect = argv[++i];
    else if (arg === "--timeout") args.timeoutMs = Number(argv[++i]) * 1000;
  }
  return args;
}

function timestamp(): string {
  return new Date().toISOString().replace(/:/g, "-").split(".")[0];
}

interface Observed {
  skills: Set<string>;
  tools: string[];
  reply: string;
}

/**
 * Watches a turn and records what it did. Skill use is inferred from tool
 * calls and reply text mentioning the skill — the gateway has no dedicated
 * "skill invoked" event, so this reports evidence rather than a verdict.
 */
function watchTurn(conn: ProbeConnection, timeoutMs: number): Promise<Observed> {
  return new Promise((resolve) => {
    const observed: Observed = { skills: new Set(), tools: [], reply: "" };
    let sawEvent = false;
    let lastEventAt = Date.now();
    let finished = false;
    const coldDeadline = Date.now() + COLD_START_GRACE_MS;
    const hardDeadline = Date.now() + timeoutMs;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      unsubscribe();
      resolve(observed);
    };

    const unsubscribe = conn.onEvent((event, payload) => {
      sawEvent = true;
      lastEventAt = Date.now();

      if (event === "agent" && payload.stream === "tool") {
        const data = payload.data as Record<string, unknown> | undefined;
        const name = String(data?.name ?? data?.tool ?? "");
        if (name) {
          observed.tools.push(name);
          console.log(`  tool: ${name}`);
        }
        const blob = JSON.stringify(data ?? {});
        for (const m of blob.matchAll(/skills\/([a-z0-9-]+)/gi)) observed.skills.add(m[1]);
      }

      if (event === "chat") {
        const text = String(payload.text ?? payload.message ?? "");
        if (text) observed.reply = text;
        const state = String(payload.state ?? "");
        if (["final", "aborted", "error"].includes(state)) setTimeout(finish, QUIET_PERIOD_MS);
      }

      if (event === "agent" && payload.stream === "lifecycle") {
        const phase = String((payload.data as Record<string, unknown> | undefined)?.phase ?? "");
        if (["end", "error"].includes(phase)) setTimeout(finish, QUIET_PERIOD_MS);
      }
    });

    const timer = setInterval(() => {
      if (Date.now() >= hardDeadline) {
        console.log("  (timeout reached)");
        finish();
        return;
      }
      if (!sawEvent && Date.now() >= coldDeadline) finish();
    }, 500);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.agent || !args.message) {
    console.error(
      'usage: bun run control/probe/skill-test.ts --agent <id> --message "..." [--expect <skill>] [--timeout <seconds>]',
    );
    process.exit(1);
  }

  const sessionKey = `agent:${args.agent}:skill-test`;
  const identity = loadOrCreateIdentity(IDENTITY_PATH);
  const { url, token } = await loadGatewayConfig();

  pruneCaptures();
  const capturePath = join(CAPTURE_DIR, `${timestamp()}-skill-test.jsonl`);
  const sink = new CaptureSink({ path: capturePath, allowedSessionKeys: [sessionKey], allowAll: false });

  const conn = new ProbeConnection({ url, token, identity, sink, displayName: DISPLAY_NAME });
  try {
    await conn.ready();
  } catch (err) {
    console.error(`handshake failed: ${(err as Error).message}`);
    sink.close();
    process.exit(1);
  }

  console.log(`session: ${sessionKey}`);
  console.log(`message: ${args.message}`);
  if (args.expect) console.log(`expecting: ${args.expect}`);
  console.log("---");

  const watching = watchTurn(conn, args.timeoutMs);
  await conn.call("chat.send", {
    sessionKey,
    message: args.message,
    idempotencyKey: `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });

  const observed = await watching;
  conn.close();
  sink.close();

  console.log("---");
  console.log(`tools called: ${observed.tools.length ? observed.tools.join(", ") : "none"}`);
  console.log(`skills seen:  ${observed.skills.size ? [...observed.skills].join(", ") : "none"}`);
  console.log(`capture:      ${capturePath}`);
  if (observed.reply) console.log(`reply:        ${observed.reply.slice(0, 300)}`);

  if (args.expect) {
    const hit =
      observed.skills.has(args.expect) ||
      observed.tools.some((t) => t.includes(args.expect!)) ||
      observed.reply.includes(args.expect);
    console.log(`\n${hit ? "PASS" : "FAIL"}: ${args.expect} ${hit ? "was" : "was not"} evidenced`);
    process.exit(hit ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
