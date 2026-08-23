// Headless gateway client for protocol observation.
//
// Deliberately thin: it holds the connection open, taps every frame into the
// capture sink before touching it, and exposes request/response plumbing. It
// does not normalize payloads or model sessions — that is the dashboard's job,
// and a probe that shares the dashboard's interpretation cannot falsify it.

import { signChallenge, type ProbeIdentity } from "./identity";
import type { CaptureSink } from "./capture";

const CONNECT_PROTOCOL = 4;

const OPERATOR_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
];

// GATEWAY_CLIENT_CAPS in 2026.7.1 holds exactly this one entry. Without it the
// gateway never registers the connection for structured tool events, and the
// handshake still succeeds — the silence is the whole reason this probe exists.
const CLIENT_CAPS = ["tool-events"];

const CLIENT_ID = "openclaw-probe";
const CLIENT_MODE = "probe";
const ROLE = "operator";

export interface ProbeConnectionOptions {
  url: string;
  token: string;
  identity: ProbeIdentity;
  sink: CaptureSink;
  displayName: string;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

type EventHandler = (event: string, payload: Record<string, unknown>) => void;

export class ProbeConnection {
  private ws: WebSocket;
  private opts: ProbeConnectionOptions;
  private pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private challengeNonce: string | null = null;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private readyPromise: Promise<void>;
  private settled = false;
  private handlers = new Set<EventHandler>();

  constructor(opts: ProbeConnectionOptions) {
    this.opts = opts;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.ws = new WebSocket(opts.url);
    this.ws.addEventListener("message", (ev) => this.onRaw(String(ev.data)));
    this.ws.addEventListener("close", () => {
      this.failPending(new Error("gateway connection closed"));
    });
    this.ws.addEventListener("error", () => {
      this.failPending(new Error("gateway connection error"));
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Subscribes to both session-scoped families for one session. */
  async subscribe(sessionKey: string): Promise<void> {
    await this.call("sessions.subscribe", {});
    await this.call("sessions.messages.subscribe", { key: sessionKey });
  }

  call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = String(++this.requestCounter);
      this.pending.set(id, { resolve, reject });
      this.send({ type: "req", id, method, params });
    });
  }

  close() {
    this.failPending(new Error("probe closed"));
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }

  /** Feeds a frame through the capture path as if it arrived on the wire. */
  injectForTest(frame: Record<string, unknown>) {
    this.onRaw(JSON.stringify(frame));
  }

  private send(frame: Record<string, unknown>) {
    const raw = JSON.stringify(frame);
    this.opts.sink.recordFrame("out", raw);
    this.ws.send(raw);
  }

  // Capture happens first, before parsing or dispatch, so a frame the probe
  // fails to understand still lands on disk intact.
  private onRaw(raw: string) {
    this.opts.sink.recordFrame("in", raw);

    let frame: Record<string, any>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.type === "event") {
      const event = String(frame.event ?? "");
      if (event === "connect.challenge") {
        this.challengeNonce = frame.payload?.nonce ?? null;
        this.sendConnect();
        return;
      }
      for (const handler of this.handlers) {
        handler(event, (frame.payload ?? {}) as Record<string, unknown>);
      }
      return;
    }

    if (frame.type === "hello-ok") {
      if (!this.settled) {
        this.settled = true;
        this.readyResolve();
      }
      return;
    }

    if (frame.type === "res" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(String(frame.error?.message ?? "gateway request failed")));
      }
    }
  }

  private sendConnect() {
    const device = this.challengeNonce
      ? signChallenge(this.opts.identity, {
          nonce: this.challengeNonce,
          token: this.opts.token,
          clientId: CLIENT_ID,
          clientMode: CLIENT_MODE,
          role: ROLE,
          scopes: OPERATOR_SCOPES,
          platform: "linux",
          deviceFamily: "server",
        })
      : undefined;

    const id = String(++this.requestCounter);
    this.pending.set(id, {
      resolve: () => {
        if (!this.settled) {
          this.settled = true;
          this.readyResolve();
        }
      },
      reject: (err) => {
        if (!this.settled) {
          this.settled = true;
          this.readyReject(err);
        }
      },
    });

    this.send({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: CONNECT_PROTOCOL,
        maxProtocol: CONNECT_PROTOCOL,
        client: {
          id: CLIENT_ID,
          displayName: this.opts.displayName,
          version: "0.1.0",
          platform: "linux",
          mode: CLIENT_MODE,
          deviceFamily: "server",
        },
        role: ROLE,
        scopes: OPERATOR_SCOPES,
        caps: CLIENT_CAPS,
        auth: { token: this.opts.token },
        device,
      },
    });
  }

  private failPending(err: Error) {
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
    if (!this.settled) {
      this.settled = true;
      this.readyReject(err);
    }
  }
}
