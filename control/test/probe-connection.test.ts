import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeConnection } from "../probe/connection";
import { loadOrCreateIdentity } from "../probe/identity";
import { CaptureSink } from "../probe/capture";

type Frame = Record<string, any>;

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let received: Frame[];
let sink: CaptureSink;
let conn: ProbeConnection | null;

const SESSION = "agent:example:probe-test";

// Minimal stand-in for the gateway handshake: challenge on open, hello-ok on
// connect, ok for everything else. Enough to assert what the probe sends.
function startGateway(opts: { rejectConnect?: boolean } = {}) {
  received = [];
  return Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open(ws) {
        ws.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "nonce-xyz", ts: Date.now() },
          }),
        );
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        received.push(frame);
        if (frame.method === "connect") {
          if (opts.rejectConnect) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: { message: "device not paired" },
              }),
            );
            return;
          }
          ws.send(
            JSON.stringify({
              type: "hello-ok",
              protocol: 4,
              policy: { tickIntervalMs: 15000 },
              auth: { deviceToken: "dev-token", role: "operator", scopes: [] },
            }),
          );
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
          return;
        }
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
      },
    },
  });
}

function connect(overrides: Record<string, unknown> = {}) {
  const identity = loadOrCreateIdentity(join(dir, "identity.json"));
  sink = new CaptureSink({
    path: join(dir, "capture.jsonl"),
    allowedSessionKeys: [SESSION],
    allowAll: false,
  });
  conn = new ProbeConnection({
    url: `ws://localhost:${server.port}`,
    token: "token-abc",
    identity,
    sink,
    displayName: "Banter probe",
    ...overrides,
  });
  return conn;
}

function entries(): Frame[] {
  sink.close();
  return readFileSync(join(dir, "capture.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-conn-"));
  conn = null;
});

afterEach(() => {
  conn?.close();
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("probe connection", () => {
  it("advertises the tool-events capability and its own client identity on connect", async () => {
    server = startGateway();
    await connect().ready();

    const connectFrame = received.find((f) => f.method === "connect");
    expect(connectFrame.params.caps).toEqual(["tool-events"]);
    expect(connectFrame.params.client.id).toBe("openclaw-probe");
    expect(connectFrame.params.client.mode).toBe("probe");
    expect(connectFrame.params.client.displayName).toBe("Banter probe");
    expect(connectFrame.params.role).toBe("operator");
  });

  it("signs the challenge nonce with its own device identity", async () => {
    server = startGateway();
    const c = connect();
    await c.ready();

    const identity = loadOrCreateIdentity(join(dir, "identity.json"));
    const connectFrame = received.find((f) => f.method === "connect");
    expect(connectFrame.params.device.id).toBe(identity.deviceId);
    expect(connectFrame.params.device.nonce).toBe("nonce-xyz");
    expect(connectFrame.params.device.signature).toBeTruthy();
  });

  it("subscribes to session events and session messages after the handshake", async () => {
    server = startGateway();
    const c = connect();
    await c.ready();
    await c.subscribe(SESSION);

    const methods = received.map((f) => f.method);
    expect(methods).toContain("sessions.subscribe");
    expect(methods).toContain("sessions.messages.subscribe");
    const messagesSub = received.find((f) => f.method === "sessions.messages.subscribe");
    expect(messagesSub.params.key).toBe(SESSION);
  });

  it("reports a failed handshake instead of hanging", async () => {
    server = startGateway({ rejectConnect: true });
    const c = connect();
    await expect(c.ready()).rejects.toThrow(/not paired/i);
  });

  it("captures every inbound frame family, not just chat and session.message", async () => {
    server = startGateway();
    const c = connect();
    await c.ready();

    const families = [
      { event: "chat", payload: { sessionKey: SESSION, seq: 1, state: "delta", message: "hi" } },
      {
        event: "agent",
        payload: { sessionKey: SESSION, runId: "r1", seq: 1, stream: "tool", data: { phase: "start", name: "exec" } },
      },
      {
        event: "session.tool",
        payload: { sessionKey: SESSION, runId: "r1", seq: 2, stream: "tool", data: { phase: "end", name: "exec" } },
      },
      { event: "session.message", payload: { sessionKey: SESSION, messageSeq: 1, message: { role: "assistant", content: [] } } },
      { event: "sessions.changed", payload: { sessions: [] } },
    ];
    for (const f of families) {
      c.injectForTest({ type: "event", ...f });
    }

    const captured = entries().filter((e) => e.kind === "frame" || e.kind === "envelope");
    const events = captured.map((e) => e.frame?.event ?? e.event);
    expect(events).toContain("chat");
    expect(events).toContain("agent");
    expect(events).toContain("session.tool");
    expect(events).toContain("session.message");
    expect(events).toContain("sessions.changed");
  });

  it("captures the outbound connect frame with the token redacted", async () => {
    server = startGateway();
    await connect().ready();

    const out = entries().filter((e) => e.dir === "out");
    const connectEntry = out.find((e) => e.frame?.method === "connect");
    expect(connectEntry).toBeTruthy();
    expect(JSON.stringify(connectEntry)).not.toContain("token-abc");
  });
});
