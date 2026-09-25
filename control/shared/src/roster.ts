// Must be called with the same registry's services already validated, so a
// provider naming no service fails before the node starts.

import { CHUNK_STRATEGIES } from "../../../shared/types";
import type {
  ChunkStrategy,
  Cloning,
  NodeRoster,
  Provider,
  Service,
  TtsModel,
  VoiceReference,
} from "../../../shared/types";
import { CLONE_KEY, RESPONSE_FORMATS } from "../../../shared/types";

/** A registry with no roster section has this — never undefined once
 *  loaded, so every reader can treat `registry.roster` as present. */
export function emptyRoster(): NodeRoster {
  return { providers: {}, voices: [] };
}

/** Whether a recording meets what a model asks of one. */
export function satisfies(ref: VoiceReference, cloning: Cloning): boolean {
  if (cloning.requiresText === true && ref.text === undefined) return false;
  if (cloning.minDurationS !== undefined && ref.durationS < cloning.minDurationS) return false;
  if (cloning.maxDurationS !== undefined && ref.durationS > cloning.maxDurationS) return false;
  if (cloning.sampleRate !== undefined && ref.sampleRate !== cloning.sampleRate) return false;
  return true;
}

export function validateRoster(data: unknown, services: Service[]): NodeRoster {
  if (data === undefined) {
    return emptyRoster();
  }
  const d = data as Record<string, unknown>;
  if (typeof d.providers !== "object" || d.providers === null || Array.isArray(d.providers)) {
    throw new Error("registry.json roster: providers must be an object keyed by registry service id");
  }

  const declaredModels = new Map<string, TtsModel>();
  const ttsModelIds = new Set<string>();

  for (const [serviceId, raw] of Object.entries(d.providers as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`registry.json roster: providers["${serviceId}"] must be an object`);
    }
    const provider = raw as Record<string, unknown>;
    if (!services.some(s => s.id === serviceId)) {
      throw new Error(`registry.json roster: providers["${serviceId}"] names no service in the registry`);
    }
    if (provider.ttsModels === undefined && provider.sttModels === undefined) {
      throw new Error(`registry.json roster: providers["${serviceId}"] declares no models`);
    }
    if (
      provider.responseFormat !== undefined &&
      !(RESPONSE_FORMATS as readonly unknown[]).includes(provider.responseFormat)
    ) {
      throw new Error(
        `registry.json roster: providers["${serviceId}"].responseFormat must be one of ${RESPONSE_FORMATS.join(", ")}`
      );
    }
    if (provider.sessions !== undefined && typeof provider.sessions !== "boolean") {
      throw new Error(`registry.json roster: providers["${serviceId}"].sessions must be true or false`);
    }

    for (const [field, models] of [["ttsModels", provider.ttsModels], ["sttModels", provider.sttModels]] as const) {
      if (models === undefined) continue;
      if (!Array.isArray(models) || models.length === 0) {
        throw new Error(`registry.json roster: providers["${serviceId}"].${field} must be a non-empty array`);
      }
      for (const entry of models as Record<string, unknown>[]) {
        for (const key of ["id", "name", "key"]) {
          if (typeof entry[key] !== "string" || (entry[key] as string).length === 0) {
            throw new Error(`registry.json roster: providers["${serviceId}"].${field} entry has no ${key}`);
          }
        }
        if (field === "ttsModels") {
          const where = `providers["${serviceId}"].ttsModels["${entry.id}"]`;
          // Model ids are served keyed by id alone, so two providers sharing
          // one would leave it unreachable.
          if (ttsModelIds.has(entry.id as string)) {
            throw new Error(`registry.json roster: ${where} reuses a synthesis model id another provider declares`);
          }
          ttsModelIds.add(entry.id as string);
          for (const flag of ["realtime", "streaming"]) {
            if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") {
              throw new Error(`registry.json roster: ${where}.${flag} must be true or false`);
            }
          }
          if (entry.concurrency !== undefined && !(Number.isInteger(entry.concurrency) && (entry.concurrency as number) > 0)) {
            throw new Error(`registry.json roster: ${where}.concurrency must be a positive integer`);
          }
          const chunking = entry.chunking as TtsModel["chunking"] | undefined;
          if (chunking !== undefined && chunking.mode !== undefined && !CHUNK_STRATEGIES.includes(chunking.mode as ChunkStrategy)) {
            throw new Error(`registry.json roster: ${where}.chunking.mode must be one of ${CHUNK_STRATEGIES.join(", ")}`);
          }
          declaredModels.set(`${serviceId}\u0000${entry.id as string}`, entry as unknown as TtsModel);
        } else if (!["batch", "streaming", "both"].includes(entry.kind as string)) {
          throw new Error(
            `registry.json roster: providers["${serviceId}"].sttModels["${entry.id}"].kind must be batch, streaming or both`
          );
        }
      }
    }
  }

  if (!Array.isArray(d.voices)) {
    throw new Error("registry.json roster: voices must be an array");
  }
  const voiceIds = new Set<string>();
  for (const raw of d.voices as Record<string, unknown>[]) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("registry.json roster: every voice must be an object");
    }
    const id = raw.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("registry.json roster: every voice needs a non-empty id");
    }
    if (voiceIds.has(id)) {
      throw new Error(`registry.json roster: voice "${id}" is declared twice`);
    }
    voiceIds.add(id);
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      throw new Error(`registry.json roster: voices["${id}"].name must be a non-empty string`);
    }

    const references = (raw.references ?? []) as VoiceReference[];
    if (!Array.isArray(references)) {
      throw new Error(`registry.json roster: voices["${id}"].references must be an array`);
    }
    for (const ref of references) {
      if (typeof ref.audio !== "string" || ref.audio.length === 0) {
        throw new Error(`registry.json roster: voices["${id}"] has a reference with no audio path`);
      }
      if (typeof ref.durationS !== "number" || ref.durationS <= 0) {
        throw new Error(`registry.json roster: voices["${id}"] reference "${ref.audio}" needs a positive durationS`);
      }
      if (!Number.isInteger(ref.sampleRate) || ref.sampleRate <= 0) {
        throw new Error(`registry.json roster: voices["${id}"] reference "${ref.audio}" needs a positive sampleRate`);
      }
    }

    if (!Array.isArray(raw.models) || raw.models.length === 0) {
      throw new Error(`registry.json roster: voices["${id}"].models must be a non-empty array`);
    }
    for (const link of raw.models as { serviceId: string; model: string; key: string }[]) {
      if (typeof link.serviceId !== "string" || typeof link.model !== "string" || typeof link.key !== "string") {
        throw new Error(`registry.json roster: voices["${id}"].models entries need serviceId, model and key`);
      }
      const model = declaredModels.get(`${link.serviceId}\u0000${link.model}`);
      if (!model) {
        throw new Error(
          `registry.json roster: voices["${id}"] names model "${link.model}" on "${link.serviceId}", which declares no such synthesis model`
        );
      }
      if (link.key !== CLONE_KEY) {
        // A preset: the model must actually know that name, or the render
        // returns some default voice and nobody is told.
        const presets = model.presetVoices ?? [];
        if (!presets.some(p => p.id === link.key)) {
          throw new Error(
            `registry.json roster: voices["${id}"] claims preset "${link.key}" on "${link.model}", which does not offer it`
          );
        }
        continue;
      }
      if (model.cloning?.available !== true) {
        throw new Error(
          `registry.json roster: voices["${id}"] asks to clone under "${link.model}", which cannot clone`
        );
      }
      const usable = references.filter(ref => satisfies(ref, model.cloning!));
      if (usable.length === 0) {
        throw new Error(
          `registry.json roster: voices["${id}"] has no recording meeting what "${link.model}" requires of one`
        );
      }
    }
  }

  return { providers: d.providers as Record<string, Provider>, voices: d.voices as NodeRoster["voices"] };
}
