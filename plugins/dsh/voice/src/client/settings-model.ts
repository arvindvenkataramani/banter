// The settings page's draft: seeded from the plugin's stored settings, edited
// by pure functions, and diffed back into one write. Chunking goes through the
// engine's own reducers (model-settings, agent/chunking-setting), so it
// resolves as it does in Banter's settings dialog. No React and no dsh import,
// so it runs in node.

import type { TtsModel, TtsProvider, TtsVoice, SttOption, VoiceConfig } from '@platform/voice-engine/voice-config'
import {
  buildModelPrefEntry, declaredAt, deleteModelOverride, editField, emptyPref, hasModelDefaults, hasOverride, readPrefs, settingsScopeFrom,
} from '@platform/voice-engine/model-settings'
import type { FieldOrigin, ModelPref, ModelPrefs, ResolvedField, SettingsScope } from '@platform/voice-engine/model-settings'
import {
  CHUNKING, diffGlobalOptions, globalSetFromConfig, resolveChunkingFields,
} from '@platform/voice-engine/agent/chunking-setting'
import type { ChunkingDraft, ChunkingField, ChunkingSet, ChunkingValue, ResolvedChunkingFields } from '@platform/voice-engine/agent/chunking-setting'
import { voiceConfigFromSettings, type PluginSettings } from '../host/settings.ts'
import type { DshSettingsOp } from './dsh-types.ts'

export type SettingsOp = DshSettingsOp

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

/** Every value the page edits, staged. `config` is the roster and everything else the draft was seeded from; it never changes. */
export interface Draft {
  readonly config: VoiceConfig
  readonly controlPlaneUrl: string
  readonly sttServiceId: string
  readonly ttsServiceId: string
  readonly ttsModel: string
  readonly ttsVoice: string
  readonly ttsSpeed: number
  readonly keepVoiceOutside: boolean
  readonly takeover: 'ask' | 'always'
  readonly scope: SettingsScope
  readonly global: ChunkingSet
  /** Per-model chunking preferences, keyed by provider then model, so switching models never touches an edited entry. */
  readonly prefs: ModelPrefs
  /** The `provider\0model` keys whose preference was edited; only these are written back. */
  readonly touched: readonly string[]
  readonly tuning: Tuning
}

export function seedDraft(settings: PluginSettings): Draft {
  const config = voiceConfigFromSettings(settings)
  return {
    config,
    controlPlaneUrl: settings.controlPlaneUrl,
    sttServiceId: settings.sttServiceId,
    ttsServiceId: settings.ttsServiceId,
    ttsModel: settings.ttsModel,
    ttsVoice: settings.ttsVoice,
    ttsSpeed: settings.ttsSpeed,
    keepVoiceOutside: settings.keepVoiceOutside,
    takeover: config.takeover ?? 'ask',
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
  /** Whether the selected STT option or TTS provider has a socket that understands take-over. */
  declaresSessions: boolean
}

export function roster(draft: Draft): RosterView {
  const providers = draft.config.tts.providers
  const currentProvider = providers.find(p => p.serviceId === draft.ttsServiceId)
  const models = (currentProvider?.models ?? []).filter(m => m.realtime === true)
  const currentModel = models.find(m => m.id === draft.ttsModel)
  const sttOptions = draft.config.stt?.options ?? []
  const currentSttOption = sttOptions.find(o => o.serviceId === draft.sttServiceId)
  return {
    providers,
    currentProvider,
    models,
    currentModel,
    voices: currentModel?.voices ?? [],
    sttOptions,
    declaresSessions: currentSttOption?.sessions === true || currentProvider?.sessions === true,
  }
}

// ── Edits ────────────────────────────────────────────────────────────────

export function setProvider(draft: Draft, serviceId: string): Draft {
  const provider = draft.config.tts.providers.find(p => p.serviceId === serviceId)
  const model = provider?.models.find(m => m.realtime === true)
  return { ...draft, ttsServiceId: serviceId, ttsModel: model?.id ?? '', ttsVoice: model?.voices[0]?.id ?? '' }
}

export function setModel(draft: Draft, modelId: string): Draft {
  const provider = draft.config.tts.providers.find(p => p.serviceId === draft.ttsServiceId)
  const model = provider?.models.find(m => m.id === modelId)
  return { ...draft, ttsModel: modelId, ttsVoice: model?.voices[0]?.id ?? '' }
}

export const setVoice = (draft: Draft, voice: string): Draft => ({ ...draft, ttsVoice: voice })
export const setSpeed = (draft: Draft, speed: number): Draft => ({ ...draft, ttsSpeed: speed })
export const setSttService = (draft: Draft, serviceId: string): Draft => ({ ...draft, sttServiceId: serviceId })
export const setControlPlaneUrl = (draft: Draft, url: string): Draft => ({ ...draft, controlPlaneUrl: url })
export const setKeepVoiceOutside = (draft: Draft, keep: boolean): Draft => ({ ...draft, keepVoiceOutside: keep })
export const setTakeover = (draft: Draft, takeover: 'ask' | 'always'): Draft => ({ ...draft, takeover })
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

// ── Writing ──────────────────────────────────────────────────────────────

const TYPED_FIELDS = [
  'controlPlaneUrl', 'sttServiceId', 'ttsServiceId', 'ttsModel', 'ttsVoice', 'ttsSpeed', 'keepVoiceOutside',
] as const satisfies ReadonlyArray<keyof PluginSettings>

type Json = Record<string, unknown>

/** The remainder the draft edits, patched the way the control plane merges a `PATCH /api/voice/selection`. */
function patchRest(settings: PluginSettings, draft: Draft): string {
  const stored = parseObject(settings.rest)
  const config = draft.config
  const rest: Json = { ...stored }
  const tts: Json = { ...(stored.tts as Json | undefined) }
  const stt: Json = { ...(stored.stt as Json | undefined) }

  if (draft.takeover !== (config.takeover ?? 'ask')) rest.takeover = draft.takeover
  if (draft.scope !== settingsScopeFrom(config)) tts.settingsScope = draft.scope

  const storedTts = stored.tts as Json | undefined
  const globalPatch = diffGlobalOptions(globalSetFromConfig(config), draft.global)
  if (Object.keys(globalPatch).length > 0) tts.options = { ...(storedTts?.options as Json | undefined), ...globalPatch }

  if (draft.touched.length > 0) {
    const prefs: Record<string, Record<string, unknown>> = { ...(config.tts.modelPrefs ?? {}) }
    for (const key of draft.touched) {
      const [serviceId, modelId] = key.split('\u0000')
      const entry = buildModelPrefEntry(CHUNKING, draft.prefs[serviceId]?.[modelId] ?? emptyPref(CHUNKING))
      const bucket = { ...(prefs[serviceId] ?? {}) }
      if (entry === null) delete bucket[modelId]
      else bucket[modelId] = entry
      if (Object.keys(bucket).length === 0) delete prefs[serviceId]
      else prefs[serviceId] = bucket
    }
    // An emptied set is stored as {}, as the control plane stores it, but an edit that changed nothing must not add the key.
    if (Object.keys(prefs).length > 0 || storedTts?.modelPrefs !== undefined) tts.modelPrefs = prefs
  }

  const saved = tuningFromConfig(config)
  for (const f of TUNING_FIELDS) {
    const value = draft.tuning[f.key]
    if (value === saved[f.key]) continue
    // An unset draft value over a stored one is a reset: the key is removed so the engine's default applies again.
    const section = { ...(stt[f.section] as Json | undefined) }
    if (value === undefined) delete section[f.key]
    else section[f.key] = value
    stt[f.section] = section
  }

  if (Object.keys(tts).length > 0 || stored.tts !== undefined) rest.tts = tts
  if (Object.keys(stt).length > 0 || stored.stt !== undefined) rest.stt = stt
  const next = JSON.stringify(rest)
  return next === JSON.stringify(stored) ? settings.rest : next
}

function parseObject(json: string): Json {
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : {}
  } catch {
    return {}
  }
}

export interface Write {
  /** One set per field that changed: the typed fields, and `rest` when an edit landed in it. Empty for an unchanged draft. */
  ops: SettingsOp[]
  /** The settings as they will stand once the ops are accepted. */
  next: PluginSettings
}

/** Diffs the draft against the settings it was seeded from. `rest` is re-serialised only when an edit changes it. */
export function buildWrite(settings: PluginSettings, draft: Draft): Write {
  const next: PluginSettings = { ...settings, rest: patchRest(settings, draft) }
  for (const field of TYPED_FIELDS) {
    Object.assign(next, { [field]: draft[field] })
  }
  const ops: SettingsOp[] = []
  for (const field of [...TYPED_FIELDS, 'rest'] as const) {
    if (next[field] !== settings[field]) ops.push({ op: 'set', path: [field], value: next[field] })
  }
  return { ops, next }
}
