import { useState, useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { fetchVoiceConfig, loadVoiceSelection, unloadTtsModel, setSaveMicSamples, resolveVoiceSelection } from '@/lib/voice'
import { STREAMING_BACKEND, saveStreamingBackend, getDetectedBackend } from '@/lib/voice/system/streaming-backend'
import { useVoiceSessionStore, setVoiceConfig, setVoiceSelection } from '@/lib/voice/voice-session-store'
import { applySavedVoiceSettings } from '@/lib/voice/apply-voice-settings'
import { updateVoiceSelection } from '@/lib/api'
import type { VoiceUpdateResult, VoiceSelectionPatch } from '@/lib/api'
import type { StreamingBackend } from '@/lib/voice/system/streaming-backend'
import type { VoiceConfig, VoiceSelection, ChunkStrategy } from '@/lib/voice'
import {
  editField,
  deleteModelOverride,
  hasModelDefaults,
  hasOverride,
  buildModelPrefEntry,
  emptyPref,
  declaredAt,
  settingsScopeFrom,
  readPrefs,
} from '@/lib/voice/model-settings'
import type {
  ModelPrefs,
  ModelPref,
  SettingsScope,
  FieldOrigin,
  ResolvedField,
} from '@/lib/voice/model-settings'
import {
  CHUNKING,
  DEFAULT_CHUNK_STRATEGY,
  resolveChunkingFields,
  globalSetFromConfig,
  diffGlobalOptions,
} from '@/lib/voice/agent/chunking-setting'
import type {
  ChunkingSet,
  ChunkingDraft,
  ChunkingField,
} from '@/lib/voice/agent/chunking-setting'
import { Section, FieldProvenance } from './voice-settings-parts'

/** The listening fields the Listening tab tunes. `section` names the object
 * under `voice.stt` that holds the field; `description` says what the voice
 * loop (mic-loop.ts) does with it. */
const TUNING_FIELDS = [
  {
    key: 'minSpeechDurationS', section: 'vad', label: 'Min duration', unit: 's', step: 0.05, min: 0, max: 2,
    description: 'How long speech must last before it counts as you talking rather than a cough or a knock.',
  },
  {
    key: 'minSpeechProb', section: 'vad', label: 'Min probability', unit: '', step: 0.05, min: 0, max: 1,
    description: 'How sure the speech detector must be that a moment is speech. Higher ignores more noise but can miss quiet speech.',
  },
  {
    key: 'pauseThresholdMs', section: 'turnTaking', label: 'Pause', unit: 'ms', step: 50, min: 0, max: 2000,
    description: 'How much silence counts as a pause. At each pause, smart-turn scores whether you have finished.',
  },
  {
    key: 'commitMinDelayMs', section: 'turnTaking', label: 'Commit min', unit: 'ms', step: 50, min: 0, max: 2000,
    description: 'The wait after a pause before your turn ends, when smart-turn is sure you have finished. Speaking again cancels it.',
  },
  {
    key: 'commitMaxDelayMs', section: 'turnTaking', label: 'Commit max', unit: 'ms', step: 50, min: 0, max: 2000,
    description: 'The wait after a pause before your turn ends, when smart-turn thinks you are still going. Speaking again cancels it.',
  },
  {
    key: 'smartTurnThreshold', section: 'turnTaking', label: 'Smart-turn', unit: '', step: 0.05, min: 0, max: 1,
    description: 'A score at or above this counts as sure you have finished, so the Commit min wait applies.',
  },
  {
    key: 'smartTurnLowCutoff', section: 'turnTaking', label: 'Smart-turn low', unit: '', step: 0.05, min: 0, max: 1,
    description: 'A score below this counts as still going, so the Commit max wait applies. Scores in between get a wait in between.',
  },
] as const

type TuningKey = typeof TUNING_FIELDS[number]['key']
type Tuning = Partial<Record<TuningKey, number>>

function tuningFromConfig(config: VoiceConfig): Tuning {
  const out: Tuning = {}
  for (const f of TUNING_FIELDS) {
    const value = (config.stt?.[f.section] as Record<string, unknown> | undefined)?.[f.key]
    if (typeof value === 'number') out[f.key] = value
  }
  return out
}

/** The fields whose draft differs from the saved value, grouped by the
 * `voice.stt` section each belongs to — the shape the PATCH takes. */
function diffTuning(saved: Tuning, draft: Tuning): Pick<VoiceSelectionPatch, 'vad' | 'turnTaking'> {
  const out: Pick<VoiceSelectionPatch, 'vad' | 'turnTaking'> = {}
  for (const f of TUNING_FIELDS) {
    const value = draft[f.key]
    if (value === undefined || value === saved[f.key]) continue
    out[f.section] = { ...out[f.section], [f.key]: value }
  }
  return out
}

const ORIGIN_LABELS: Record<Exclude<FieldOrigin, 'none'>, string> = {
  override: 'yours',
  model: 'model',
  global: 'global',
}

function touchedKey(serviceId: string, modelId: string): string {
  return `${serviceId}\u0000${modelId}`
}

/** Every layer other than the one in force, that declares this field with a
 * value different from the one in force. Layers that don't declare the
 * field, or that agree with it, are omitted. */
function divergencesFor(
  draft: ChunkingDraft,
  field: ChunkingField,
  resolved: ResolvedField<ChunkStrategy | number>,
): Array<{ label: string; value: string }> {
  const layers: Array<Exclude<FieldOrigin, 'none'>> =
    draft.scope === 'global' ? ['model'] : ['override', 'model', 'global']
  const out: Array<{ label: string; value: string }> = []
  for (const origin of layers) {
    if (origin === resolved.from) continue
    const value = declaredAt(CHUNKING, draft, origin, field)
    if (value === undefined) continue
    if (value === resolved.value) continue
    out.push({ label: ORIGIN_LABELS[origin], value: String(value) })
  }
  return out
}

export interface VoiceSettingsTabs {
  /** 'loading' until the voice config is in hand; 'unconfigured' when it
   * names no usable voice. The panels are empty in both. */
  status: 'loading' | 'unconfigured' | 'ready'
  voice: React.ReactNode
  speech: React.ReactNode
  listening: React.ReactNode
  debug: React.ReactNode
  /** Saves whatever the tabs changed, and does nothing when they changed
   * nothing. Resolves false when the save failed; the failure is toasted. */
  save: () => Promise<boolean>
}

/**
 * Voice mode's settings as tabs for the Settings dialog. Every value is
 * staged: nothing reaches the running voice loop until save(), and the drafts
 * are seeded afresh each time the dialog opens, so Cancel is a true undo.
 *
 * Config normally arrives with the chat page; when the dialog opens before
 * that has happened, it is fetched here and published to the same store.
 */
export function useVoiceSettings(open: boolean): VoiceSettingsTabs {
  const voiceConfig = useStore(useVoiceSessionStore, (s) => s.voiceConfig)
  const selection = useStore(useVoiceSessionStore, (s) => s.voiceSelection)
  const endpoint = useStore(useVoiceSessionStore, (s) => s.ttsEndpoint)

  const [serviceId, setServiceId] = useState('')
  const [model, setModel] = useState('')
  const [voice, setVoice] = useState('')
  const [speed, setSpeed] = useState(1)
  const [sttServiceId, setSttServiceId] = useState<string | undefined>(undefined)
  const [saveMicSamples, setSaveMicSamplesState] = useState(false)
  const [takeover, setTakeover] = useState<'ask' | 'always'>('ask')
  const [streamingBackend, setStreamingBackend] = useState<StreamingBackend | 'auto'>(() => {
    const stored = localStorage.getItem('tts-streaming-backend')
    return (stored === 'mms' || stored === 'mse' || stored === 'blob') ? stored : 'auto'
  })
  const detected = getDetectedBackend()

  // prefsDraft is keyed by model, so switching models/providers in the
  // dialog never touches an already-edited entry.
  const [globalDraft, setGlobalDraft] = useState<ChunkingSet>({})
  const [prefsDraft, setPrefsDraft] = useState<ModelPrefs>({})
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [scopeDraft, setScopeDraft] = useState<SettingsScope>('global')
  const [tuningDraft, setTuningDraft] = useState<Tuning>({})

  // One attempt per open, so a failed fetch is retried by reopening.
  const fetching = useRef(false)
  useEffect(() => {
    if (!open) {
      fetching.current = false
      return
    }
    if (voiceConfig || fetching.current) return
    fetching.current = true
    fetchVoiceConfig().then(cfg => {
      if (!cfg) return
      setVoiceConfig(cfg)
      setSaveMicSamples(cfg.debug?.saveMicSamples ?? false)
      setVoiceSelection(loadVoiceSelection(cfg))
    })
  }, [open, voiceConfig])

  // Seeded once per open, as soon as config is in hand. Re-seeding on every
  // config change would throw away edits made while the dialog is open.
  const seeded = useRef(false)
  useEffect(() => {
    if (!open) {
      seeded.current = false
      return
    }
    if (seeded.current || !voiceConfig || !selection) return
    seeded.current = true
    setServiceId(selection.serviceId)
    setModel(selection.model)
    setVoice(selection.voice)
    setSpeed(selection.speed)
    setSttServiceId(voiceConfig.stt?.serviceId)
    setSaveMicSamplesState(voiceConfig.debug?.saveMicSamples ?? false)
    setTakeover(voiceConfig.takeover ?? 'ask')
    setGlobalDraft(globalSetFromConfig(voiceConfig))
    setPrefsDraft(readPrefs(voiceConfig.tts.modelPrefs))
    setTouched(new Set())
    setScopeDraft(settingsScopeFrom(voiceConfig))
    setTuningDraft(tuningFromConfig(voiceConfig))
  }, [open, voiceConfig, selection])

  const status: VoiceSettingsTabs['status'] =
    !voiceConfig ? 'loading' : !selection ? 'unconfigured' : 'ready'

  const providers = voiceConfig?.tts.providers ?? []
  const currentProvider = providers.find(p => p.serviceId === serviceId)
  const models = (currentProvider?.models ?? []).filter(m => m.realtime === true)
  const currentModel = models.find(m => m.id === model)
  const voices = currentModel?.voices ?? []

  const sttOptions = voiceConfig?.stt?.options ?? []
  const savedSttServiceId = voiceConfig?.stt?.serviceId
  const currentSttOption = sttOptions.find(o => o.serviceId === (sttServiceId ?? savedSttServiceId))
  // Take-over is offered when either voice server the session actually uses
  // — the selected STT service or the selected TTS provider — declares it.
  const declaresSessions = currentSttOption?.sessions === true || currentProvider?.sessions === true

  const modelName = currentModel?.name ?? model
  const draft: ChunkingDraft = {
    scope: scopeDraft,
    global: globalDraft,
    pref: prefsDraft[serviceId]?.[model] ?? emptyPref(CHUNKING),
    modelDefaults: (currentModel?.chunking ?? {}) as ChunkingSet,
  }
  const fields = resolveChunkingFields(draft)

  function setPrefEntry(prefs: ModelPrefs, pref: ModelPref): ModelPrefs {
    return { ...prefs, [serviceId]: { ...(prefs[serviceId] ?? {}), [model]: pref } }
  }

  // Splits a reducer's result back into the two pieces of staged state, and
  // marks this model touched iff its pref actually changed. Moving the
  // setPrefsDraft call inside the guard is deliberate: under 'global' scope
  // editField returns a referentially identical pref, and an unconditional
  // write would create an empty entry for every model the user happens to
  // have selected.
  function commit(next: ChunkingDraft) {
    setGlobalDraft(next.global)
    if (JSON.stringify(draft.pref) !== JSON.stringify(next.pref)) {
      setPrefsDraft(prev => setPrefEntry(prev, next.pref))
      setTouched(prev => new Set(prev).add(touchedKey(serviceId, model)))
    }
  }

  function handleFieldEdit(field: ChunkingField, value: ChunkStrategy | number | undefined) {
    commit(editField(CHUNKING, draft, field, value))
  }

  function handleResetToModelDefaults() {
    commit(deleteModelOverride(CHUNKING, draft))
  }

  function handleProviderChange(newServiceId: string) {
    setServiceId(newServiceId)
    const prov = providers.find(p => p.serviceId === newServiceId)
    const firstModel = prov?.models.find(m => m.realtime === true)
    const firstVoice = firstModel?.voices[0]
    setModel(firstModel?.id ?? '')
    setVoice(firstVoice?.id ?? '')
  }

  function handleModelChange(newModel: string) {
    setModel(newModel)
    const m = currentProvider?.models.find(m => m.id === newModel)
    const firstVoice = m?.voices[0]
    setVoice(firstVoice?.id ?? '')
  }

  async function save(): Promise<boolean> {
    if (!voiceConfig || !selection || !seeded.current) return true

    const selectionChanged =
      serviceId !== selection.serviceId || model !== selection.model
      || voice !== selection.voice || speed !== selection.speed
    const sttChanged = sttServiceId !== undefined && sttServiceId !== savedSttServiceId
    const debugChanged = saveMicSamples !== (voiceConfig.debug?.saveMicSamples ?? false)
    const takeoverChanged = takeover !== (voiceConfig.takeover ?? 'ask')
    const savedScope = settingsScopeFrom(voiceConfig)
    const globalPatch = diffGlobalOptions(globalSetFromConfig(voiceConfig), globalDraft)
    const tuningPatch = diffTuning(tuningFromConfig(voiceConfig), tuningDraft)
    const changed =
      selectionChanged || sttChanged || debugChanged || takeoverChanged || touched.size > 0 || scopeDraft !== savedScope
      || Object.keys(globalPatch).length > 0 || Object.keys(tuningPatch).length > 0
    if (!changed) return true

    const sel: VoiceSelection = resolveVoiceSelection(voiceConfig, { serviceId, model, voice, speed })
    if (endpoint && selection.model !== model) {
      unloadTtsModel(endpoint, selection.modelKey)
    }

    const modelPrefsPatch: Record<string, Record<string, ModelPref | null>> = {}
    for (const key of touched) {
      const [svc, mdl] = key.split('\u0000')
      const pref = prefsDraft[svc]?.[mdl] ?? emptyPref(CHUNKING)
      modelPrefsPatch[svc] = { ...(modelPrefsPatch[svc] ?? {}), [mdl]: buildModelPrefEntry(CHUNKING, pref) }
    }

    let updated: VoiceUpdateResult
    try {
      updated = await updateVoiceSelection({
        serviceId,
        model,
        voice,
        speed,
        ...globalPatch,
        ...(touched.size > 0 && { modelPrefs: modelPrefsPatch }),
        ...(scopeDraft !== savedScope && { settingsScope: scopeDraft }),
        ...(sttChanged && { sttServiceId }),
        ...(debugChanged && { saveMicSamples }),
        ...(takeoverChanged && { takeover }),
        ...tuningPatch,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Voice settings not saved: ${message}`)
      return false
    }
    setSaveMicSamples(saveMicSamples)
    applySavedVoiceSettings(sel, sttChanged ? sttServiceId : undefined, updated)
    return true
  }

  if (status !== 'ready') {
    return { status, voice: null, speech: null, listening: null, debug: null, save }
  }

  const providerSelect = providers.length > 1 && (
    <div className="grid min-w-0 gap-3">
      <Label htmlFor="voice-provider">Provider</Label>
      <Select value={serviceId} onValueChange={handleProviderChange}>
        <SelectTrigger id="voice-provider" className="w-full min-w-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          {providers.map(p => (
            <SelectItem key={p.serviceId} value={p.serviceId}>{p.name ?? p.serviceId}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const modelSelect = models.length > 1 && (
    <div className="grid min-w-0 gap-3">
      <Label htmlFor="voice-model">Model</Label>
      <Select value={model} onValueChange={handleModelChange}>
        <SelectTrigger id="voice-model" className="w-full min-w-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          {models.map(m => (
            <SelectItem key={m.id} value={m.id}>{m.name ?? m.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const voiceSelect = (
    <div className="grid min-w-0 gap-3">
      <Label htmlFor="voice-voice">Voice</Label>
      <Select value={voice} onValueChange={setVoice}>
        <SelectTrigger id="voice-voice" className="w-full min-w-0"><SelectValue /></SelectTrigger>
        <SelectContent>
          {voices.map(v => (
            <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const speedRow = (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="voice-speed">Speed</Label>
        <span className="text-xs text-muted-foreground">{speed.toFixed(1)}x</span>
      </div>
      <Slider
        id="voice-speed"
        min={0.5}
        max={2.0}
        step={0.1}
        value={[speed]}
        onValueChange={(vals) => setSpeed(vals[0])}
      />
    </div>
  )

  const transcriptionSection = sttOptions.length > 1 && (
    <div className="grid gap-3">
      <Label htmlFor="stt-provider">Provider</Label>
      <Select value={sttServiceId ?? ''} onValueChange={setSttServiceId}>
        <SelectTrigger id="stt-provider"><SelectValue /></SelectTrigger>
        <SelectContent>
          {sttOptions.map(o => (
            <SelectItem key={o.serviceId} value={o.serviceId}>{o.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  // Take-over needs a voice server that can honor it — offering it when
  // neither the selected STT service nor the selected TTS provider declares
  // sessions would promise something no socket here has a way to do.
  const takeoverRow = declaresSessions && (
    <div className="flex items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <Label htmlFor="voice-takeover" className="font-normal">Always take over</Label>
        <p className="text-xs text-muted-foreground">
          Our voice servers serve one session at a time. When another session is using one, take it over without asking.
        </p>
      </div>
      <Switch
        id="voice-takeover"
        checked={takeover === 'always'}
        onCheckedChange={(checked) => setTakeover(checked ? 'always' : 'ask')}
      />
    </div>
  )

  const streamingSection = (
    <div className="grid gap-3">
      <Label htmlFor="voice-streaming">Streaming method</Label>
      <Select
        value={streamingBackend}
        onValueChange={(val) => {
          const v = val as StreamingBackend | 'auto'
          setStreamingBackend(v)
          saveStreamingBackend(v)
        }}
      >
        <SelectTrigger id="voice-streaming"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto ({detected === 'mms' ? 'MMS' : detected === 'mse' ? 'MSE' : 'Blob'})</SelectItem>
          <SelectItem value="mms" disabled={typeof ManagedMediaSource === 'undefined'}>MMS streaming</SelectItem>
          <SelectItem value="mse" disabled={typeof MediaSource === 'undefined'}>MSE streaming</SelectItem>
          <SelectItem value="blob">Blob fallback</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Active: {STREAMING_BACKEND === 'mms' ? 'MMS' : STREAMING_BACKEND === 'mse' ? 'MSE' : 'Blob'} — reload to apply
      </p>
    </div>
  )

  // Provider → Model → Voice share a row from md up, one column each, and
  // stack below it.
  const voicePanel = (
    <div className="grid gap-5">
      {transcriptionSection && (
        <Section title="Transcription">
          {transcriptionSection}
        </Section>
      )}
      <Section title="Voice">
        <div className="grid gap-3 md:grid-flow-col md:auto-cols-fr">
          {providerSelect}
          {modelSelect}
          {voiceSelect}
        </div>
        {speedRow}
      </Section>
      <Section title="Playback">
        {streamingSection}
      </Section>
      {takeoverRow && (
        <Section title="Voice servers">
          {takeoverRow}
        </Section>
      )}
    </div>
  )

  const overridePresent = hasOverride(CHUNKING, draft)
  const modelDefaultsPresent = hasModelDefaults(CHUNKING, draft)

  // Precedence ladder for the single note line under the chunking fields —
  // first match wins.
  const noteText: string | null =
    scopeDraft === 'global' && overridePresent
      ? `Saved values for ${modelName} are set aside while every model shares one set.`
      : scopeDraft === 'per-model' && !overridePresent && !modelDefaultsPresent
        ? `${modelName} ships no chunking values of its own — your global preferences apply.`
        : null

  const speechPanel = (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Chunking</h3>
        {scopeDraft === 'per-model' && (
          <span className="text-xs text-muted-foreground">Values for {modelName}</span>
        )}
      </div>

      <RadioGroup
        value={scopeDraft}
        onValueChange={val => setScopeDraft(val as SettingsScope)}
        className="grid gap-2"
      >
        {([
          { value: 'global', label: 'Use the same settings for every model', description: 'Your settings apply everywhere.' },
          { value: 'per-model', label: 'Use per-model settings', description: 'Each model may keep its own, falling back to what it ships, then to yours.' },
        ] as const).map(({ value, label, description }) => (
          <div key={value} className="flex items-start gap-3">
            <RadioGroupItem value={value} id={`scope-${value}`} className="mt-0.5" />
            <div className="grid gap-0.5">
              <Label htmlFor={`scope-${value}`} className="font-normal">{label}</Label>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
          </div>
        ))}
      </RadioGroup>

      <div className="border-t" />

      <RadioGroup
        value={fields.mode.value ?? DEFAULT_CHUNK_STRATEGY}
        onValueChange={val => handleFieldEdit('mode', val as ChunkStrategy)}
        className="grid gap-2"
      >
        {([
          { value: 'two-chunk', label: '2-chunk', description: 'First sentence boundary, then everything else' },
          { value: 'paragraph', label: 'Paragraph', description: 'Emit on double newlines' },
          { value: 'sentence', label: 'Sentence', description: 'Emit at each sentence boundary above min words' },
          { value: 'greedy', label: 'Greedy', description: 'Pack as many sentences as fit within max words' },
        ] as const).map(({ value, label, description }) => (
          <div key={value} className="grid gap-1.5">
            <div className="flex items-start gap-3">
              <RadioGroupItem value={value} id={`chunk-${value}`} className="mt-0.5" />
              <div className="grid gap-0.5">
                <Label htmlFor={`chunk-${value}`} className="font-normal">{label}</Label>
                <p className="text-xs text-muted-foreground">
                  {description}
                  {value === draft.modelDefaults.mode && (
                    <span className="text-muted-foreground"> · {modelName} asks for this</span>
                  )}
                </p>
              </div>
            </div>
            {(fields.mode.value ?? DEFAULT_CHUNK_STRATEGY) === value && (
              <div className="pl-7">
                <FieldProvenance
                  origin={fields.mode.from}
                  modelName={modelName}
                  diverges={divergencesFor(draft, 'mode', fields.mode)}
                />
              </div>
            )}
          </div>
        ))}
      </RadioGroup>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="chunk-min-words">Min words</Label>
          <Input
            id="chunk-min-words"
            type="number"
            min={1}
            max={200}
            value={fields.minWords.value ?? ''}
            placeholder="—"
            onChange={e => handleFieldEdit('minWords', e.target.value ? parseInt(e.target.value) : undefined)}
          />
          <FieldProvenance
            origin={fields.minWords.from}
            modelName={modelName}
            diverges={divergencesFor(draft, 'minWords', fields.minWords)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="chunk-max-words">Max words</Label>
          <Input
            id="chunk-max-words"
            type="number"
            min={1}
            max={500}
            value={fields.maxWords.value ?? ''}
            placeholder="—"
            onChange={e => handleFieldEdit('maxWords', e.target.value ? parseInt(e.target.value) : undefined)}
          />
          <FieldProvenance
            origin={fields.maxWords.from}
            modelName={modelName}
            diverges={divergencesFor(draft, 'maxWords', fields.maxWords)}
          />
        </div>
      </div>

      {noteText && <p className="text-xs text-muted-foreground">{noteText}</p>}

      <div className="flex flex-col sm:flex-row sm:justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full sm:w-auto"
          disabled={scopeDraft === 'global' || !overridePresent}
          onClick={handleResetToModelDefaults}
        >
          Reset to model defaults
        </Button>
      </div>
    </div>
  )

  // A field the config does not set shows a disabled slider: the loop's own
  // default applies there, and the dialog does not know it.
  const listeningPanel = (
    <div className="grid gap-5">
      {([
        { section: 'vad', title: 'Speech detection' },
        { section: 'turnTaking', title: 'Turn taking' },
      ] as const).map(g => (
        <div key={g.section} className="grid gap-4">
          <h3 className="text-sm font-medium text-muted-foreground">
            {g.title} <span className="font-mono text-xs font-normal">stt.{g.section}</span>
          </h3>
          {TUNING_FIELDS.filter(f => f.section === g.section).map(f => {
            const value = tuningDraft[f.key]
            return (
              <div key={f.key} className="grid gap-1.5" title={f.key}>
                <div className="grid grid-cols-[7rem_1fr_4rem] items-center gap-3">
                  <Label htmlFor={`tuning-${f.key}`} className="font-normal">{f.label}</Label>
                  <Slider
                    id={`tuning-${f.key}`}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={[value ?? f.min]}
                    disabled={value === undefined}
                    onValueChange={([v]) => setTuningDraft(prev => ({ ...prev, [f.key]: v }))}
                  />
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {value === undefined ? 'default' : `${value}${f.unit && ` ${f.unit}`}`}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{f.description}</p>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )

  const debugPanel = (
    <div className="flex items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <Label htmlFor="debug-mic-samples" className="font-normal">Save mic samples to disk</Label>
        <p className="text-xs text-muted-foreground">
          Keeps last 50 WAVs sent to STT for debugging.
        </p>
      </div>
      <Switch
        id="debug-mic-samples"
        checked={saveMicSamples}
        onCheckedChange={setSaveMicSamplesState}
      />
    </div>
  )

  return {
    status,
    voice: voicePanel,
    speech: speechPanel,
    listening: listeningPanel,
    debug: debugPanel,
    save,
  }
}
