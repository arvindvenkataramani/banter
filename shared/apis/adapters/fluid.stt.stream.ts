// Client for fluid's streaming transcription socket (services/fluid/STT.md, Streaming).
//
// One connection carries a conversation, not an utterance: `Finalize` returns the settled
// transcript and leaves the socket open for the next turn. Only `CloseStream` ends it.
// A socket dies once and is not reopened; reconnecting means opening another, which is the
// voice loop's work.

import { trimEndpoint } from "./http";
import { partHolds } from "../parts";
import type { AdapterDeclaration, Provision, StreamCall, StreamCallbacks, StreamSession } from "../types";

export const declaration: AdapterDeclaration = {
  api: "fluid.stt.stream",
  operations: ["transcribeStream"],
  requires: { transcribeStream: ["client-message:Finalize", "server-message:transcript"] },
  uses: { transcribeStream: ["parameter:session", "parameter:takeover", "parameter:chunkMs", "value:format=opus"] },
  capabilities: {
    "client-endpointing": [{ spec: true }],
    opus: [{ part: "value:format=opus" }],
    takeover: [{ part: "parameter:session" }],
    "carries-variant": [{ part: "parameter:chunkMs" }],
    "session-loads": [{ spec: true }],
  },
};

/** Proof the client is alive while it sends no audio. The server reclaims a quiet session only after thirty minutes, so this is well inside it. */
const KEEPALIVE_INTERVAL_MS = 4000;

/** Close codes 4001 to 4010 name the protocol's error codes; a close in this range with no error frame before it still reports one. */
const CLOSE_CODES: Record<number, string> = {
  4001: "held",
  4002: "superseded",
  4003: "idle",
  4004: "model_not_loaded",
  4005: "model_mismatch",
  4006: "busy",
  4007: "bad_format",
  4008: "bad_audio",
  4009: "failed",
  4010: "replaced",
};

/** Frames to hold while the socket opens: a couple of seconds at 4096 samples per frame, bounded so a socket that never opens cannot grow this without limit. */
const PRE_OPEN_FRAME_LIMIT = 24;

/** The socket's path under the endpoint: the spec's, behind the provision's `basePath`. */
export function streamPath(provision: Provision): string {
  return `${provision.basePath ?? ""}/v1/audio/stream`;
}

function socketUrl(call: StreamCall): string {
  // A provision that omits the session parameter does not implement it, so neither field is sent.
  const claims = partHolds(call.provision, "parameter:session");
  let url = `${trimEndpoint(call.endpoint).replace(/^http/, "ws")}${streamPath(call.provision)}`
    + `?model=${encodeURIComponent(call.model)}&format=${call.format}`;
  if (call.chunkMs !== undefined && partHolds(call.provision, "parameter:chunkMs")) url += `&chunkMs=${call.chunkMs}`;
  if (claims && call.session !== undefined) url += `&session=${encodeURIComponent(call.session)}`;
  if (claims && call.takeover) url += "&takeover=1";
  return url;
}

class StreamSocket implements StreamSession {
  private ws: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Set while mute holds transmission, so audio is dropped but KeepAlive is not. */
  private sending = true;
  /**
   * One entry per `Finalize` still awaiting its final, oldest first. The server answers
   * each with exactly one final covering the audio since the previous one, so the oldest
   * entry is always the next final's answer. `sentAt` measures the wait for the settled
   * transcript, which tells a streaming model from a batch one.
   */
  private finalizeQueue: Array<{ sentAt: number }> = [];
  /** Frames captured before the socket opened, sent once it does. */
  private preOpen: ArrayBuffer[] = [];

  private cb: StreamCallbacks;

  constructor(cb: StreamCallbacks) {
    this.cb = cb;
  }

  connect(call: StreamCall): void {
    const ws = new WebSocket(socketUrl(call));
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onmessage = (e) => this.handleMessage(e);
    // A close and an error both end the session, and a failed connection fires both; `closed` makes the report happen once.
    ws.onerror = () => this.finish("The connection to the transcription service failed.");
    ws.onclose = (e) => this.finish(
      e.reason ? `The connection closed: ${e.reason}` : "The connection closed.",
      CLOSE_CODES[e.code] ?? null,
    );
    ws.onopen = () => {
      this.keepAlive = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL_MS);
      this.flushPreOpen();
    };
  }

  private handleMessage(e: MessageEvent): void {
    let msg: { type?: string; is_final?: boolean; text?: string; model?: string; format?: string; message?: string; code?: string };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }

    if (msg.type === "transcript") {
      if (msg.is_final) {
        const oldest = this.finalizeQueue.shift();
        const sentAt = oldest?.sentAt ?? null;
        this.cb.onFinal(msg.text ?? "", sentAt === null ? null : Math.round(performance.now() - sentAt));
      } else {
        this.cb.onPartial(msg.text ?? "");
      }
      return;
    }
    if (msg.type === "ready") {
      this.cb.onReady(msg.model ?? "", msg.format ?? "");
      return;
    }
    if (msg.type === "error") {
      // The server closes after an error frame; reporting here names the actual cause rather than the bare close that follows.
      this.finish(msg.message ?? "The transcription service reported an error.", msg.code ?? null);
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.closed;
  }

  sendAudio(frame: ArrayBuffer): void {
    if (!this.sending || this.closed) return;
    if (!this.isOpen) {
      // Held, not dropped: capture begins before the socket finishes opening, and discarding here loses the start of the first turn.
      if (this.preOpen.length < PRE_OPEN_FRAME_LIMIT) this.preOpen.push(frame);
      return;
    }
    this.ws?.send(frame);
  }

  private flushPreOpen(): void {
    const held = this.preOpen;
    this.preOpen = [];
    for (const frame of held) {
      if (!this.isOpen) return;
      this.ws?.send(frame);
    }
  }

  setSending(sending: boolean): void {
    this.sending = sending;
  }

  /** Callable any number of times with earlier calls outstanding; each queues its own slot, answered in the order the finals arrive. */
  finalize(): void {
    if (!this.isOpen) return;
    this.finalizeQueue.push({ sentAt: performance.now() });
    this.ws?.send(JSON.stringify({ type: "Finalize" }));
  }

  private sendKeepAlive(): void {
    if (!this.isOpen) return;
    this.ws?.send(JSON.stringify({ type: "KeepAlive" }));
  }

  /** `CloseStream` lets the server end it as a client close rather than a dropped socket; the final it sends back is discarded, since the socket detaches before it arrives. */
  close(): void {
    if (this.isOpen) this.ws?.send(JSON.stringify({ type: "CloseStream" }));
    this.teardown();
  }

  private finish(reason: string, code: string | null = null): void {
    if (this.closed) return;
    this.teardown();
    this.cb.onClosed(reason, code);
  }

  private teardown(): void {
    this.closed = true;
    this.preOpen = [];
    this.finalizeQueue = [];
    if (this.keepAlive !== null) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      // Detached from its handlers first: closing here must not re-enter finish() through onclose.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }
  }
}

export function transcribeStream(call: StreamCall, callbacks: StreamCallbacks): StreamSession {
  const socket = new StreamSocket(callbacks);
  socket.connect(call);
  return socket;
}
