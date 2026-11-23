// The synthesis view of the assembled roster, as GET /api/voice serves it.
// Ids are roster ids, which is what a selection stores; preset keys and
// recording paths are the resolver's and never leave the shard.

import type { AssembledProvider, AssembledRoster, AssembledVoice } from "./roster-assembly";

export interface TtsModelView {
  id: string;
  name: string;
  canClone: boolean;
  chunking?: { mode?: string; minWords?: number; maxWords?: number };
}

export interface TtsRosterView {
  models: TtsModelView[];
  /** Runtimes serving at least one synthesis model. */
  providers: AssembledProvider[];
  voices: AssembledVoice[];
}

export function ttsRosterView(assembly: AssembledRoster): TtsRosterView {
  const ttsIds = new Set(assembly.ttsModels.map(m => m.id));
  return {
    models: assembly.ttsModels.map(m => ({
      id: m.id,
      name: m.name,
      canClone: m.cloning !== undefined,
      ...(m.chunking !== undefined && { chunking: m.chunking }),
    })),
    providers: assembly.providers.filter(p => p.serves.some(s => ttsIds.has(s.model))),
    voices: assembly.voices,
  };
}
