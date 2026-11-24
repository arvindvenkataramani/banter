// Client for Deepgram's live transcription channel (the pinned AsyncAPI document, channel /v1/listen).
// The adapter turns Deepgram's results into the guarantees of `transcribeStream`: the whole utterance
// in each partial, and exactly one final per `Finalize`, an empty one included.

import { partHolds } from "../parts";
import { socketAddress, StreamSocketBase } from "./stream-socket";
import type { AdapterDeclaration, Provision, StreamCall, StreamCallbacks, StreamSession } from "../types";

export const declaration: AdapterDeclaration = {
  api: "deepgram.listen.live",
  operations: ["transcribeStream"],
  requires: {
    transcribeStream: ["client-message:Finalize", "server-message:Results", "parameter:endpointing"],
  },
  uses: {
    transcribeStream: [
      "client-message:KeepAlive",
      "client-message:CloseStream",
      "parameter:model",
      "finalize-answered",
      "session-claim",
      "opus-packets",
    ],
  },
  capabilities: {
    "client-endpointing": [{ extension: "endpointing-off" }],
    // Opus packets are carried only when `opus` has not been restricted out of `encoding`.
    opus: [{ extension: "opus-packets", part: "value:encoding=opus" }],
    takeover: [{ extension: "session-claim" }],
    "session-loads": [{ part: "parameter:model" }],
  },
};

/** How long a `Finalize` waits for its answer from a server that does not declare `finalize-answered`. */
const FINALIZE_WAIT_MS = 3000;

/** The audio the engine hands every stream adapter: 16 kHz mono, as pcm16 or as Opus packets. */
const SAMPLE_RATE = 16000;

/** The channel's path under the endpoint: the spec's, behind the provision's `basePath`. */
export function streamPath(provision: Provision): string {
  return `${provision.basePath ?? ""}/v1/listen`;
}

interface Finalizing {
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The words of the segments, one space apart, leaving out empty ones. */
const joined = (parts: string[]): string => parts.filter((p) => p !== "").join(" ");

class ListenSocket extends StreamSocketBase {
  private call: StreamCall;
  /** Segments Deepgram has settled since the last final. */
  private settled: string[] = [];
  /** The segment still being refined. */
  private interim = "";
  /** One entry per `Finalize` awaiting its answer, oldest first. */
  private finalizing: Finalizing[] = [];

  constructor(call: StreamCall, cb: StreamCallbacks) {
    super(cb);
    this.call = call;
    this.connect();
  }

  private connect(): void {
    const { provision, format } = this.call;
    if (format === "opus" && !(provision.extends?.includes("opus-packets") && partHolds(provision, "value:encoding=opus"))) {
      queueMicrotask(() => { this.finish("The transcription service does not accept Opus packets.") });
      return;
    }
    const claims = provision.extends?.includes("session-claim") === true;
    // The adapter never leans on a server's default for what it depends on: endpointing is sent off.
    const query = new URLSearchParams({
      encoding: format === "opus" ? "opus" : "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      endpointing: "false",
    });
    if (this.call.model && partHolds(provision, "parameter:model")) query.set("model", this.call.model);
    if (claims && this.call.session !== undefined) query.set("session", this.call.session);
    if (claims && this.call.takeover) query.set("takeover", "1");
    this.open(`${socketAddress(this.call.endpoint, streamPath(provision))}?${query}`);
  }

  protected onOpen(): void {
    this.cb.onReady(this.call.model ?? "", this.call.format);
  }

  protected keepAliveMessage(): string {
    return JSON.stringify({ type: "KeepAlive" });
  }

  protected closeMessage(): string {
    return JSON.stringify({ type: "CloseStream" });
  }

  protected onTeardown(): void {
    for (const f of this.finalizing) if (f.timer !== null) clearTimeout(f.timer);
    this.finalizing = [];
    this.settled = [];
    this.interim = "";
  }

  protected onMessage(text: string): void {
    let msg: { type?: string; is_final?: boolean; from_finalize?: boolean; channel?: { alternatives?: { transcript?: string }[] } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type !== "Results") return;
    const transcript = msg.channel?.alternatives?.[0]?.transcript ?? "";

    if (msg.from_finalize) {
      // An answer nobody is waiting for, such as one that came after the wait ended, settles nothing.
      if (this.finalizing.length > 0) this.settle(transcript);
      return;
    }
    if (msg.is_final) {
      this.settled.push(transcript);
      this.interim = "";
    } else {
      this.interim = transcript;
    }
    this.cb.onPartial(joined([...this.settled, this.interim]));
  }

  /** Answers the oldest `Finalize` with the utterance so far, the answering segment standing in for the interim one. */
  private settle(tail: string): void {
    const oldest = this.finalizing.shift();
    if (!oldest) return;
    if (oldest.timer !== null) clearTimeout(oldest.timer);
    const text = joined([...this.settled, tail]);
    this.settled = [];
    this.interim = "";
    this.cb.onFinal(text, Math.round(performance.now() - oldest.sentAt));
  }

  finalize(): void {
    if (!this.isOpen) return;
    const entry: Finalizing = { sentAt: performance.now(), timer: null };
    // A server that does not declare finalize-answered may never answer, so the wait is bounded.
    if (!this.call.provision.extends?.includes("finalize-answered")) {
      entry.timer = setTimeout(() => {
        if (this.finalizing.includes(entry)) this.settle(this.interim);
      }, FINALIZE_WAIT_MS);
    }
    this.finalizing.push(entry);
    this.sendText(JSON.stringify({ type: "Finalize" }));
  }
}

export function transcribeStream(call: StreamCall, callbacks: StreamCallbacks): StreamSession {
  return new ListenSocket(call, callbacks);
}
