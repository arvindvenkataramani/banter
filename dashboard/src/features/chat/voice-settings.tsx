import { useState, useEffect } from 'react'
import { Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { unloadTtsModel, setSaveMicSamples } from '@/lib/voice'
import { STREAMING_BACKEND, saveStreamingBackend, getDetectedBackend } from '@/lib/voice/streaming-backend'
import { updateVoiceSelection } from '@/lib/api'
import type { VoiceUpdateResult } from '@/lib/api'
import type { StreamingBackend } from '@/lib/voice/streaming-backend'
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
} from '@/lib/voice/chunking-setting'
import type {
  ChunkingSet,
  ChunkingDraft,
  ChunkingField,
} from '@/lib/voice/chunking-setting'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

interface Props {
  voiceConfig: VoiceConfig
  selection: VoiceSelection
  endpoint: string | null
  onSelectionChange: (sel: VoiceSelection) => void
  onSave?: (sel: VoiceSelection, sttServiceId: string | undefined, updatedVoice: VoiceUpdateResult) => void
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

function FieldProvenance({ origin, modelName, diverges }: {
  origin: FieldOrigin
  modelName: string
  diverges: Array<{ label: string; value: string }>
}) {
  const badgeText =
    origin === 'override' ? 'Yours'
      : origin === 'model' ? `From ${modelName}`
        : origin === 'global' ? 'Global'
          : 'Default'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="text-xs">{badgeText}</Badge>
      {diverges.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {diverges.map(d => `${d.label} ${d.value}`).join(' · ')}
        </span>
      )}
    </div>
  )
}

export function VoiceSettings({ voiceConfig, selection, endpoint, onSelectionChange, onSave }: Props) {
  const [open, setOpen] = useState(false)
  const [serviceId, setServiceId] = useState(selection.serviceId)
  const [model, setModel] = useState(selection.model)
  const [voice, setVoice] = useState(selection.voice)
  const [speed, setSpeed] = useState(selection.speed)
  const [sttServiceId, setSttServiceId] = useState<string | undefined>(voiceConfig.stt?.serviceId)
  const [saveMicSamples, setSaveMicSamplesState] = useState<boolean>(voiceConfig.debug?.saveMicSamples ?? false)
  const [streamingBackend, setStreamingBackend] = useState<StreamingBackend | 'auto'>(() => {
    const stored = localStorage.getItem('tts-streaming-backend')
    return (stored === 'mms' || stored === 'mse' || stored === 'blob') ? stored : 'auto'
  })
  const detected = getDetectedBackend()

  const providers = voiceConfig.tts.providers
  const currentProvider = providers.find(p => p.serviceId === serviceId)
  const models = (currentProvider?.models ?? []).filter(m => m.realtime === true)
  const currentModel = models.find(m => m.id === model)
  const voices = currentModel?.voices ?? []

  // Chunking is staged: nothing reaches the live voice loop until Save.
  // globalDraft/prefsDraft are seeded from voiceConfig on every open (below)
  // so Cancel is a true undo. prefsDraft is keyed by model, so switching
  // models/providers in the dialog never touches an already-edited entry.
  const [globalDraft, setGlobalDraft] = useState<ChunkingSet>(() => globalSetFromConfig(voiceConfig))
  const [prefsDraft, setPrefsDraft] = useState<ModelPrefs>(() => readPrefs(voiceConfig.tts.modelPrefs))
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [scopeDraft, setScopeDraft] = useState<SettingsScope>(() => settingsScopeFrom(voiceConfig))

  useEffect(() => {
    setServiceId(selection.serviceId)
    setModel(selection.model)
    setVoice(selection.voice)
    setSpeed(selection.speed)
  }, [selection])

  useEffect(() => {
    setSttServiceId(voiceConfig.stt?.serviceId)
  }, [voiceConfig.stt?.serviceId])

  useEffect(() => {
    setSaveMicSamplesState(voiceConfig.debug?.saveMicSamples ?? false)
  }, [voiceConfig.debug?.saveMicSamples])

  useEffect(() => {
    if (!open) return
    setGlobalDraft(globalSetFromConfig(voiceConfig))
    setPrefsDraft(readPrefs(voiceConfig.tts.modelPrefs))
    setTouched(new Set())
    setScopeDraft(settingsScopeFrom(voiceConfig))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const sttOptions = voiceConfig.stt?.options ?? []
  const savedSttServiceId = voiceConfig.stt?.serviceId

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

  function handleScopeChange(next: SettingsScope) {
    setScopeDraft(next)
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

  async function handleSave() {
    const voiceObj = currentModel?.voices.find(v => v.id === voice)
    // Merge model-level requestParams (backend-specific tuning per model)
    // with voice-level extra fields (per-voice overrides like ref_audio).
    // Voice fields win on key collision.
    const params: Record<string, unknown> = { ...(currentModel?.requestParams ?? {}) }
    if (voiceObj) {
      for (const [k, v] of Object.entries(voiceObj)) {
        if (k !== 'id' && k !== 'name') params[k] = v
      }
    }
    const sel: VoiceSelection = { serviceId, model, voice, speed, params: Object.keys(params).length ? params : undefined }
    if (endpoint && selection.model !== model) {
      unloadTtsModel(endpoint, selection.model)
    }

    const sttChanged = sttServiceId && sttServiceId !== savedSttServiceId
    const savedSaveMicSamples = voiceConfig.debug?.saveMicSamples ?? false
    const debugChanged = saveMicSamples !== savedSaveMicSamples

    const modelPrefsPatch: Record<string, Record<string, ModelPref | null>> = {}
    for (const key of touched) {
      const [svc, mdl] = key.split('\u0000')
      const pref = prefsDraft[svc]?.[mdl] ?? emptyPref(CHUNKING)
      modelPrefsPatch[svc] = { ...(modelPrefsPatch[svc] ?? {}), [mdl]: buildModelPrefEntry(CHUNKING, pref) }
    }

    const savedScope = settingsScopeFrom(voiceConfig)

    let updated: VoiceUpdateResult
    try {
      updated = await updateVoiceSelection({
        serviceId,
        model,
        voice,
        speed,
        ...diffGlobalOptions(globalSetFromConfig(voiceConfig), globalDraft),
        ...(touched.size > 0 && { modelPrefs: modelPrefsPatch }),
        ...(scopeDraft !== savedScope && { settingsScope: scopeDraft }),
        ...(sttChanged && { sttServiceId }),
        ...(debugChanged && { saveMicSamples }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Voice settings not saved: ${message}`)
      return
    }
    setSaveMicSamples(saveMicSamples)

    onSelectionChange(sel)
    onSave?.(sel, sttChanged ? sttServiceId : undefined, updated)
    setOpen(false)
  }

  const providerSelect = providers.length > 1 && (
    <div className="grid gap-3">
      <Label htmlFor="voice-provider">Provider</Label>
      <Select value={serviceId} onValueChange={handleProviderChange}>
        <SelectTrigger id="voice-provider"><SelectValue /></SelectTrigger>
        <SelectContent>
          {providers.map(p => (
            <SelectItem key={p.serviceId} value={p.serviceId}>{p.name ?? p.serviceId}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const modelSelect = models.length > 1 && (
    <div className="grid gap-3">
      <Label htmlFor="voice-model">Model</Label>
      <Select value={model} onValueChange={handleModelChange}>
        <SelectTrigger id="voice-model"><SelectValue /></SelectTrigger>
        <SelectContent>
          {models.map(m => (
            <SelectItem key={m.id} value={m.id}>{m.name ?? m.id}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  const voiceSelect = (
    <div className="grid gap-3">
      <Label htmlFor="voice-voice">Voice</Label>
      <Select value={voice} onValueChange={setVoice}>
        <SelectTrigger id="voice-voice"><SelectValue /></SelectTrigger>
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

  // Mobile (tabs): stack linearly
  const voiceSectionMobile = (
    <>
      {providerSelect}
      {modelSelect}
      {voiceSelect}
      {speedRow}
    </>
  )

  // Desktop: Provider → Model → Voice on a single row, Speed below.
  // Collect only the selects we'll render so the grid sizes itself to them.
  const desktopRowSelects = [providerSelect, modelSelect, voiceSelect].filter(Boolean)
  const voiceSectionDesktop = (
    <>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${desktopRowSelects.length}, minmax(0, 1fr))` }}
      >
        {desktopRowSelects}
      </div>
      {speedRow}
    </>
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

  const debugSection = (
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

  const overridePresent = hasOverride(CHUNKING, draft)
  const modelDefaultsPresent = hasModelDefaults(CHUNKING, draft)

  // Precedence ladder for the single note line under the chunking fields —
  // first match wins. See plans/voice-chat.md's settings phase.
  const noteText: string | null =
    scopeDraft === 'global' && overridePresent
      ? `Saved values for ${modelName} are set aside while every model shares one set.`
      : scopeDraft === 'per-model' && !overridePresent && !modelDefaultsPresent
        ? `${modelName} ships no chunking values of its own — your global preferences apply.`
        : null

  const chunkingPanel = (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Chunking</h3>
        {scopeDraft === 'per-model' && (
          <span className="text-xs text-muted-foreground">Values for {modelName}</span>
        )}
      </div>

      <RadioGroup
        value={scopeDraft}
        onValueChange={val => handleScopeChange(val as SettingsScope)}
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <Settings2 className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[680px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Voice Settings</DialogTitle>
          <DialogDescription>
            Configure voice output and playback.
          </DialogDescription>
        </DialogHeader>

        {/* One structure at every width. The old split — tabs below md,
            everything stacked above — put an iPad on the stacked path, where
            the accumulated sections no longer fit vertically. Tabs bound the
            height by construction; the body scrolls as a backstop. */}
        <Tabs defaultValue="general">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">General</TabsTrigger>
            <TabsTrigger value="speech" className="flex-1">Speech</TabsTrigger>
            <TabsTrigger value="debug" className="flex-1">Debug</TabsTrigger>
          </TabsList>

          <div className="mt-4 max-h-[60vh] overflow-y-auto pr-1">
            <TabsContent value="general" className="grid gap-5 mt-0">
              {transcriptionSection && (
                <Section title="Transcription">
                  {transcriptionSection}
                </Section>
              )}
              <Section title="Voice">
                <div className="md:hidden grid gap-3">{voiceSectionMobile}</div>
                <div className="hidden md:grid gap-3">{voiceSectionDesktop}</div>
              </Section>
              <Section title="Playback">
                {streamingSection}
              </Section>
            </TabsContent>

            {/* Chunking is the only per-model setting, so it is the whole tab
                and needs no panel border to separate it from siblings. */}
            <TabsContent value="speech" className="mt-0">
              {chunkingPanel}
            </TabsContent>

            <TabsContent value="debug" className="mt-0">
              {debugSection}
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
