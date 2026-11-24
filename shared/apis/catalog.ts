// Typed access to the API catalog and the part indexes (docs/reference/design/service-apis.md, "The API catalog").

import catalogData from "./catalog.json";
import speech from "./parts/openai.audio.speech.json";
import transcriptions from "./parts/openai.audio.transcriptions.json";
import realtime from "./parts/openai.realtime.json";
import listenPrerecorded from "./parts/deepgram.listen.prerecorded.json";
import listenLive from "./parts/deepgram.listen.live.json";
import deepgramSpeak from "./parts/deepgram.speak.json";
import speakLive from "./parts/deepgram.speak.live.json";
import sttStream from "./parts/fluid.stt.stream.json";
import ttsStream from "./parts/fluid.tts.stream.json";
import modelRepository from "./parts/triton.model-repository.json";
import type { ApiId, Catalog, CatalogApi, CatalogExtension, ExtensionId, PartIndex } from "./types";

export const catalog = catalogData as Catalog;

const apisById = new Map<string, CatalogApi>(catalog.apis.map(a => [a.id, a]));
const extensionsById = new Map<string, CatalogExtension>(catalog.extensions.map(e => [e.id, e]));

const indexes = new Map<string, PartIndex>(
  ([speech, transcriptions, realtime, listenPrerecorded, listenLive, deepgramSpeak, speakLive, sttStream, ttsStream, modelRepository] as PartIndex[])
    .map(index => [index.api, index]),
);
const partSets = new Map<string, Set<string>>();

export const isApiId = (id: string): id is ApiId => apisById.has(id);
export const isExtensionId = (id: string): id is ExtensionId => extensionsById.has(id);
export const apiEntry = (id: string): CatalogApi | undefined => apisById.get(id);
export const extensionEntry = (id: string): CatalogExtension | undefined => extensionsById.get(id);

export const partIndex = (api: string): PartIndex | undefined => indexes.get(api);

/** The part names of an API's index, or undefined for an API with none. */
export function partNames(api: string): ReadonlySet<string> | undefined {
  const index = indexes.get(api);
  if (!index) return undefined;
  let set = partSets.get(api);
  if (!set) partSets.set(api, (set = new Set(index.parts)));
  return set;
}
