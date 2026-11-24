// The Settings dialog's voice tabs: the layout and wording, over the draft in
// voice-settings-model.ts. State and saving live in voice-settings.tsx.

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { STREAMING_BACKEND, saveStreamingBackend, getDetectedBackend } from '@platform/voice-engine/system/streaming-backend'
import type { StreamingBackend } from '@platform/voice-engine/system/streaming-backend'
import { DEFAULT_CHUNK_STRATEGY } from '@platform/voice-engine/agent/chunking-setting'
import type { FieldOrigin, SettingsScope } from '@platform/voice-engine/model-settings'
import type { ChunkStrategy } from '@/lib/voice'
import { useStore } from 'zustand'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import { describeSttInUse } from '@platform/voice-engine/stt-mode-text'
import { Section, FieldProvenance } from './voice-settings-parts'
import {
  TUNING_FIELDS, chunkingView, editChunking, resetChunking, resetTuning, roster, setModel, setProvider,
  selectionErrors, sttPickerOptions, setPreferStreaming, setSaveMicSamples, setScope, setSpeed, setSttService, setTakeover, setTuning, setVoice, type Draft,
} from './voice-settings-model'

export type Edit = (change: (current: Draft) => Draft) => void

// ── Layout parts ─────────────────────────────────────────────────────────

const REPO = 'https://github.com/arvindvenkataramani/banter'
const doc = (path: string): string => `${REPO}/blob/main/${path}`

function DocLink({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <a className="underline underline-offset-2 hover:text-foreground" href={path.startsWith('http') ? path : doc(path)} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function Help({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

/** Why the stored selection fails the selection check, beside the selector it concerns; nothing while it passes. */
function SelectionError({ message }: { message: string | undefined }) {
  if (!message) return null
  return (
    <Badge variant="destructive" className="h-auto whitespace-normal" role="alert">
      {message}
    </Badge>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-3">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

function SwitchRow({ id, label, description, checked, onChange }: {
  id: string; label: string; description: string; checked: boolean; onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="font-normal">{label}</Label>
        <Help>{description}</Help>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function SelectField({ id, value, options, onChange }: {
  id: string
  value: string
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full min-w-0"><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map(o => <SelectItem key={o.value} value={o.value} disabled={o.disabled}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function RadioChoices<Value extends string>({ name, label, description, value, choices, onChange }: {
  name: string
  label: string
  description?: React.ReactNode
  value: Value
  choices: ReadonlyArray<{ value: Value; label: string; description: React.ReactNode; extra?: React.ReactNode }>
  onChange: (value: Value) => void
}) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <span id={`${name}-label`} className="text-sm leading-none font-medium">{label}</span>
        {description !== undefined && <Help>{description}</Help>}
      </div>
      <RadioGroup value={value} onValueChange={next => onChange(next as Value)} aria-labelledby={`${name}-label`} className="grid gap-2">
        {choices.map(choice => (
          <div key={choice.value} className="grid gap-1.5">
            <div className="flex items-start gap-3">
              <RadioGroupItem value={choice.value} id={`${name}-${choice.value}`} className="mt-0.5" />
              <div className="grid gap-0.5">
                <Label htmlFor={`${name}-${choice.value}`} className="font-normal">{choice.label}</Label>
                <Help>{choice.description}</Help>
              </div>
            </div>
            {value === choice.value && choice.extra !== undefined && <div className="pl-7">{choice.extra}</div>}
          </div>
        ))}
      </RadioGroup>
    </div>
  )
}

/** Banter's provenance badge, with a tooltip saying where the value comes from. */
function Provenance(props: { origin: FieldOrigin; modelName: string; diverges: Array<{ label: string; value: string }> }) {
  const { origin, modelName } = props
  const about = origin === 'override'
    ? 'You set this'
    : origin === 'model'
      ? `${modelName} ships this value`
      : origin === 'global' ? 'Your setting for every model' : 'Nothing sets this; the built-in default applies'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-fit"><FieldProvenance {...props} /></div>
      </TooltipTrigger>
      <TooltipContent>{about}</TooltipContent>
    </Tooltip>
  )
}

// ── Panels ───────────────────────────────────────────────────────────────

interface PanelProps {
  draft: Draft
  edit: Edit
}

const SCOPE_CHOICES = [
  { value: 'global', label: 'Use the same settings for every model', description: 'Your settings apply everywhere.' },
  { value: 'per-model', label: 'Use per-model settings', description: 'Each model may keep its own, falling back to what it ships, then to yours.' },
] as const

const MODE_CHOICES: ReadonlyArray<{ value: ChunkStrategy; label: string; description: string }> = [
  { value: 'two-chunk', label: '2-chunk', description: "Speaks the first sentence as soon as it's ready, then the rest as one piece" },
  { value: 'paragraph', label: 'Paragraph', description: 'Speaks a paragraph at a time' },
  { value: 'sentence', label: 'Sentence', description: 'Speaks each sentence once it has at least Min words' },
  { value: 'greedy', label: 'Greedy', description: 'Groups sentences into pieces of up to Max words' },
]

const backendName = (backend: StreamingBackend): string => (backend === 'mms' ? 'MMS' : backend === 'mse' ? 'MSE' : 'Blob')

/** The stored streaming choice, or 'auto' when none is stored or storage is unavailable. */
function readStreamingChoice(): StreamingBackend | 'auto' {
  try {
    const stored = localStorage.getItem('tts-streaming-backend')
    return stored === 'mms' || stored === 'mse' || stored === 'blob' ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

export function SpeechPanel({ draft, edit }: PanelProps) {
  const voices = roster(draft)
  const view = chunkingView(draft)
  const [streaming, setStreaming] = useState<StreamingBackend | 'auto'>(readStreamingChoice)
  const mode = view.fields.mode.value ?? DEFAULT_CHUNK_STRATEGY
  const modelMode = view.draft.modelDefaults.mode
  const words = (field: 'minWords' | 'maxWords', id: string, label: string, max: number, description: string) => (
    <Field id={id} label={label}>
      <Input
        id={id}
        type="number"
        min={1}
        max={max}
        placeholder="—"
        value={view.fields[field].value ?? ''}
        onChange={event => { edit(d => editChunking(d, field, event.target.value ? parseInt(event.target.value, 10) : undefined)) }}
      />
      <Help>{description}</Help>
      <Provenance origin={view.fields[field].from} modelName={view.modelName} diverges={view.divergences[field]} />
    </Field>
  )
  return (
    <div className="grid gap-5">
      <Section title="Voice">
        <div className="grid gap-3 md:grid-flow-col md:auto-cols-fr">
          {voices.providers.length > 1 && (
            <Field id="voice-provider" label="Provider">
              <SelectField
                id="voice-provider"
                value={draft.ttsServiceId}
                options={voices.providers.map(p => ({ value: p.serviceId, label: p.name ?? p.serviceId }))}
                onChange={value => { edit(d => setProvider(d, value)) }}
              />
            </Field>
          )}
          {voices.models.length > 1 && (
            <Field id="voice-model" label="Model">
              <SelectField
                id="voice-model"
                value={draft.ttsModel}
                options={voices.models.map(m => ({ value: m.id, label: m.name ?? m.id }))}
                onChange={value => { edit(d => setModel(d, value)) }}
              />
            </Field>
          )}
          <Field id="voice-voice" label="Voice">
            <SelectField
              id="voice-voice"
              value={draft.ttsVoice}
              options={voices.voices.map(v => ({ value: v.id, label: v.name }))}
              onChange={value => { edit(d => setVoice(d, value)) }}
            />
          </Field>
          <div className="grid min-w-0 gap-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="voice-speed">Speed</Label>
              <span className="text-xs tabular-nums text-muted-foreground">{draft.ttsSpeed.toFixed(1)}x</span>
            </div>
            {/* The height of a select, so the slider lines up with the controls beside it. */}
            <div className="flex h-9 items-center">
              <Slider id="voice-speed" min={0.5} max={2} step={0.1} value={[draft.ttsSpeed]} onValueChange={([v]) => { edit(d => setSpeed(d, v)) }} />
            </div>
          </div>
        </div>
        <SelectionError message={selectionErrors(draft).tts} />
        <Help>
          Only models that can stream speech in real time are listed.{' '}
          <DocLink path="docs/guide/models.md#text-to-speech-models">Speech models</DocLink>
          {' · '}
          <DocLink path="docs/guide/voices-and-models.md">Voices and models</DocLink>
        </Help>
      </Section>

      <Section title="Chunking" aside={draft.scope === 'per-model' ? <Help>Changes here apply only to {view.modelName}</Help> : undefined}>
        <RadioChoices<ChunkStrategy>
          name="chunk-mode"
          label="How replies are split"
          description="Replies are streamed and speech models handle limited text, so replies are split into chunks; the best settings depend on the model."
          value={mode}
          choices={MODE_CHOICES.map(choice => ({
            ...choice,
            description: choice.value === modelMode ? `${choice.description} · ${view.modelName} asks for this` : choice.description,
            extra: <Provenance origin={view.fields.mode.from} modelName={view.modelName} diverges={view.divergences.mode} />,
          }))}
          onChange={value => { edit(d => editChunking(d, 'mode', value)) }}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {words('minWords', 'chunk-min-words', 'Min words', 200, "The shortest piece spoken on its own; shorter sentences wait to join the next. In 2-chunk, the first piece's minimum.")}
          {words('maxWords', 'chunk-max-words', 'Max words', 500, "The longest piece before it's cut at a sentence or clause. Used by Sentence and Greedy.")}
        </div>
        <RadioChoices<SettingsScope>
          name="chunk-scope"
          label="Applies to"
          description={
            <>
              Whether these chunking settings are shared by every speech model or kept per model.{' '}
              <DocLink path="docs/reference/configuration.md#settings-scope">How per-model values are chosen</DocLink>
            </>
          }
          value={draft.scope}
          choices={SCOPE_CHOICES}
          onChange={value => { edit(d => setScope(d, value)) }}
        />
        {view.note !== null && <Help>{view.note}</Help>}
        <div className="flex flex-col sm:flex-row sm:justify-end gap-2">
          <Button variant="outline" size="sm" className="w-full sm:w-auto" disabled={draft.scope === 'global' || !view.overridePresent} onClick={() => { edit(resetChunking) }}>
            Reset to model defaults
          </Button>
        </div>
      </Section>

      <Section>
        <Field id="voice-streaming" label="Playback method">
          <SelectField
            id="voice-streaming"
            value={streaming}
            options={[
              { value: 'auto', label: `Auto (${backendName(getDetectedBackend())})` },
              { value: 'mms', label: 'MMS streaming', disabled: typeof ManagedMediaSource === 'undefined' },
              { value: 'mse', label: 'MSE streaming', disabled: typeof MediaSource === 'undefined' },
              { value: 'blob', label: 'Blob fallback' },
            ]}
            // Saved as soon as it changes, outside the draft: the engine reads it from the browser's storage when it loads.
            onChange={value => {
              const choice = value as StreamingBackend | 'auto'
              setStreaming(choice)
              saveStreamingBackend(choice)
            }}
          />
          <Help>
            How speech audio reaches the browser. Leave on Auto unless speech stutters or cuts out. Saved in this browser as soon as you change
            it, apart from Save; takes effect when you reload the page. Now using {backendName(STREAMING_BACKEND)}.
          </Help>
        </Field>
      </Section>
    </div>
  )
}

const MODE_CHOICE = [
  { value: 'streaming', label: 'Streaming', description: 'Your words appear as you speak.' },
  { value: 'batch', label: 'Batch', description: 'Transcribes each time you pause, so there is no live preview: your words appear after each pause. A little more accurate.' },
] as const

function TranscriptionMode({ draft, edit }: PanelProps) {
  const inUse = useStore(useVoiceSystemStore, s => s.stt)
  const model = draft.config.stt?.model
  return (
    <Section title="Transcription mode" aside={model ? <Help>Model: <span className="font-mono">{model}</span></Help> : undefined}>
      <RadioChoices<'streaming' | 'batch'>
        name="stt-mode"
        label="How your speech becomes text"
        description="Decides only for a model that can do both; a model that works one way uses that way."
        value={draft.preferStreaming ? 'streaming' : 'batch'}
        choices={MODE_CHOICE}
        onChange={value => { edit(d => setPreferStreaming(d, value === 'streaming')) }}
      />
      {inUse !== null && <p className="text-xs text-foreground" role="status">{describeSttInUse(inUse)}</p>}
    </Section>
  )
}

export function ListeningPanel({ draft, edit }: PanelProps) {
  const view = roster(draft)
  return (
    <div className="grid gap-5">
      {view.sttOptions.length > 0 && (
        <Section>
          <Field id="stt-provider" label="Transcription provider">
            <SelectField
              id="stt-provider"
              value={draft.sttServiceId}
              options={sttPickerOptions(draft)}
              onChange={value => { edit(d => setSttService(d, value)) }}
            />
            <Help>
              The speech-to-text server that turns what you say into text.{' '}
              <DocLink path="docs/guide/stt.md">Setting up STT servers</DocLink>
              {' · '}
              <DocLink path="docs/guide/models.md#speech-to-text-models">Transcription models</DocLink>
            </Help>
            <SelectionError message={selectionErrors(draft).stt} />
          </Field>
        </Section>
      )}
      <TranscriptionMode draft={draft} edit={edit} />
      {([
        { section: 'vad', title: 'Speech detection' },
        { section: 'turnTaking', title: 'Turn taking' },
      ] as const).map(group => (
        <Section
          key={group.section}
          title={<>{group.title} <span className="font-mono text-xs font-normal">stt.{group.section}</span></>}
          aside={<Help><DocLink path="docs/reference/components/voice-interface.md#what-the-settings-mean">What these do</DocLink></Help>}
        >
          {TUNING_FIELDS.filter(f => f.section === group.section).map(f => {
            const value = draft.tuning[f.key]
            return (
              <div key={f.key} className="grid gap-1.5" title={f.key}>
                <div className="grid grid-cols-[7rem_1fr_auto] items-center gap-3">
                  <Label htmlFor={`tuning-${f.key}`} className="font-normal">{f.label}</Label>
                  <Slider
                    id={`tuning-${f.key}`}
                    aria-label={f.label}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={[value ?? f.default]}
                    onValueChange={([next]) => { edit(d => setTuning(d, f.key, next)) }}
                  />
                  <span className="flex items-center justify-end gap-2 text-xs tabular-nums text-muted-foreground">
                    {value !== undefined && (
                      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => { edit(d => resetTuning(d, f.key)) }}>
                        Reset
                      </Button>
                    )}
                    {value === undefined ? `default (${f.default}${f.unit})` : `${value}${f.unit}`}
                  </span>
                </div>
                <Help>{f.description}</Help>
              </div>
            )
          })}
        </Section>
      ))}
    </div>
  )
}

export function GeneralPanel({ draft, edit }: PanelProps) {
  const view = roster(draft)
  return (
    <div className="grid gap-5">
      {view.offersTakeover && (
        <SwitchRow
          id="voice-takeover"
          label="Always take over"
          description="Speech servers serve one session at a time. When another session is using one, take it over without asking; otherwise you'll be asked."
          checked={draft.takeover === 'always'}
          onChange={checked => { edit(d => setTakeover(d, checked ? 'always' : 'ask')) }}
        />
      )}
      <SwitchRow
        id="debug-mic-samples"
        label="Save mic samples to disk"
        description="Keeps the last 50 recordings sent for transcription, for debugging."
        checked={draft.saveMicSamples}
        onChange={checked => { edit(d => setSaveMicSamples(d, checked)) }}
      />
    </div>
  )
}

const HELP_LINKS: ReadonlyArray<{ heading: string; links: ReadonlyArray<{ label: string; path: string; about: string }> }> = [
  {
    heading: 'General',
    links: [
      { label: 'Install Banter', path: 'docs/guide/install.md', about: 'Installing the Banter server' },
      { label: 'Speech servers', path: 'docs/guide/speech-servers.md', about: 'Connecting speech servers to Banter' },
      { label: 'Configuration reference', path: 'docs/reference/configuration.md', about: 'Every setting in the Banter server’s config.json and registry.json' },
    ],
  },
  {
    heading: 'Speech (TTS)',
    links: [
      { label: 'TTS setup', path: 'docs/guide/tts.md', about: 'Setting up each text-to-speech server' },
      { label: 'Speech models', path: 'docs/guide/models.md#text-to-speech-models', about: 'Which speech models exist and what each needs' },
      { label: 'Voices and models', path: 'docs/guide/voices-and-models.md', about: 'How providers, models and voices fit together' },
    ],
  },
  {
    heading: 'Transcription (STT)',
    links: [
      { label: 'STT setup', path: 'docs/guide/stt.md', about: 'Setting up each speech-to-text server' },
      { label: 'Transcription models', path: 'docs/guide/models.md#speech-to-text-models', about: 'Which transcription models exist and what each needs' },
    ],
  },
  { heading: 'Project', links: [{ label: 'Repository', path: REPO, about: 'Banter’s source code' }] },
]

export function HelpPanel() {
  return (
    <div className="grid gap-5">
      {HELP_LINKS.map(group => (
        <Section key={group.heading} title={group.heading}>
          <ul className="grid gap-2">
            {group.links.map(link => (
              <li key={link.path} className="grid gap-0.5 text-sm">
                <DocLink path={link.path}>{link.label}</DocLink>
                <Help>{link.about}</Help>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </div>
  )
}
