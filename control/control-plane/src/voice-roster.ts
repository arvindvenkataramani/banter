// Ids here are roster ids, which is what a selection stores. `key` is what
// the TTS runtime is sent in their place.

import { satisfies } from "../../shared/src/roster";
import type { AssembledRoster, AssembledVoice } from "./roster-assembly";
import type { Cloning, ResponseFormat } from "../../../shared/types";
import { CLONE_KEY } from "../../../shared/types";

export interface VoiceModeVoice {
  id: string;
  name: string;
  key: string;
  /** Sent in place of a preset name when the model clones her. */
  ref_audio?: string;
}

export interface VoiceModeModel {
  id: string;
  name: string;
  key: string;
  realtime?: boolean;
  streaming?: boolean;
  chunking?: { mode?: string; minWords?: number; maxWords?: number };
  concurrency?: number;
  requestParams?: Record<string, unknown>;
  voices: VoiceModeVoice[];
}

export interface VoiceModeProvider {
  serviceId: string;
  hostId: string;
  reachable: boolean;
  name: string;
  /** What this runtime returns from /v1/audio/speech; the dashboard requests
   *  and decodes this. */
  responseFormat: ResponseFormat;
  models: VoiceModeModel[];
  /** Whether this runtime's streaming socket understands session ids and
   *  take-over, the way it carries responseFormat. Absent means no. */
  sessions?: boolean;
}

/** Uses the same compatibility check as validateRoster, so a reference sent
 *  here is never one the model would reject. */
function voicesFor(
  voices: AssembledVoice[],
  hostId: string,
  serviceId: string,
  modelId: string,
  cloning: Cloning | undefined,
  presetVoices: { id: string; name: string }[] | undefined
): VoiceModeVoice[] {
  const result: VoiceModeVoice[] = [];
  const claimedKeys = new Set<string>();
  for (const voice of voices) {
    const link = voice.models.find(m => m.hostId === hostId && m.serviceId === serviceId && m.model === modelId);
    if (!link) continue;
    if (link.key === CLONE_KEY) {
      const reference = cloning ? link.references.find(ref => satisfies(ref, cloning)) : undefined;
      result.push({
        id: voice.id,
        name: voice.name,
        key: voice.id,
        ...(reference !== undefined && { ref_audio: reference.audio }),
      });
    } else {
      result.push({ id: voice.id, name: voice.name, key: link.key });
      claimedKeys.add(link.key);
    }
  }
  for (const preset of presetVoices ?? []) {
    if (claimedKeys.has(preset.id)) continue;
    result.push({ id: preset.id, name: preset.name, key: preset.id });
  }
  return result;
}

export function voiceModeProviders(assembly: AssembledRoster): VoiceModeProvider[] {
  const providers: VoiceModeProvider[] = [];
  for (const provider of assembly.providers) {
    if (provider.ttsModels === undefined) continue;
    providers.push({
      serviceId: provider.serviceId,
      hostId: provider.hostId,
      reachable: provider.reachable,
      name: provider.name,
      responseFormat: provider.responseFormat,
      ...(provider.sessions !== undefined && { sessions: provider.sessions }),
      models: provider.ttsModels.map(m => ({
        id: m.id,
        name: m.name,
        key: m.key,
        ...(m.realtime !== undefined && { realtime: m.realtime }),
        ...(m.streaming !== undefined && { streaming: m.streaming }),
        ...(m.chunking !== undefined && { chunking: m.chunking }),
        ...(m.concurrency !== undefined && { concurrency: m.concurrency }),
        ...(m.requestParams !== undefined && { requestParams: m.requestParams }),
        voices: voicesFor(assembly.voices, provider.hostId, provider.serviceId, m.id, m.cloning, m.presetVoices),
      })),
    });
  }
  return providers;
}
