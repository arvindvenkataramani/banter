// Chunking is the first tenant of the generic settings core in
// model-settings.ts, and the only setting with all three layers today — it
// is the only one with both a global counterpart and a model-declared
// default. Concurrency and requestParams are model-only and config-authored
// today, but would fit this shape if they ever gained user-facing globals.
// See plans/voice-chat.md's settings phase for the model this implements.

import type { ChunkStrategy } from '@platform/shared'
import type { VoiceConfig, VoiceSelection } from './voice-config'
import type { VoiceSelectionPatch } from '@/lib/api'
import {
  diffGlobalSet,
  draftFor,
  resolveFields,
} from './model-settings'
import type {
  ResolvedField,
  SettingDescriptor,
  SettingDraft,
  SettingSet,
} from './model-settings'

export type ChunkingField = 'mode' | 'minWords' | 'maxWords'
export type ChunkingValue = ChunkStrategy | number
type ChunkingValues = { mode: ChunkStrategy; minWords: number; maxWords: number }

export type ChunkingSet = SettingSet<ChunkingField, ChunkingValue>
export type ChunkingDraft = SettingDraft<ChunkingField, ChunkingValue>
export type ResolvedChunkingFields = { [K in ChunkingField]: ResolvedField<ChunkingValues[K]> }

export interface ResolvedChunking {
  strategy: ChunkStrategy
  minWords: number | undefined
  maxWords: number | undefined
  concurrency: number | undefined
}

export const DEFAULT_CHUNK_STRATEGY: ChunkStrategy = 'two-chunk'

export const CHUNKING: SettingDescriptor<ChunkingField, ChunkingValue> = {
  key: 'chunking',
  fields: ['mode', 'minWords', 'maxWords'],
  globalSet: (config) => ({
    mode: config?.tts.options?.chunkStrategy,
    minWords: config?.tts.options?.minChunkWords,
    maxWords: config?.tts.options?.maxChunkWords,
  }),
  modelDefaults: (config, serviceId, modelId) =>
    config?.tts.providers.find(p => p.serviceId === serviceId)
      ?.models.find(m => m.id === modelId)?.chunking ?? {},
  patchKeys: { mode: 'chunkStrategy', minWords: 'minChunkWords', maxWords: 'maxChunkWords' },
}

/** Global preferences mapped into a ChunkingSet — shared by the dialog's seed
 * and by diffGlobalOptions so they can never disagree about the mapping. */
export function globalSetFromConfig(config: VoiceConfig | null): ChunkingSet {
  return CHUNKING.globalSet(config)
}

export function chunkingLayersFor(
  config: VoiceConfig | null,
  serviceId: string,
  modelId: string,
): ChunkingDraft {
  return draftFor(CHUNKING, config, serviceId, modelId)
}

export function resolveChunkingFields(draft: ChunkingDraft): ResolvedChunkingFields {
  return resolveFields(CHUNKING, draft) as ResolvedChunkingFields
}

/** The app-facing wrapper page.tsx uses for the active selection. The dialog
 * uses resolveChunkingFields directly against a draft for its own selected
 * model — both share the same resolution core. */
export function resolveChunkingFor(
  config: VoiceConfig | null,
  selection: VoiceSelection | null,
): ResolvedChunking {
  if (!selection) {
    return { strategy: DEFAULT_CHUNK_STRATEGY, minWords: undefined, maxWords: undefined, concurrency: undefined }
  }
  const draft = chunkingLayersFor(config, selection.serviceId, selection.model)
  const fields = resolveChunkingFields(draft)
  const model = config?.tts.providers
    .find(p => p.serviceId === selection.serviceId)
    ?.models.find(m => m.id === selection.model)
  return {
    strategy: fields.mode.value ?? DEFAULT_CHUNK_STRATEGY,
    minWords: fields.minWords.value,
    maxWords: fields.maxWords.value,
    concurrency: model?.concurrency,
  }
}

export function diffGlobalOptions(
  loaded: ChunkingSet,
  staged: ChunkingSet,
): Pick<VoiceSelectionPatch, 'chunkStrategy' | 'minChunkWords' | 'maxChunkWords'> {
  return diffGlobalSet(CHUNKING, loaded, staged) as Pick<VoiceSelectionPatch, 'chunkStrategy' | 'minChunkWords' | 'maxChunkWords'>
}
