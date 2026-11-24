// Client for OpenAI's Realtime API in transcription mode (the pinned client-event and server-event
// reference pages). The adapter turns Realtime's events into the guarantees of `transcribeStream`:
// the utterance so far in each partial, and exactly one final per finalize, in the order they were asked.

import { socketAddress, StreamSocketBase } from "./stream-socket";
import type { AdapterDeclaration, Provision, StreamCall, StreamCallbacks, StreamSession } from "../types";

export const declaration: AdapterDeclaration = {
  api: "openai.realtime",
  operations: ["transcribeStream"],
  requires: {
    transcribeStream: [
      "mode:transcription",
      "client-message:session.update",
      "client-message:input_audio_buffer.append",
      "client-message:input_audio_buffer.commit",
      "server-message:input_audio_buffer.committed",
      "server-message:conversation.item.input_audio_transcription.completed",
    ],
  },
  uses: {
    transcribeStream: [
      "server-message:conversation.item.input_audio_transcription.delta",
      "client-message:input_audio_buffer.clear",
      "opus-input",
    ],
  },
  capabilities: {
    "client-endpointing": [{ spec: true }],
    opus: [{ extension: "opus-input" }],
  },
};

/** The sample rate of the PCM the session asks for, and of the engine's own audio. */
const SESSION_RATE = 24000;
const ENGINE_RATE = 16000;

/** The route's path under the endpoint: the spec's, with `basePath` standing in for `/v1`. */
export function streamPath(provision: Provision): string {
  return `${provision.basePath ?? "/v1"}/realtime`;
}

/** 16-bit little-endian samples at the engine's rate, linearly interpolated to the session's. */
function resample(frame: ArrayBuffer): ArrayBuffer {
  const input = new Int16Array(frame, 0, Math.floor(frame.byteLength / 2));
  const output = new Int16Array(Math.floor((input.length * SESSION_RATE) / ENGINE_RATE));
  const step = ENGINE_RATE / SESSION_RATE;
  for (let i = 0; i < output.length; i++) {
    const at = i * step;
    const low = Math.floor(at);
    const high = Math.min(low + 1, input.length - 1);
    output[i] = Math.round(input[low] + (input[high] - input[low]) * (at - low));
  }
  return output.buffer;
}

function base64(bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** One finalize, answered in order. A turn with audio waits on its item's completed transcript. */
interface Turn {
  sentAt: number;
  /** Set when the server's `committed` names the turn's item; absent for a turn with no audio. */
  itemId?: string;
  committed: boolean;
  text: string | null;
}

class RealtimeSocket extends StreamSocketBase {
  private call: StreamCall;
  private turns: Turn[] = [];
  /** Audio has gone out since the last commit. */
  private audioSinceCommit = false;
  /** Deltas so far, per item. */
  private deltas = new Map<string, string>();
  /** Completed transcripts that arrived before their `committed` named the item. */
  private completed = new Map<string, string>();

  constructor(call: StreamCall, cb: StreamCallbacks) {
    super(cb);
    this.call = call;
    const opus = call.format === "opus";
    if (opus && !call.provision.extends?.includes("opus-input")) {
      queueMicrotask(() => { this.finish("The transcription service does not accept Opus input.") });
      return;
    }
    this.open(`${socketAddress(call.endpoint, streamPath(call.provision))}?intent=transcription`);
  }

  protected onOpen(): void {
    const opus = this.call.format === "opus";
    const input: Record<string, unknown> = {
      format: opus ? { type: "audio/opus", rate: 48000 } : { type: "audio/pcm", rate: SESSION_RATE },
      turn_detection: null,
    };
    if (this.call.model) input.transcription = { model: this.call.model };
    this.sendText(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input } } }));
  }

  protected encodeAudio(frame: ArrayBuffer): string {
    this.audioSinceCommit = true;
    const audio = this.call.format === "opus" ? frame : resample(frame);
    return JSON.stringify({ type: "input_audio_buffer.append", audio: base64(audio) });
  }

  protected onTeardown(): void {
    this.turns = [];
    this.deltas.clear();
    this.completed.clear();
  }

  finalize(): void {
    if (!this.isOpen) return;
    const turn: Turn = { sentAt: performance.now(), committed: false, text: null };
    if (this.audioSinceCommit) {
      this.audioSinceCommit = false;
      this.sendText(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } else {
      // Committing an empty buffer is an error, so this turn is answered empty with no commit.
      turn.text = "";
    }
    this.turns.push(turn);
    this.release();
  }

  /** Answers the finalizes from the oldest while each has its text, so finals keep the order of the finalizes. */
  private release(): void {
    while (this.turns[0]?.text !== null && this.turns[0] !== undefined) {
      const turn = this.turns.shift()!;
      this.cb.onFinal(turn.text!, Math.round(performance.now() - turn.sentAt));
    }
  }

  protected onMessage(text: string): void {
    let msg: { type?: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.type) {
      case "session.updated":
        this.cb.onReady(this.call.model ?? "", this.call.format);
        break;
      case "input_audio_buffer.committed": {
        // Commits are answered in order, so this names the oldest turn that was committed and has no item yet.
        const turn = this.turns.find((t) => t.text === null && !t.committed);
        if (!turn || msg.item_id === undefined) break;
        turn.committed = true;
        turn.itemId = msg.item_id;
        const early = this.completed.get(msg.item_id);
        if (early !== undefined) this.settle(msg.item_id, early);
        break;
      }
      case "conversation.item.input_audio_transcription.delta":
        if (msg.item_id !== undefined) {
          const so_far = (this.deltas.get(msg.item_id) ?? "") + (msg.delta ?? "");
          this.deltas.set(msg.item_id, so_far);
          this.cb.onPartial(so_far);
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (msg.item_id !== undefined) this.settle(msg.item_id, msg.transcript ?? "");
        break;
      case "conversation.item.input_audio_transcription.failed":
        if (msg.item_id !== undefined) this.settle(msg.item_id, "");
        break;
      case "error":
        this.finish(msg.error?.message ?? "The transcription service reported an error.");
        break;
    }
  }

  private settle(itemId: string, transcript: string): void {
    const turn = this.turns.find((t) => t.itemId === itemId);
    if (!turn) {
      this.completed.set(itemId, transcript);
      return;
    }
    this.completed.delete(itemId);
    this.deltas.delete(itemId);
    turn.text = transcript;
    this.release();
  }
}

export function transcribeStream(call: StreamCall, callbacks: StreamCallbacks): StreamSession {
  return new RealtimeSocket(call, callbacks);
}
