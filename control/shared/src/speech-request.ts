// The resolution a node makes for a runtime on its own machine: the shard on
// POST /api/voices/resolve, or the control plane for a runtime on its host.
// The synthesis adapter encodes it for the wire (dev/specs/service-apis.md, section 11).

import { readFileSync } from "node:fs";
import { resolveVoiceForModel } from "./roster";
import type { Resolution } from "../../../shared/apis/types";
import type { NodeRoster } from "../../../shared/types";

/** A runtime that resolves voices itself is given the platform's model and voice ids; any other
 *  is given its own key for the model and either the preset's key or the recording's path
 *  (with the transcript's contents when the model uses one), plus the serving's request parameters. */
export function resolveSpeech(
  roster: NodeRoster,
  serviceId: string,
  model: string,
  voice: string
): { ok: true; resolution: Resolution } | { ok: false; error: string } {
  const resolved = resolveVoiceForModel(roster, serviceId, model, voice);
  if (resolved.kind === "refused") return { ok: false, error: resolved.reason };

  const provider = roster.providers[serviceId];
  if (provider.resolvesVoices === true) return { ok: true, resolution: { model, voice: { name: voice } } };

  const params = provider.serves.find(s => s.model === model)?.requestParams;
  const withParams = (resolution: Resolution): Resolution => (params ? { ...resolution, params } : resolution);
  if (resolved.kind === "preset") {
    return { ok: true, resolution: withParams({ model: resolved.modelKey, voice: { name: resolved.voice } }) };
  }
  if (!resolved.sendText) {
    return { ok: true, resolution: withParams({ model: resolved.modelKey, voice: { recording: resolved.recording.audio } }) };
  }
  try {
    const transcript = readFileSync(resolved.recording.text, "utf-8");
    return { ok: true, resolution: withParams({ model: resolved.modelKey, voice: { recording: resolved.recording.audio, transcript } }) };
  } catch (err) {
    return { ok: false, error: `voice "${voice}" on model "${model}": transcript unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
