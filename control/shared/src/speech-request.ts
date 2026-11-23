// The speech request a node builds for a runtime on its own machine: the shard
// on POST /api/voices/resolve, or the control plane for a runtime on its host.
// The caller sends it to the runtime unchanged.

import { readFileSync } from "node:fs";
import { resolveVoiceForModel } from "./roster";
import type { NodeRoster } from "../../../shared/types";

/** The body of a speech request for a runtime, built by the shared resolution
 *  rule. A runtime that resolves voices itself is sent the platform's model and
 *  voice ids; any other is sent its own key for the model and either the preset's
 *  key or the recording's path (with the transcript's contents when the model
 *  uses one), plus the serving's request parameters. */
export type SpeechRequest = { model: string; voice?: string; ref_audio?: string; ref_text?: string } & Record<string, unknown>;

export function buildSpeechRequest(
  roster: NodeRoster,
  serviceId: string,
  model: string,
  voice: string
): { ok: true; request: SpeechRequest } | { ok: false; error: string } {
  const resolved = resolveVoiceForModel(roster, serviceId, model, voice);
  if (resolved.kind === "refused") return { ok: false, error: resolved.reason };

  const provider = roster.providers[serviceId];
  if (provider.resolvesVoices === true) return { ok: true, request: { model, voice } };

  const requestParams = provider.serves.find(s => s.model === model)?.requestParams;
  if (resolved.kind === "preset") {
    return { ok: true, request: { ...requestParams, model: resolved.modelKey, voice: resolved.voice } };
  }
  const request: SpeechRequest = { ...requestParams, model: resolved.modelKey, ref_audio: resolved.recording.audio };
  if (resolved.sendText) {
    try {
      request.ref_text = readFileSync(resolved.recording.text, "utf-8");
    } catch (err) {
      return { ok: false, error: `voice "${voice}" on model "${model}": transcript unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true, request };
}
