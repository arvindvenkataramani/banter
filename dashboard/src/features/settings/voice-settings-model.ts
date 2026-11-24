// The settings dialog's draft: seeded from the voice config, edited by pure
// functions, and diffed into one PATCH /api/voice/selection body. Chunking
// goes through the engine's own reducers (model-settings,
// agent/chunking-setting). No React, so it runs in node.

import { offersTakeover } from '@platform/voice-engine/voice-session-store'
import type { TtsModel, TtsProvider, TtsVoice, SttOption, VoiceConfig, VoiceSelection, VoiceSelectionPatch } from '@platform/voice-engine/voice-config'
import {
  buildModelPrefEntry, declaredAt, deleteModelOverride, editField, emptyPref, hasModelDefaults, hasOverride, readPrefs, settingsScopeFrom,
} from '@platform/voice-engine/model-settings'
import type { FieldOrigin, ModelPref, ModelPrefs, ResolvedField, SettingsScope } from '@platform/voice-engine/model-settings'
import {
  CHUNKING, diffGlobalOptions, globalSetFromConfig, resolveChunkingFields,
} from '@platform/voice-engine/agent/chunking-setting'
import type { ChunkingDraft, ChunkingField, ChunkingSet, ChunkingValue, ResolvedChunkingFields } from '@platform/voice-engine/agent/chunking-setting'

/**
 * The listening fields the Listening tab tunes. `section` names the object under `stt` that holds the field. `default` is the value the
 * engine applies when the config leaves the field out; the engine keeps these as inline fallbacks (not exported), so they are copied here:
 * minSpeechDurationS and minSpeechProb voice-engine/src/human/mic-loop.ts:380-381, pauseThresholdMs :426, and the commit delays and
 * smart-turn thresholds :494-497.
 */
export const TUNING_FIELDS = [
  {
    key: 'minSpeechDurationS', section: 'vad', label: 'Min duration', unit: 's', step: 0.05, min: 0, max: 2, default: 0.75,
    description: 'How long a sound must last to count as you talking, not a cough or a knock. Raise it if noises set it off; lower it if short replies like "yes" are missed.',
  },
  {
    key: 'minSpeechProb', section: 'vad', label: 'Min probability', unit: '', step: 0.05, min: 0, max: 1, default: 0.7,
    description: 'How sure the speech detector must be that a sound is speech. Raise it if background noise sets it off; lower it if quiet speech is missed.',
  },
  {
    key: 'pauseThresholdMs', section: 'turnTaking', label: 'Pause', unit: 'ms', step: 50, min: 0, max: 2000, default: 250,
    description: "How much silence counts as a pause, where smart-turn checks whether you've finished. Raise it if voice jumps in while you're thinking.",
  },
  {
    key: 'commitMinDelayMs', section: 'turnTaking', label: 'Commit min', unit: 'ms', step: 50, min: 0, max: 2000, default: 250,
    description: "The wait after a pause when smart-turn is sure you've finished. Lower it for quicker replies; raise it if you still get cut off. Speaking again cancels it.",
  },
  {
    key: 'commitMaxDelayMs', section: 'turnTaking', label: 'Commit max', unit: 'ms', step: 50, min: 0, max: 2000, default: 2000,
    description: "The wait after a pause when smart-turn thinks you're still going. Raise it if you get cut off mid-sentence.",
  },
  {
    key: 'smartTurnThreshold', section: 'turnTaking', label: 'Smart-turn', unit: '', step: 0.05, min: 0, max: 1, default: 0.7,
    description: "How sure smart-turn must be that you've finished before the shorter Commit min wait applies. Lower it for quicker replies; raise it if you get cut off.",
  },
  {
    key: 'smartTurnLowCutoff', section: 'turnTaking', label: 'Smart-turn low', unit: '', step: 0.05, min: 0, max: 1, default: 0.15,
    description: 'Below this score, smart-turn counts you as still going and the longer Commit max wait applies. Scores in between get a wait in between.',
  },
] as const

export type TuningKey = typeof TUNING_FIELDS[number]['key']
export type Tuning = Partial<Record<TuningKey, number>>

/** Every value the dialog edits, staged. `config` is what the draft was seeded from; it never changes. */
export interface Draft {
  readonly config: VoiceConfig
  readonly sttServiceId: string
  readonly ttsServiceId: string
  readonly ttsModel: string
  readonly ttsVoice: string
  readonly ttsSpeed: number
  readonly takeover: 'ask' | 'always'
  readonly saveMicSamples: boolean
  /** `voice.stt.preferStreaming`; it decides only for a model that can do both. */
  readonly preferStreaming: boolean
  readonly scope: SettingsScope
  readonly global: ChunkingSet
  /** Per-model chunking preferences, keyed by provider then model, so switching models never touches an edited entry. */
  readonly prefs: ModelPrefs
  /** The `provider\0model` keys whose preference was edited; only these are sent. */
  readonly touched: readonly string[]
  readonly tuning: Tuning
}

export function seedDraft(config: VoiceConfig, selection: VoiceSelection): Draft {
  return {
    config,
    sttServiceId: config.stt?.serviceId ?? '',
    ttsServiceId: selection.serviceId,
    ttsModel: selection.model,
    ttsVoice: selection.voice,
    ttsSpeed: selection.speed,
    takeover: config.takeover ?? 'ask',
    saveMicSamples: config.debug?.saveMicSamples ?? false,
    preferStreaming: config.stt?.preferStreaming ?? false,
    scope: settingsScopeFrom(config),
    global: globalSetFromConfig(config),
    prefs: readPrefs(config.tts.modelPrefs),
    touched: [],
    tuning: tuningFromConfig(config),
  }
}

function tuningFromConfig(config: VoiceConfig): Tuning {
  const out: Tuning = {}
  for (const f of TUNING_FIELDS) {
    const value = (config.stt?.[f.section] as Record<string, unknown> | undefined)?.[f.key]
    if (typeof value === 'number') out[f.key] = value
  }
  return out
}

// ── Roster ───────────────────────────────────────────────────────────────

export interface RosterView {
  providers: TtsProvider[]
  currentProvider: TtsProvider | undefined
  /** The selected provider's realtime models: the only ones the voice loop can use. */
  models: TtsModel[]
  currentModel: TtsModel | undefined
  voices: TtsVoice[]
  sttOptions: SttOption[]
  /** Whether the selected STT option has a streaming provision that holds take-over. */
  offersTakeover: boolean
}

/** The synthesis models a runtime serves for the realtime voice loop, in the roster's order. */
function realtimeModels(config: VoiceConfig, provider: TtsProvider | undefined): TtsModel[] {
  const served = new Set((provider?.serves ?? []).filter(s => s.realtime === true).map(s => s.model))
  return config.tts.models.filter(m => served.has(m.id))
}

/** The voices with a rendering on a model, in the roster's order. */
function voicesOn(config: VoiceConfig, modelId: string): TtsVoice[] {
  return config.tts.voices.filter(v => v.renderings.some(r => r.model === modelId))
}

export function roster(draft: Draft): RosterView {
  const providers = draft.config.tts.providers
  const currentProvider = providers.find(p => p.serviceId === draft.ttsServiceId)
  const models = realtimeModels(draft.config, currentProvider)
  const currentModel = models.find(m => m.id === draft.ttsModel)
  const sttOptions = draft.config.stt?.options ?? []
  const currentSttOption = sttOptions.find(o => o.serviceId === draft.sttServiceId)
  return {
    providers,
    currentProvider,
    models,
    currentModel,
    voices: currentModel ? voicesOn(draft.config, currentModel.id) : [],
    sttOptions,
    offersTakeover: currentSttOption !== undefined && offersTakeover(
      currentSttOption,
      draft.config.stt?.models?.find(m => m.id === draft.config.stt?.model),
      draft.preferStreaming,
      draft.config.stt?.encodings,
    ),
  }
}

// ── Edits ────────────────────────────────────────────────────────────────

export function setProvider(draft: Draft, serviceId: string): Draft {
  const provider = draft.config.tts.providers.find(p => p.serviceId === serviceId)
  const model = realtimeModels(draft.config, provider)[0]
  return { ...draft, ttsServiceId: serviceId, ttsModel: model?.id ?? '', ttsVoice: model ? voicesOn(draft.config, model.id)[0]?.id ?? '' : '' }
}

export function setModel(draft: Draft, modelId: string): Draft {
  return { ...draft, ttsModel: modelId, ttsVoice: voicesOn(draft.config, modelId)[0]?.id ?? '' }
}

export const setVoice = (draft: Draft, voice: string): Draft => ({ ...draft, ttsVoice: voice })
export const setSpeed = (draft: Draft, speed: number): Draft => ({ ...draft, ttsSpeed: speed })
export const setSttService = (draft: Draft, serviceId: string): Draft => ({ ...draft, sttServiceId: serviceId })
export const setTakeover = (draft: Draft, takeover: 'ask' | 'always'): Draft => ({ ...draft, takeover })
export const setSaveMicSamples = (draft: Draft, saveMicSamples: boolean): Draft => ({ ...draft, saveMicSamples })
export const setPreferStreaming = (draft: Draft, preferStreaming: boolean): Draft => ({ ...draft, preferStreaming })
export const setScope = (draft: Draft, scope: SettingsScope): Draft => ({ ...draft, scope })
export const setTuning = (draft: Draft, key: TuningKey, value: number): Draft => ({ ...draft, tuning: { ...draft.tuning, [key]: value } })
/** Clears a field back to unset, so the engine's own default applies again. */
export const resetTuning = (draft: Draft, key: TuningKey): Draft => {
  const { [key]: _removed, ...tuning } = draft.tuning
  return { ...draft, tuning }
}

// ── Chunking ─────────────────────────────────────────────────────────────

const touchedKey = (serviceId: string, modelId: string): string => `${serviceId}\u0000${modelId}`

/** The engine's three-layer draft for the selected model. */
function chunkingDraftOf(draft: Draft): ChunkingDraft {
  const model = roster(draft).currentModel
  return {
    scope: draft.scope,
    global: draft.global,
    pref: draft.prefs[draft.ttsServiceId]?.[draft.ttsModel] ?? emptyPref(CHUNKING),
    modelDefaults: (model?.chunking ?? {}) as ChunkingSet,
  }
}

/**
 * Splits a reducer's result back into the draft's pieces, and marks this model
 * touched only when its preference actually changed: under 'global' scope the
 * reducer returns the preference as it was, and an unconditional write would
 * create an empty entry for every model that happens to be selected.
 */
function commitChunking(draft: Draft, next: ChunkingDraft): Draft {
  const before = chunkingDraftOf(draft)
  const withGlobal: Draft = { ...draft, global: next.global }
  if (JSON.stringify(before.pref) === JSON.stringify(next.pref)) return withGlobal
  const bucket = { ...(draft.prefs[draft.ttsServiceId] ?? {}), [draft.ttsModel]: next.pref as ModelPref }
  const key = touchedKey(draft.ttsServiceId, draft.ttsModel)
  return {
    ...withGlobal,
    prefs: { ...draft.prefs, [draft.ttsServiceId]: bucket },
    touched: draft.touched.includes(key) ? draft.touched : [...draft.touched, key],
  }
}

export function editChunking(draft: Draft, field: ChunkingField, value: ChunkingValue | undefined): Draft {
  return commitChunking(draft, editField(CHUNKING, chunkingDraftOf(draft), field, value))
}

export function resetChunking(draft: Draft): Draft {
  return commitChunking(draft, deleteModelOverride(CHUNKING, chunkingDraftOf(draft)))
}

const ORIGIN_LABELS: Record<Exclude<FieldOrigin, 'none'>, string> = { override: 'yours', model: 'model', global: 'global' }

/** Every layer other than the one in force that declares this field with a different value. */
function divergencesFor(
  draft: ChunkingDraft,
  field: ChunkingField,
  resolved: ResolvedField<ChunkingValue>,
): Array<{ label: string; value: string }> {
  const layers: Array<Exclude<FieldOrigin, 'none'>> = draft.scope === 'global' ? ['model'] : ['override', 'model', 'global']
  const out: Array<{ label: string; value: string }> = []
  for (const origin of layers) {
    if (origin === resolved.from) continue
    const value = declaredAt(CHUNKING, draft, origin, field)
    if (value === undefined || value === resolved.value) continue
    out.push({ label: ORIGIN_LABELS[origin], value: String(value) })
  }
  return out
}

export interface ChunkingView {
  draft: ChunkingDraft
  fields: ResolvedChunkingFields
  divergences: Record<ChunkingField, Array<{ label: string; value: string }>>
  modelName: string
  overridePresent: boolean
  /** The one line under the fields, when the scope and the stored values make one worth saying. */
  note: string | null
}

export function chunkingView(draft: Draft): ChunkingView {
  const chunking = chunkingDraftOf(draft)
  const fields = resolveChunkingFields(chunking)
  const modelName = roster(draft).currentModel?.name ?? draft.ttsModel
  const overridePresent = hasOverride(CHUNKING, chunking)
  const modelDefaultsPresent = hasModelDefaults(CHUNKING, chunking)
  const note = draft.scope === 'global' && overridePresent
    ? `Saved values for ${modelName} are set aside while every model shares one set.`
    : draft.scope === 'per-model' && !overridePresent && !modelDefaultsPresent
      ? `${modelName} ships no chunking values of its own — your global preferences apply.`
      : null
  return {
    draft: chunking,
    fields,
    divergences: {
      mode: divergencesFor(chunking, 'mode', fields.mode),
      minWords: divergencesFor(chunking, 'minWords', fields.minWords),
      maxWords: divergencesFor(chunking, 'maxWords', fields.maxWords),
    },
    modelName,
    overridePresent,
    note,
  }
}

// ── Saving ───────────────────────────────────────────────────────────────

/** The body of one PATCH /api/voice/selection for what the draft changed, or null when it changed nothing. */
export function buildPatch(draft: Draft): VoiceSelectionPatch | null {
  const config = draft.config
  const saved = config.tts.selection
  const patch: VoiceSelectionPatch = {}
  let changed = false

  const selectionChanged = draft.ttsServiceId !== saved?.serviceId || draft.ttsModel !== saved?.model
    || draft.ttsVoice !== saved?.voice || draft.ttsSpeed !== (saved?.speed ?? 1)
  if (selectionChanged) changed = true

  if (draft.sttServiceId !== (config.stt?.serviceId ?? '')) {
    patch.sttServiceId = draft.sttServiceId
    changed = true
  }
  if (draft.takeover !== (config.takeover ?? 'ask')) {
    patch.takeover = draft.takeover
    changed = true
  }
  if (draft.preferStreaming !== (config.stt?.preferStreaming ?? false)) {
    patch.preferStreaming = draft.preferStreaming
    changed = true
  }
  if (draft.saveMicSamples !== (config.debug?.saveMicSamples ?? false)) {
    patch.saveMicSamples = draft.saveMicSamples
    changed = true
  }
  if (draft.scope !== settingsScopeFrom(config)) {
    patch.settingsScope = draft.scope
    changed = true
  }

  const globalPatch = diffGlobalOptions(globalSetFromConfig(config), draft.global)
  if (Object.keys(globalPatch).length > 0) {
    Object.assign(patch, globalPatch)
    changed = true
  }

  // A touched model is sent only when its entry now differs from the stored one, so an edit undone before Save sends nothing.
  const storedPrefs = readPrefs(config.tts.modelPrefs)
  const prefs: Record<string, Record<string, ModelPref | null>> = {}
  for (const key of draft.touched) {
    const [serviceId, modelId] = key.split('\u0000')
    const entry = buildModelPrefEntry(CHUNKING, draft.prefs[serviceId]?.[modelId] ?? emptyPref(CHUNKING)) as ModelPref | null
    const stored = buildModelPrefEntry(CHUNKING, storedPrefs[serviceId]?.[modelId] ?? emptyPref(CHUNKING)) as ModelPref | null
    if (JSON.stringify(entry) === JSON.stringify(stored)) continue
    prefs[serviceId] = { ...(prefs[serviceId] ?? {}), [modelId]: entry }
  }
  if (Object.keys(prefs).length > 0) {
    patch.modelPrefs = prefs
    changed = true
  }

  const stored = tuningFromConfig(config)
  for (const f of TUNING_FIELDS) {
    const value = draft.tuning[f.key]
    if (value === stored[f.key]) continue
    // An unset draft value over a stored one is a reset: null removes it, so the engine's default applies again.
    const section: Record<string, number | null> = { ...(patch[f.section] ?? {}) }
    section[f.key] = value ?? null
    patch[f.section] = section
    changed = true
  }

  if (!changed) return null
  return { serviceId: draft.ttsServiceId, model: draft.ttsModel, voice: draft.ttsVoice, speed: draft.ttsSpeed, ...patch }
}
