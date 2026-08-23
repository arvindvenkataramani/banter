// JSONL capture sink for raw gateway frames.
//
// Two rules shape this file, both learned the hard way:
//
// 1. Every event family is recorded. The previous capture tooling was typed
//    'chat' | 'session.message', which is why the tool stream stayed invisible
//    for three weeks. Nothing here may narrow by event name.
// 2. Frames are tapped raw, before any normalization. Normalization is our
//    interpretation; the question a capture answers is what the gateway sent.
//
// Session scope is a separate axis from event family. Frames belonging to a
// session we were not asked to watch are reduced to an envelope — routing
// fields only, no content — so a capture never becomes a transcript of an
// unrelated conversation.

import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CaptureSinkOptions {
  path: string;
  /** Sessions whose frames are recorded in full. */
  allowedSessionKeys: string[];
  /** Record every session in full. Opt-in, for whole-gateway scenarios. */
  allowAll: boolean;
}

type FrameDirection = "in" | "out";

interface AnyFrame {
  type?: string;
  event?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

const REDACTED = { redacted: true } as const;

export class CaptureSink {
  private fd: number;
  private allowed: Set<string>;
  private allowAll: boolean;
  private closed = false;
  readonly path: string;

  constructor(opts: CaptureSinkOptions) {
    this.path = opts.path;
    this.allowed = new Set(opts.allowedSessionKeys);
    this.allowAll = opts.allowAll;
    mkdirSync(dirname(opts.path), { recursive: true });
    this.fd = openSync(opts.path, "a");
  }

  /** Adds a session to the allowlist mid-run, for scenarios that discover one. */
  allowSession(sessionKey: string) {
    this.allowed.add(sessionKey);
  }

  recordFrame(dir: FrameDirection, raw: string) {
    if (this.closed) return;
    const tMono = performance.now();
    const tWall = Date.now();

    let frame: AnyFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.write({ kind: "unparsed", dir, tMono, tWall, raw });
      return;
    }

    const sessionKey = readSessionKey(frame);
    if (this.isInScope(frame, sessionKey)) {
      this.write({ kind: "frame", dir, tMono, tWall, frame: sanitize(frame) });
      return;
    }

    // Out of scope: keep the shape of the traffic, drop what it says.
    this.write({
      kind: "envelope",
      dir,
      tMono,
      tWall,
      type: frame.type,
      event: frame.event,
      sessionKey,
      runId: readString(frame.payload?.runId),
      stream: readString(frame.payload?.stream),
      phase: readString((frame.payload?.data as Record<string, unknown> | undefined)?.phase),
      seq: readNumber(frame.payload?.seq) ?? readNumber(frame.seq),
      messageSeq: readNumber(frame.payload?.messageSeq),
    });
  }

  /** Records a scenario boundary so captures can be sliced by test step. */
  recordMarker(label: string, data?: Record<string, unknown>) {
    if (this.closed) return;
    this.write({
      kind: "marker",
      tMono: performance.now(),
      tWall: Date.now(),
      label,
      ...(data ? { data } : {}),
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }

  private isInScope(frame: AnyFrame, sessionKey: string | undefined): boolean {
    if (this.allowAll) return true;
    // sessions.changed carries every session's metadata, including titles
    // derived from message text. It has no single sessionKey to filter on.
    if (frame.event === "sessions.changed") return false;
    // Handshake, tick, shutdown and other connection-level frames belong to
    // this connection, not to any session.
    if (sessionKey === undefined) return true;
    return this.allowed.has(sessionKey);
  }

  private write(entry: Record<string, unknown>) {
    writeSync(this.fd, JSON.stringify(entry) + "\n");
  }
}

function readSessionKey(frame: AnyFrame): string | undefined {
  const direct = readString(frame.payload?.sessionKey);
  if (direct) return direct;
  const params = frame.params as Record<string, unknown> | undefined;
  return readString(params?.sessionKey) ?? readString(params?.key);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// Strips secrets and the compaction summary. Everything else is preserved
// byte-for-byte — a capture is evidence, not a summary.
function sanitize(frame: AnyFrame): AnyFrame {
  let out = frame;

  const params = frame.params as Record<string, unknown> | undefined;
  if (params?.auth) {
    out = { ...out, params: { ...params, auth: REDACTED } };
  }

  const auth = out.auth as Record<string, unknown> | undefined;
  if (auth) {
    const cleaned: Record<string, unknown> = { ...auth };
    if ("deviceToken" in cleaned) cleaned.deviceToken = REDACTED;
    if ("deviceTokens" in cleaned) cleaned.deviceTokens = REDACTED;
    out = { ...out, auth: cleaned };
  }

  const summaryBytes = compactionSummaryBytes(out.payload);
  if (summaryBytes !== undefined) {
    const payload = out.payload as Record<string, unknown>;
    const session = payload.session as Record<string, unknown>;
    const checkpoint = session.latestCompactionCheckpoint as Record<string, unknown>;
    out = {
      ...out,
      payload: {
        ...payload,
        session: {
          ...session,
          latestCompactionCheckpoint: {
            ...checkpoint,
            summary: { omitted: true, bytes: summaryBytes },
          },
        },
      },
    };
  }

  return out;
}

// Multi-KB on long-running sessions. Recording the byte length keeps the
// omission visible rather than silently shrinking the payload.
function compactionSummaryBytes(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const session = (payload as Record<string, unknown>).session;
  if (!session || typeof session !== "object") return undefined;
  const checkpoint = (session as Record<string, unknown>).latestCompactionCheckpoint;
  if (!checkpoint || typeof checkpoint !== "object") return undefined;
  const summary = (checkpoint as Record<string, unknown>).summary;
  if (typeof summary !== "string") return undefined;
  return Buffer.byteLength(summary, "utf8");
}
