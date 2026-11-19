// The plugin's page in dsh's plugin manager (the `plugins.bundle.config` slot):
// Banter's settings dialog as tabs. Every edit is staged in a draft
// (settings-model.ts) and one Save writes it through the config form's
// `mutate`, fenced by the revision the draft was seeded at.

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Input, SegmentedTabs, Switch, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { STREAMING_BACKEND, getDetectedBackend, saveStreamingBackend } from '@platform/voice-engine/system/streaming-backend'
import type { StreamingBackend } from '@platform/voice-engine/system/streaming-backend'
import { DEFAULT_CHUNK_STRATEGY } from '@platform/voice-engine/agent/chunking-setting'
import type { ChunkStrategy } from '@platform/voice-engine/voice-config'
import type { FieldOrigin, SettingsScope } from '@platform/voice-engine/model-settings'
import { DEFAULT_SETTINGS, type PluginSettings } from '../host/settings.ts'
import type { DshConfigForm } from './dsh-types.ts'
import { RadioChoices, SelectField, SliderField, type SelectOption } from './settings-controls.tsx'
import { ReadOnly, SCOPE, ensureStyles } from './settings-style.ts'
import {
  TUNING_FIELDS, buildWrite, chunkingView, editChunking, resetChunking, roster, seedDraft, setControlPlaneUrl, setKeepVoiceOutside,
  resetTuning, setModel, setProvider, setScope, setSpeed, setSttService, setTakeover, setTuning, setVoice, type Draft,
} from './settings-model.ts'

type TabId = 'speech' | 'listening' | 'general' | 'help'

const tabId = (tab: TabId): string => `dsh-voice-tab-${tab}`
const panelId = (tab: TabId): string => `dsh-voice-panel-${tab}`

const tabItem = (value: TabId, label: string) => ({ value, label, id: tabId(value), panelId: panelId(value) })
const TAB_ITEMS = [tabItem('speech', 'Speech'), tabItem('listening', 'Listening'), tabItem('general', 'General'), tabItem('help', 'Help')] as const

/** What a draft was seeded from: the stored settings and the revision they were read at. */
interface Base {
  settings: PluginSettings
  revision: number | undefined
}

export function SettingsCard({ form }: { form: DshConfigForm<PluginSettings> }) {
  ensureStyles()
  // dsh's forms are class instances whose methods read `this`, so they are called through the form.
  const state = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [base, setBase] = useState<Base | null>(null)
  const [tab, setTab] = useState<TabId>('speech')
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const stored = state.status === 'ready' ? state.value : undefined
  const dirty = useMemo(() => draft !== null && base !== null && buildWrite(base.settings, draft).ops.length > 0, [draft, base])

  // Seeds the draft once the settings arrive, and again when they change under a draft with nothing staged.
  // React re-renders at once with the state set here, so the page never paints an unseeded or stale draft.
  if (stored !== undefined && (draft === null || (!dirty && base?.revision !== state.revision))) {
    const settings = { ...DEFAULT_SETTINGS, ...stored }
    setBase({ settings, revision: state.revision })
    setDraft(seedDraft(settings))
  }

  if (state.status !== 'ready') return <p data-dsh-voice="settings-status">{state.status}</p>
  if (draft === null || base === null) return <p data-dsh-voice="settings-status">loading</p>

  const edit = (change: (current: Draft) => Draft): void => {
    setProblem(null)
    setDraft(current => (current === null ? current : change(current)))
  }

  const cancel = (): void => {
    setProblem(null)
    setDraft(seedDraft(base.settings))
  }

  const save = async (): Promise<void> => {
    const write = buildWrite(base.settings, draft)
    if (write.ops.length === 0) return
    setSaving(true)
    setProblem(null)
    try {
      if (await form.mutate(write.ops, base.revision)) {
        setBase({ settings: write.next, revision: form.getSnapshot().revision })
        setDraft(seedDraft(write.next))
      } else {
        setProblem('Settings not saved: dsh did not accept them. Cancel to reload what is stored.')
      }
    } catch (error) {
      setProblem(`Settings not saved: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const readOnly = !state.writable
  return (
    <div className={`${SCOPE} dv-page`} data-dsh-voice="settings" data-readonly={readOnly ? '' : undefined}>
      <ReadOnly.Provider value={readOnly}>
        <SegmentedTabs
          label="Voice settings"
          items={TAB_ITEMS}
          value={tab}
          onChange={setTab}
        />
        <fieldset className="dv-panel" role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} disabled={readOnly}>
          {tab === 'speech' && <SpeechPanel draft={draft} edit={edit} />}
          {tab === 'listening' && <ListeningPanel draft={draft} edit={edit} />}
          {tab === 'general' && <GeneralPanel draft={draft} edit={edit} />}
          {tab === 'help' && <HelpSection />}
        </fieldset>
      </ReadOnly.Provider>
      <div className="dv-footer">
        {readOnly && <span className="dv-problem" role="status">Settings are read-only here.</span>}
        {problem !== null && <span className="dv-problem" role="alert">{problem}</span>}
        <Button variant="ghost" disabled={!dirty || saving} onClick={cancel}>Cancel</Button>
        <Button variant="primary" disabled={!dirty || saving || readOnly} onClick={() => { void save() }}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  )
}

interface PanelProps {
  draft: Draft
  edit: (change: (current: Draft) => Draft) => void
}

function Section({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="dv-section">
      {title === undefined ? null : aside === undefined ? (
        <h3 className="dv-heading">{title}</h3>
      ) : (
        <div className="dv-split">
          <h3 className="dv-heading">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </section>
  )
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="dv-field">
      <label htmlFor={id} className="dv-label">{label}</label>
      {children}
    </div>
  )
}

/** A label and one-line description beside a switch. */
function SwitchRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="dv-split dv-split-top">
      <div className="dv-field">
        <span className="dv-label">{label}</span>
        <p className="dv-help">{description}</p>
      </div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  )
}

const optionsOf = (items: ReadonlyArray<{ id: string; name?: string }>): SelectOption[] => items.map(item => ({ value: item.id, label: item.name ?? item.id }))

function GeneralPanel({ draft, edit }: PanelProps) {
  const view = roster(draft)
  return (
    <>
      <Section>
        <Field id="dv-control-plane" label="Banter server URL">
          <Input
            id="dv-control-plane"
            className="dv-input"
            value={draft.controlPlaneUrl}
            onChange={event => { edit(d => setControlPlaneUrl(d, event.target.value)) }}
          />
          <p className="dv-help">
            The address of your Banter install: the same address you open Banter's dashboard at. The install script prints it when
            it finishes. The plugin reaches the speech services through it. The provider, model and voice lists were copied from this server
            when the plugin was installed; re-running the install step picks up changes, and also resets these settings to the server's.{' '}
            <a className="dv-link" href={doc('docs/setup/install.md')} target="_blank" rel="noreferrer">Install Banter</a>
          </p>
        </Field>
        {view.declaresSessions && (
          <SwitchRow
            label="Always take over"
            description="Speech servers serve one session at a time. When another session is using one, take it over without asking; otherwise you'll be asked."
            checked={draft.takeover === 'always'}
            onChange={checked => { edit(d => setTakeover(d, checked ? 'always' : 'ask')) }}
          />
        )}
        <SwitchRow
          label="Keep voice on outside a conversation"
          description="Voice keeps running when you leave a conversation for another dsh page, instead of turning off."
          checked={draft.keepVoiceOutside}
          onChange={checked => { edit(d => setKeepVoiceOutside(d, checked)) }}
        />
      </Section>
    </>
  )
}

const REPO = 'https://github.com/arvindvenkataramani/banter'
const doc = (path: string): string => `${REPO}/blob/main/${path}`

const HELP_LINKS: ReadonlyArray<{ heading: string; links: ReadonlyArray<{ label: string; href: string; about: string }> }> = [
  {
    heading: 'General',
    links: [
      { label: 'Plugin docs', href: doc('docs/dsh-voice/README.md'), about: 'What the plugin does, its controls, and how to set it up' },
      { label: 'Install Banter', href: doc('docs/setup/install.md'), about: 'Installing the Banter server, which prints its URL when it finishes' },
      { label: 'Speech servers', href: doc('docs/setup/speech-servers.md'), about: 'Connecting speech servers to Banter' },
      { label: 'Configuration reference', href: doc('docs/setup/configuration.md'), about: 'Every setting in the Banter server’s config.json and registry.json' },
    ],
  },
  {
    heading: 'Speech (TTS)',
    links: [
      { label: 'TTS setup', href: doc('docs/setup/tts.md'), about: 'Setting up each text-to-speech server' },
      { label: 'Speech models', href: doc('docs/setup/models.md#text-to-speech-models'), about: 'Which speech models exist and what each needs' },
      { label: 'Voices and models', href: doc('docs/setup/voices-and-models.md'), about: 'How providers, models and voices fit together' },
    ],
  },
  {
    heading: 'Transcription (STT)',
    links: [
      { label: 'STT setup', href: doc('docs/setup/stt.md'), about: 'Setting up each speech-to-text server' },
      { label: 'Transcription models', href: doc('docs/setup/models.md#speech-to-text-models'), about: 'Which transcription models exist and what each needs' },
    ],
  },
  { heading: 'Project', links: [{ label: 'Repository', href: REPO, about: 'Banter’s source code' }] },
]

function HelpSection() {
  return (
    <Section>
      <div className="dv-help-groups">
      {HELP_LINKS.map(group => (
        <div key={group.heading} className="dv-links">
          <h4 className="dv-subheading">{group.heading}</h4>
          <ul className="dv-link-list">
            {group.links.map(link => (
              <li key={link.href} className="dv-link-row">
                <a className="dv-link" href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                <span className="dv-help">{link.about}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      </div>
    </Section>
  )
}

/** The stored streaming choice, or 'auto' when none is stored or storage is unavailable. */
function readStreamingChoice(): StreamingBackend | 'auto' {
  try {
    const stored = localStorage.getItem('tts-streaming-backend')
    return stored === 'mms' || stored === 'mse' || stored === 'blob' ? stored : 'auto'
  } catch {
    return 'auto'
  }
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

function Provenance({ origin, modelName, diverges }: { origin: FieldOrigin; modelName: string; diverges: Array<{ label: string; value: string }> }) {
  const text = origin === 'override' ? 'Yours' : origin === 'model' ? `From ${modelName}` : origin === 'global' ? 'Global' : 'Default'
  const about = origin === 'override'
    ? 'You set this'
    : origin === 'model'
      ? `${modelName} ships this value`
      : origin === 'global' ? 'Your setting for every model' : 'Nothing sets this; the built-in default applies'
  return (
    <div className="dv-provenance">
      <Tooltip label={about} side="top" portal>
        <span><Tag tone={origin === 'override' ? 'info' : origin === 'none' ? 'quiet' : 'neutral'}>{text}</Tag></span>
      </Tooltip>
      {diverges.length > 0 && <span className="dv-help">{diverges.map(d => `${d.label} ${d.value}`).join(' · ')}</span>}
    </div>
  )
}

function SpeechPanel({ draft, edit }: PanelProps) {
  const voices = roster(draft)
  const view = chunkingView(draft)
  const [streaming, setStreaming] = useState<StreamingBackend | 'auto'>(readStreamingChoice)
  const detected = getDetectedBackend()
  const backendName = (backend: StreamingBackend): string => (backend === 'mms' ? 'MMS' : backend === 'mse' ? 'MSE' : 'Blob')
  const mode = view.fields.mode.value ?? DEFAULT_CHUNK_STRATEGY
  const modelMode = view.draft.modelDefaults.mode
  const words = (field: 'minWords' | 'maxWords', id: string, label: string, max: number, description: string) => (
    <Field id={id} label={label}>
      <Input
        id={id}
        className="dv-input"
        type="number"
        min={1}
        max={max}
        placeholder="—"
        value={view.fields[field].value ?? ''}
        onChange={event => { edit(d => editChunking(d, field, event.target.value ? parseInt(event.target.value, 10) : undefined)) }}
      />
      <p className="dv-help">{description}</p>
      <Provenance origin={view.fields[field].from} modelName={view.modelName} diverges={view.divergences[field]} />
    </Field>
  )
  return (
    <>
      <Section title="Voice">
        {voices.providers.length === 0 ? (
          <p className="dv-help">The settings hold no voice roster, so there is nothing to choose from.</p>
        ) : (
          <>
            <div className="dv-row">
              {voices.providers.length > 1 && (
                <Field id="dv-provider" label="Provider">
                  <SelectField
                    id="dv-provider"
                    value={draft.ttsServiceId}
                    options={voices.providers.map(p => ({ value: p.serviceId, label: p.name ?? p.serviceId }))}
                    onChange={value => { edit(d => setProvider(d, value)) }}
                  />
                </Field>
              )}
              {voices.models.length > 1 && (
                <Field id="dv-model" label="Model">
                  <SelectField id="dv-model" value={draft.ttsModel} options={optionsOf(voices.models)} onChange={value => { edit(d => setModel(d, value)) }} />
                </Field>
              )}
              <Field id="dv-voice" label="Voice">
                <SelectField
                  id="dv-voice"
                  value={draft.ttsVoice}
                  options={voices.voices.map(v => ({ value: v.id, label: v.name }))}
                  onChange={value => { edit(d => setVoice(d, value)) }}
                />
              </Field>
            </div>
            <p className="dv-help">
              Only models that can stream speech in real time are listed.{' '}
              <a className="dv-link" href={doc('docs/setup/models.md#text-to-speech-models')} target="_blank" rel="noreferrer">Speech models</a>
              {' · '}
              <a className="dv-link" href={doc('docs/setup/voices-and-models.md')} target="_blank" rel="noreferrer">Voices and models</a>
            </p>
            <div className="dv-field">
              <div className="dv-split">
                <span className="dv-label">Speed</span>
                <span className="dv-value">{draft.ttsSpeed.toFixed(1)}x</span>
              </div>
              <SliderField label="Speed" min={0.5} max={2} step={0.1} value={draft.ttsSpeed} onChange={value => { edit(d => setSpeed(d, value)) }} />
            </div>
          </>
        )}
      </Section>
      <Section title="Chunking" aside={draft.scope === 'per-model' ? <span className="dv-help">Changes here apply only to {view.modelName}</span> : undefined}>
        <RadioChoices<ChunkStrategy>
          name="dv-mode"
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
        <div className="dv-pair">
          {words('minWords', 'dv-min-words', 'Min words', 200, "The shortest piece spoken on its own; shorter sentences wait to join the next. In 2-chunk, the first piece's minimum.")}
          {words('maxWords', 'dv-max-words', 'Max words', 500, "The longest piece before it's cut at a sentence or clause. Used by Sentence and Greedy.")}
        </div>
        <RadioChoices<SettingsScope>
          name="dv-scope"
          label="Applies to"
          description={
            <>
              Whether these chunking settings are shared by every speech model or kept per model.{' '}
              <a className="dv-link" href={doc('docs/setup/configuration.md#settings-scope')} target="_blank" rel="noreferrer">How per-model values are chosen</a>
            </>
          }
          value={draft.scope}
          choices={SCOPE_CHOICES}
          onChange={value => { edit(d => setScope(d, value)) }}
        />
        {view.note !== null && <p className="dv-help">{view.note}</p>}
        <div className="dv-footer">
          <Button variant="outline" size="sm" disabled={draft.scope === 'global' || !view.overridePresent} onClick={() => { edit(resetChunking) }}>
            Reset to model defaults
          </Button>
        </div>
      </Section>
      <Section>
        <Field id="dv-streaming" label="Playback method">
          <SelectField
            id="dv-streaming"
            value={streaming}
            options={[
              { value: 'auto', label: `Auto (${backendName(detected)})` },
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
          <p className="dv-help">
            How speech audio reaches the browser. Leave on Auto unless speech stutters or cuts out. Saved in this browser as soon as you change
            it, apart from Save; takes effect when you reload the page. Now using {backendName(STREAMING_BACKEND)}.
          </p>
        </Field>
      </Section>
    </>
  )
}

function ListeningPanel({ draft, edit }: PanelProps) {
  const view = roster(draft)
  return (
    <>
      {view.sttOptions.length > 0 && (
        <Section>
          <Field id="dv-stt" label="Transcription provider">
            <SelectField
              id="dv-stt"
              value={draft.sttServiceId}
              options={view.sttOptions.map(o => ({ value: o.serviceId, label: o.name }))}
              onChange={value => { edit(d => setSttService(d, value)) }}
            />
            <p className="dv-help">
              The speech-to-text server that turns what you say into text.{' '}
              <a className="dv-link" href={doc('docs/setup/stt.md')} target="_blank" rel="noreferrer">Setting up STT servers</a>
              {' · '}
              <a className="dv-link" href={doc('docs/setup/models.md#speech-to-text-models')} target="_blank" rel="noreferrer">Transcription models</a>
            </p>
          </Field>
        </Section>
      )}
      {([
        { section: 'vad', title: 'Speech detection' },
        { section: 'turnTaking', title: 'Turn taking' },
      ] as const).map(group => (
        <Section
          key={group.section}
          title={group.title}
          aside={<a className="dv-link" href={doc('docs/pages/voice-interface.md#what-the-settings-mean')} target="_blank" rel="noreferrer">What these do</a>}
        >
          {TUNING_FIELDS.filter(f => f.section === group.section).map(f => {
            const value = draft.tuning[f.key]
            return (
              <div key={f.key} className="dv-field">
                <div className="dv-tuning">
                  <Tooltip label={`stt.${f.section}.${f.key}`} side="top" portal>
                    <span className="dv-label">{f.label}</span>
                  </Tooltip>
                  <SliderField
                    label={f.label}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    value={value ?? f.default}
                    onChange={next => { edit(d => setTuning(d, f.key, next)) }}
                  />
                  <span className="dv-tuning-end">
                    {value !== undefined && <button type="button" className="dv-link dv-reset" onClick={() => { edit(d => resetTuning(d, f.key)) }}>Reset</button>}
                    <span className="dv-value">{value === undefined ? `default (${f.default}${f.unit})` : `${value}${f.unit}`}</span>
                  </span>
                </div>
                <p className="dv-help">{f.description}</p>
              </div>
            )
          })}
        </Section>
      ))}
    </>
  )
}
