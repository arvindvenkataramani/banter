// What the WebSocket transcription adapters share: the socket's lifecycle, the audio held while it
// opens, the keep-alive, and the single report when the session ends. A socket dies once and is
// not reopened; reconnecting means opening another, which is the voice loop's work.

import { trimEndpoint } from "./http";
import type { StreamCallbacks, StreamSession } from "../types";

/** Close codes 4001 to 4010 name the protocol's error codes; a close in this range with no error frame before it still reports one. */
export const CLOSE_CODES: Record<number, string> = {
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

/** Proof the client is alive while it sends no audio. */
export const KEEPALIVE_INTERVAL_MS = 4000;

/** Frames to hold while the socket opens: a couple of seconds at 4096 samples per frame, bounded so a socket that never opens cannot grow this without limit. */
const PRE_OPEN_FRAME_LIMIT = 24;

/** The WebSocket address of an endpoint: its scheme swapped, then the path and query. */
export const socketAddress = (endpoint: string, path: string): string => `${trimEndpoint(endpoint).replace(/^http/, "ws")}${path}`;

export abstract class StreamSocketBase implements StreamSession {
  private ws: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private sending = true;
  private preOpen: ArrayBuffer[] = [];
  protected cb: StreamCallbacks;

  constructor(cb: StreamCallbacks) {
    this.cb = cb;
  }

  /** What to send once the socket is open, before any audio. */
  protected abstract onOpen(): void;
  protected abstract onMessage(text: string): void;
  /** What an audio frame goes out as. */
  protected encodeAudio(frame: ArrayBuffer): string | ArrayBuffer {
    return frame;
  }
  /** What goes out on the keep-alive timer, or null for a protocol that has none. */
  protected keepAliveMessage(): string | null {
    return null;
  }
  /** What goes out on a deliberate close, or null. */
  protected closeMessage(): string | null {
    return null;
  }
  /** Called when the session ends, whichever side ended it. */
  protected onTeardown(): void {}

  abstract finalize(): void;

  protected open(url: string): void {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(String(e.data));
    // A close and an error both end the session, and a failed connection fires both; `closed` makes the report happen once.
    ws.onerror = () => this.finish("The connection to the transcription service failed.");
    ws.onclose = (e) => this.finish(
      e.reason ? `The connection closed: ${e.reason}` : "The connection closed.",
      CLOSE_CODES[e.code] ?? null,
    );
    ws.onopen = () => {
      this.onOpen();
      if (this.keepAliveMessage() !== null) this.keepAlive = setInterval(() => this.sendText(this.keepAliveMessage()), KEEPALIVE_INTERVAL_MS);
      this.flushPreOpen();
    };
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !this.closed;
  }

  protected sendText(text: string | null): void {
    if (text !== null && this.isOpen) this.ws?.send(text);
  }

  sendAudio(frame: ArrayBuffer): void {
    if (!this.sending || this.closed) return;
    if (!this.isOpen) {
      // Held, not dropped: capture begins before the socket finishes opening, and discarding here loses the start of the first turn.
      if (this.preOpen.length < PRE_OPEN_FRAME_LIMIT) this.preOpen.push(frame);
      return;
    }
    this.ws?.send(this.encodeAudio(frame));
  }

  private flushPreOpen(): void {
    const held = this.preOpen;
    this.preOpen = [];
    for (const frame of held) {
      if (!this.isOpen) return;
      this.ws?.send(this.encodeAudio(frame));
    }
  }

  setSending(sending: boolean): void {
    this.sending = sending;
  }

  close(): void {
    this.sendText(this.closeMessage());
    this.teardown();
  }

  /** Ends the session and reports it once. */
  protected finish(reason: string, code: string | null = null): void {
    if (this.closed) return;
    this.teardown();
    this.cb.onClosed(reason, code);
  }

  private teardown(): void {
    this.closed = true;
    this.preOpen = [];
    this.onTeardown();
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
