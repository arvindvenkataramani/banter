// Load-time checks on a node's roster and the voice resolution rule
// (docs/reference/design/model-roster.md). validateRoster must be called with the same
// registry's services already validated, so a provider naming no service fails
// before the node starts.

import { CHUNK_STRATEGIES, RESPONSE_FORMATS } from "../../../shared/types";
import type {
  ChunkStrategy,
  Cloning,
  NodeRoster,
  Recording,
  Service,
  TtsModel,
} from "../../../shared/types";

/** A registry with no roster section has this — never undefined once
 *  loaded, so every reader can treat `registry.roster` as present. */
export function emptyRoster(): NodeRoster {
  return { ttsModels: [], sttModels: [], providers: {}, voices: [] };
}

/** Whether a recording meets what a model asks of one. Length bounds are inclusive. */
export function satisfies(rec: Recording, cloning: Cloning): boolean {
  if (cloning.requiresText === true && !rec.text) return false;
  if (cloning.minDurationS !== undefined && rec.durationS < cloning.minDurationS) return false;
  if (cloning.maxDurationS !== undefined && rec.durationS > cloning.maxDurationS) return false;
  if (cloning.sampleRate !== undefined && rec.sampleRate !== cloning.sampleRate) return false;
  return true;
}

/** What a runtime is sent for a voice under one model. `modelKey` is the serving's key. */
export type ResolvedVoice =
  /** The model's own name for the voice. */
  | { kind: "preset"; modelKey: string; voice: string }
  /** A recording to clone from; its transcript goes along only if `sendText`. */
  | { kind: "clone"; modelKey: string; recording: Recording; sendText: boolean }
  | { kind: "refused"; reason: string };

/** The voice resolution rule. The Swift twin is `TtsRoster.resolve` in
 *  services/fluid; schemas/voice-resolution-cases.json holds the cases both
 *  are tested against. */
export function resolveVoiceForModel(roster: NodeRoster, serviceId: string, modelId: string, voiceId: string): ResolvedVoice {
  const refuse = (why: string): ResolvedVoice => ({ kind: "refused", reason: `voice "${voiceId}" on model "${modelId}": ${why}` });

  const voice = roster.voices.find(v => v.id === voiceId);
  if (!voice) return refuse("no such voice");

  const serving = roster.providers[serviceId]?.serves.find(s => s.model === modelId);
  if (!serving) return refuse(`runtime "${serviceId}" does not serve the model`);

  const rendering = voice.renderings.find(r => r.model === modelId);
  if (!rendering) return refuse("the voice has no rendering on the model");

  if (rendering.method === "preset") return { kind: "preset", modelKey: serving.key, voice: rendering.key! };

  const cloning = (roster.ttsModels ?? []).find(m => m.id === modelId)?.cloning;
  const recording = cloning && (voice.recordings ?? []).find(r => satisfies(r, cloning));
  if (!recording) return refuse("the voice has no recording the model accepts");
  return { kind: "clone", modelKey: serving.key, recording, sendText: cloning!.requiresText === true };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const fail = (message: string): never => { throw new Error(`registry.json roster: ${message}`); };

export function validateRoster(data: unknown, services: Service[]): NodeRoster {
  if (data === undefined) return emptyRoster();
  if (!isObject(data)) return fail("must be an object");
  if (!isObject(data.providers)) fail("providers must be an object keyed by registry service id");
  if (!Array.isArray(data.voices)) fail("voices must be an array");
  for (const field of ["ttsModels", "sttModels"]) {
    if (data[field] !== undefined && !Array.isArray(data[field])) fail(`${field} must be an array`);
  }

  // Model ids are unique across both kinds: a duplicate would make a reference resolve to the wrong one.
  const ttsModels = new Map<string, Record<string, unknown>>();
  const sttModelIds = new Set<string>();
  const seenModelIds = new Set<string>();
  for (const field of ["ttsModels", "sttModels"] as const) {
    for (const entry of (data[field] ?? []) as unknown[]) {
      if (!isObject(entry)) return fail(`${field} entries must be objects`);
      for (const key of ["id", "name"]) {
        if (!nonEmptyString(entry[key])) fail(`${field} entry has no ${key}`);
      }
      const id = entry.id as string;
      if (seenModelIds.has(id)) fail(`model id "${id}" is declared twice`);
      seenModelIds.add(id);
      if (field === "ttsModels") {
        ttsModels.set(id, entry);
        const chunking = entry.chunking as TtsModel["chunking"] | undefined;
        if (chunking?.mode !== undefined && !CHUNK_STRATEGIES.includes(chunking.mode as ChunkStrategy)) {
          fail(`ttsModels["${id}"].chunking.mode must be one of ${CHUNK_STRATEGIES.join(", ")}`);
        }
      } else {
        sttModelIds.add(id);
        if (!["batch", "streaming", "both"].includes(entry.kind as string)) {
          fail(`sttModels["${id}"].kind must be batch, streaming or both`);
        }
      }
    }
  }

  for (const [serviceId, provider] of Object.entries(data.providers as Record<string, unknown>)) {
    if (!isObject(provider)) fail(`providers["${serviceId}"] must be an object`);
    const p = provider as Record<string, unknown>;
    const service = services.find(s => s.id === serviceId);
    if (!service) fail(`providers["${serviceId}"] names no service in the registry`);
    const capability = service!.capabilityId;

    if (p.responseFormat !== undefined && !(RESPONSE_FORMATS as readonly unknown[]).includes(p.responseFormat)) {
      fail(`providers["${serviceId}"].responseFormat must be one of ${RESPONSE_FORMATS.join(", ")}`);
    }
    if (p.sessions !== undefined && typeof p.sessions !== "boolean") {
      fail(`providers["${serviceId}"].sessions must be true or false`);
    }
    if (capability === "tts" ? typeof p.resolvesVoices !== "boolean" : p.resolvesVoices !== undefined && typeof p.resolvesVoices !== "boolean") {
      fail(`providers["${serviceId}"].resolvesVoices must be true or false${capability === "tts" ? "; a synthesis provider states whether it resolves voices itself" : ""}`);
    }
    if (!Array.isArray(p.serves)) fail(`providers["${serviceId}"].serves must be an array`);

    const served = new Set<string>();
    for (const serving of p.serves as unknown[]) {
      if (!isObject(serving) || !nonEmptyString(serving.model) || !nonEmptyString(serving.key)) {
        fail(`providers["${serviceId}"].serves entries need a model and a key`);
      }
      const s = serving as Record<string, unknown>;
      const model = s.model as string;
      const where = `providers["${serviceId}"].serves["${model}"]`;
      const isTts = ttsModels.has(model);
      const isStt = sttModelIds.has(model);
      if (!isTts && !isStt) fail(`${where} names a model that is not declared`);
      if (capability === "tts" && !isTts) fail(`${where} is a speech-to-text model; a synthesis provider serves synthesis models`);
      if (capability === "stt" && !isStt) fail(`${where} is a synthesis model; a speech-to-text provider serves speech-to-text models`);
      if (capability !== "tts" && capability !== "stt") fail(`${where}: a "${capability}" service serves no models`);
      if (served.has(model)) fail(`${where} is listed twice`);
      served.add(model);
      for (const flag of ["streaming", "realtime"]) {
        if (s[flag] !== undefined && typeof s[flag] !== "boolean") fail(`${where}.${flag} must be true or false`);
      }
      if (s.concurrency !== undefined && !(Number.isInteger(s.concurrency) && (s.concurrency as number) > 0)) {
        fail(`${where}.concurrency must be a positive integer`);
      }
      if (s.requestParams !== undefined && !isObject(s.requestParams)) fail(`${where}.requestParams must be an object`);
    }
  }

  const voiceIds = new Set<string>();
  for (const raw of data.voices as unknown[]) {
    if (!isObject(raw)) return fail("every voice must be an object");
    if (!nonEmptyString(raw.id)) fail("every voice needs a non-empty id");
    const id = raw.id as string;
    if (voiceIds.has(id)) fail(`voice "${id}" is declared twice`);
    voiceIds.add(id);
    if (!nonEmptyString(raw.name)) fail(`voices["${id}"].name must be a non-empty string`);

    const recordings = (raw.recordings ?? []) as unknown[];
    if (!Array.isArray(recordings)) fail(`voices["${id}"].recordings must be an array`);
    for (const rec of recordings) {
      const r = (isObject(rec) ? rec : {}) as Record<string, unknown>;
      if (!nonEmptyString(r.audio)) fail(`voices["${id}"] has a recording with no audio path`);
      if (!nonEmptyString(r.text)) fail(`voices["${id}"] recording "${r.audio}" has no transcript path`);
      if (typeof r.durationS !== "number" || r.durationS <= 0) fail(`voices["${id}"] recording "${r.audio}" needs a positive durationS`);
      if (!Number.isInteger(r.sampleRate) || (r.sampleRate as number) <= 0) fail(`voices["${id}"] recording "${r.audio}" needs a positive sampleRate`);
    }

    if (!Array.isArray(raw.renderings)) fail(`voices["${id}"].renderings must be an array`);
    for (const rendering of raw.renderings as unknown[]) {
      const r = (isObject(rendering) ? rendering : {}) as Record<string, unknown>;
      const model = ttsModels.get(r.model as string);
      if (!nonEmptyString(r.model) || !model) {
        fail(`voices["${id}"] has a rendering on model "${String(r.model)}", which is not a declared synthesis model`);
      }
      const name = r.model as string;
      if (r.method === "preset") {
        if (!nonEmptyString(r.key)) fail(`voices["${id}"] has a preset rendering on "${name}" with no key`);
      } else if (r.method === "clone") {
        if (r.key !== undefined) fail(`voices["${id}"] has a clone rendering on "${name}" with a key; only a preset has one`);
        const cloning = model!.cloning as Cloning | undefined;
        if (!cloning) fail(`voices["${id}"] has a clone rendering on "${name}", which cannot clone`);
        if (!(recordings as Recording[]).some(rec => satisfies(rec, cloning!))) {
          fail(`voices["${id}"] has a clone rendering on "${name}" but no recording that model accepts`);
        }
      } else {
        fail(`voices["${id}"] has a rendering on "${name}" whose method is neither preset nor clone`);
      }
    }
  }

  return data as unknown as NodeRoster;
}
