// The plugin's page in dsh's plugin manager (the `plugins.bundle.config` slot).
// It holds only the plugin's own settings, each saving itself; the voice
// settings are Banter's, shown here read-only as this page last read them.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Input, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { STREAMING_BACKEND, getDetectedBackend, saveStreamingBackend } from '@platform/voice-engine/system/streaming-backend'
import type { StreamingBackend } from '@platform/voice-engine/system/streaming-backend'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import { describeSttInUse } from '@platform/voice-engine/stt-mode-text'
import { DEFAULT_SETTINGS, type PluginSettings } from '../host/settings.ts'
import type { DshConfigForm } from './dsh-types.ts'
import type { VoiceRuntime } from './runtime.ts'
import { normaliseServerUrl } from './server-url.ts'
import { checkService } from './services.ts'
import { SelectField } from './settings-controls.tsx'
import { voiceSummary } from './voice-summary.ts'
import { ReadOnly, SCOPE, ensureStyles } from './settings-style.ts'

type Field = keyof PluginSettings
/** What the last write of a field did, shown beside it. */
type WriteNote = { field: Field; ok: true } | { field: Field; ok: false; reason: string }

export function SettingsCard({ form, runtime, origin }: { form: DshConfigForm<PluginSettings>; runtime: VoiceRuntime; origin: string }) {
  ensureStyles()
  // dsh's forms are class instances whose methods read `this`, so they are called through the form.
  const state = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const stored: PluginSettings = { ...DEFAULT_SETTINGS, ...(state.value ?? {}) }
  const readOnly = state.status === 'ready' && !state.writable
  const [note, setNote] = useState<WriteNote | null>(null)
  const [checkRun, setCheckRun] = useState(0)

  const write = useCallback(async (field: Field, value: PluginSettings[Field]): Promise<boolean> => {
    setNote(null)
    try {
      const ok = await form.mutate([{ op: 'set', path: [field], value }], form.getSnapshot().revision)
      setNote(ok ? { field, ok: true } : { field, ok: false, reason: 'dsh did not accept it; the stored value stands' })
      return ok
    } catch (error) {
      setNote({ field, ok: false, reason: `Not saved: ${error instanceof Error ? error.message : String(error)}` })
      return false
    }
  }, [form])

  // "Saved" shows briefly; a problem stays until the next write.
  useEffect(() => {
    if (note?.ok !== true) return
    const timer = setTimeout(() => { setNote(current => (current === note ? null : current)) }, 2500)
    return () => { clearTimeout(timer) }
  }, [note])

  if (state.status !== 'ready') return <p data-dsh-voice="settings-status">{state.status}</p>

  const noteFor = (field: Field): ReactNode => note?.field !== field
    ? null
    : note.ok ? <span className="dv-saved" role="status">Saved</span> : <p className="dv-problem" role="alert">{note.reason}</p>

  return (
    <div className={`${SCOPE} dv-page`} data-dsh-voice="settings">
      <ReadOnly.Provider value={readOnly}>
        {readOnly && <p className="dv-problem" role="status">dsh has made these settings read-only here; the checks and the playback method still work.</p>}
        <ServerSection
          stored={stored.controlPlaneUrl}
          readOnly={readOnly}
          note={noteFor('controlPlaneUrl')}
          onSave={async url => {
            const ok = await write('controlPlaneUrl', url)
            if (!ok) return false
            // A new Banter has its own voice settings: read them, then check its services.
            await runtime.feed.reload()
            setCheckRun(n => n + 1)
            return true
          }}
        />
        <StatusSection runtime={runtime} origin={origin} url={stored.controlPlaneUrl} checkRun={checkRun} onTest={() => { setCheckRun(n => n + 1) }} />
        <VoiceSettingsSection runtime={runtime} url={stored.controlPlaneUrl} />
        <section className="dv-section" aria-labelledby="dv-dsh-heading">
          <h3 className="dv-heading" id="dv-dsh-heading">In dsh</h3>
          <div className="dv-split dv-split-top">
            <div className="dv-field">
              <span className="dv-label">Keep voice on outside a conversation</span>
              <p className="dv-help">Voice keeps running when you leave a conversation for another dsh page, instead of turning off.</p>
              {noteFor('keepVoiceOutside')}
            </div>
            <Switch
              label="Keep voice on outside a conversation"
              checked={stored.keepVoiceOutside}
              disabled={readOnly}
              onChange={checked => { void write('keepVoiceOutside', checked) }}
            />
          </div>
          <PlaybackField />
          <div className="dv-field">
            <span className="dv-label">Mute shortcut</span>
            <p className="dv-help">
              Muting the microphone has no key by default, so it can't clash with your system&apos;s or keyboard layout&apos;s shortcuts. Bind one in
              dsh&apos;s keyboard shortcuts settings: search for &ldquo;voice mute&rdquo;.
            </p>
          </div>
        </section>
      </ReadOnly.Provider>
    </div>
  )
}

// ── Banter server ────────────────────────────────────────────────────────

function ServerSection({ stored, readOnly, note, onSave }: { stored: string; readOnly: boolean; note: ReactNode; onSave: (url: string) => Promise<boolean> }) {
  const [text, setText] = useState(stored)
  const [problem, setProblem] = useState<string | null>(null)
  // A stored value that changes elsewhere replaces the field's text unless the person is editing it.
  const [editing, setEditing] = useState(false)
  // The value a write is out for, so Enter followed by a blur writes once.
  const pending = useRef<string | null>(null)
  const [shownStored, setShownStored] = useState(stored)
  if (stored !== shownStored) {
    setShownStored(stored)
    if (!editing) setText(stored)
  }

  const commit = async (): Promise<void> => {
    setEditing(false)
    const result = normaliseServerUrl(text)
    if (!result.ok) {
      setProblem(result.problem)
      return
    }
    setProblem(null)
    setText(result.url)
    if (result.url === stored || result.url === pending.current) return
    pending.current = result.url
    const ok = await onSave(result.url)
    pending.current = null
    // A refused write puts the stored value back, so the field never shows what was not saved.
    if (!ok) setText(stored)
  }

  return (
    <section className="dv-section" aria-labelledby="dv-server-heading">
      <h3 className="dv-heading" id="dv-server-heading">Banter server</h3>
      <div className="dv-field">
        <label htmlFor="dv-control-plane" className="dv-label">Banter server URL</label>
        <Input
          id="dv-control-plane"
          className="dv-input"
          value={text}
          disabled={readOnly}
          placeholder="http://banter.example:7000"
          aria-invalid={problem !== null}
          aria-describedby="dv-control-plane-help"
          onChange={event => { setEditing(true); setText(event.target.value) }}
          onBlur={() => { void commit() }}
          onKeyDown={event => {
            if (event.key === 'Enter') void commit()
            if (event.key === 'Escape') {
              setEditing(false)
              setText(stored)
              setProblem(null)
            }
          }}
        />
        {problem !== null && <p className="dv-problem" role="alert">{problem}</p>}
        {note}
        <p className="dv-help" id="dv-control-plane-help">
          The address you open Banter at; the install script prints it.
        </p>
      </div>
    </section>
  )
}

// ── Service status ───────────────────────────────────────────────────────

type Tone = 'success' | 'danger' | 'warning' | 'neutral' | 'quiet'
/** `name` follows the badge on its line (the service a row is about); `detail` sits under it. */
interface Row { label: string; tag: string; tone: Tone; name?: string; detail?: ReactNode }

const checking = (label: string): Row => ({ label, tag: 'Checking…', tone: 'quiet' })

type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown'

/** The browser's microphone permission; 'unknown' when the page can't ask, or the answer doesn't come within 2 s. */
async function micPermission(): Promise<MicPermission> {
  const query = navigator.permissions.query({ name: 'microphone' as PermissionName }).then(status => status.state, (): MicPermission => 'unknown')
  const timeout = new Promise<MicPermission>(resolve => { setTimeout(() => { resolve('unknown') }, 2000) })
  return Promise.race([query, timeout])
}

/** Banter's page security notice, for dsh's page: the microphone needs a secure page, and the voice models need an isolated one to use more than one thread. */
function pageRow(): Row {
  if (!self.isSecureContext) {
    return { label: 'This page', tag: 'No microphone', tone: 'danger', detail: 'Browsers allow the microphone only on a secure page; open dsh over https or at localhost.' }
  }
  if (!self.crossOriginIsolated) {
    return { label: 'This page', tag: 'One thread', tone: 'warning', detail: "dsh's page isn't cross-origin isolated, so turn detection runs on one thread and responds more slowly." }
  }
  return { label: 'This page', tag: 'Ready', tone: 'success' }
}

function StatusSection({ runtime, origin, url, checkRun, onTest }: { runtime: VoiceRuntime; origin: string; url: string; checkRun: number; onTest: () => void }) {
  // Each run's results carry the run they answer; until the latest run's arrive, its rows read "Checking…".
  const [result, setResult] = useState<{ run: number; banter: Row; services: Row[] } | null>(null)
  const [mic, setMic] = useState<MicPermission | 'asking'>('unknown')
  const running = result?.run !== checkRun
  const banter = running || result === null ? checking('Banter') : result.banter
  const services = running || result === null ? [checking('Transcription service'), checking('Speech service')] : result.services

  useEffect(() => {
    let current = true
    void (async () => {
      const answer = await runtime.feed.check()
      if (!current) return
      const banterRow: Row = answer.ok
        ? { label: 'Banter', tag: 'Connected', tone: 'success' }
        : { label: 'Banter', tag: "Can't reach Banter", tone: 'danger', detail: answer.reason }
      const config = runtime.feed.state().config
      const sttId = config?.stt?.serviceId ?? ''
      const ttsId = config?.tts.selection?.serviceId ?? ''
      const ids: Array<[string, string, string]> = [
        ['Transcription service', sttId, config?.stt?.options?.find(o => o.serviceId === sttId)?.name ?? sttId],
        ['Speech service', ttsId, config?.tts.providers.find(p => p.serviceId === ttsId)?.name ?? ttsId],
      ]
      const rows = await Promise.all(ids.map(async ([label, id, name]): Promise<Row> => {
        if (id === '') return { label, tag: 'Not chosen', tone: 'neutral', detail: answer.ok ? 'Choose one in Banter’s voice settings.' : 'Shown once Banter answers.' }
        const health = await checkService({ origin, fetch: (...args) => fetch(...args) }, id)
        if (health.healthy) return { label, tag: 'Running', tone: 'success', name }
        if (health.detail === 'unreachable' || health.detail.startsWith('answered')) {
          return { label, tag: 'Unreachable', tone: 'danger', name, detail: `${health.detail}. Check it in Banter’s Services page.` }
        }
        return { label, tag: 'Not running', tone: 'neutral', name, detail: 'Voice starts it when needed.' }
      }))
      if (!current) return
      setResult({ run: checkRun, banter: banterRow, services: rows })
      // Asked after the rows land, so a slow permission answer never holds them at "Checking…".
      const permission = await micPermission()
      if (current) setMic(permission)
    })()
    return () => { current = false }
  }, [runtime, origin, url, checkRun])

  const allowMicrophone = (): void => {
    setMic('asking')
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      stream => {
        for (const track of stream.getTracks()) track.stop()
        void micPermission().then(setMic)
      },
      () => { void micPermission().then(state => { setMic(state === 'prompt' ? 'denied' : state) }) },
    )
  }

  const micRow: Row = mic === 'granted'
    ? { label: 'Microphone', tag: 'Allowed', tone: 'success' }
    : mic === 'denied'
      ? { label: 'Microphone', tag: 'Blocked', tone: 'danger', detail: 'Allow it for this site in the browser’s site settings (the icon at the left of the address bar), then test again.' }
      : mic === 'asking'
        ? checking('Microphone')
        : { label: 'Microphone', tag: mic === 'prompt' ? 'Not asked yet' : 'Unknown', tone: 'neutral', detail: <Button variant="outline" size="sm" onClick={allowMicrophone}>Allow microphone</Button> }

  const rows = [banter, ...services, micRow, pageRow()]
  return (
    <section className="dv-section" aria-labelledby="dv-status-heading">
      <div className="dv-split">
        <h3 className="dv-heading" id="dv-status-heading">Service status</h3>
        <Button variant="outline" size="sm" disabled={running} onClick={onTest}>{running ? 'Testing…' : 'Test connection'}</Button>
      </div>
      <dl className="dv-table" aria-live="polite">
        {rows.map(row => (
          <StatusRow key={row.label} row={row} />
        ))}
      </dl>
    </section>
  )
}

function StatusRow({ row }: { row: Row }) {
  return (
    <>
      <dt>{row.label}</dt>
      <dd>
        <span className="dv-state"><Tag tone={row.tone}>{row.tag}</Tag>{row.name !== undefined && <span>{row.name}</span>}</span>
        {row.detail !== undefined && (typeof row.detail === 'string' ? <p className="dv-help">{row.detail}</p> : <div>{row.detail}</div>)}
      </dd>
    </>
  )
}

// ── Voice settings ───────────────────────────────────────────────────────

function VoiceSettingsSection({ runtime, url }: { runtime: VoiceRuntime; url: string }) {
  const feed = useSyncExternalStore(listener => runtime.feed.subscribe(listener), () => runtime.feed.state())
  // How voice is transcribing right now; set only while voice is on.
  const inUse = useSyncExternalStore(listener => useVoiceSystemStore.subscribe(listener), () => useVoiceSystemStore.getState().stt)
  const [reloading, setReloading] = useState(false)
  const reload = (): void => {
    setReloading(true)
    void runtime.feed.reload().finally(() => { setReloading(false) })
  }
  const link = url === '' ? undefined : `${url}/?settings`
  return (
    <section className="dv-section" aria-labelledby="dv-voice-heading">
      <h3 className="dv-heading" id="dv-voice-heading">Voice settings</h3>
      <p className="dv-help">
        Your voice, transcription, chunking, listening and take-over settings are Banter&apos;s. Change them in Banter; they apply to every place you use voice.
      </p>
      {feed.config === null
        ? <p className="dv-help">Not loaded yet{feed.error === null ? '.' : `: ${feed.error}.`}</p>
        : (
          <dl className="dv-table">
            {voiceSummary(feed.config).map(({ label, value, problem }) => (
              <div key={label} className="dv-contents">
                <dt>{label}</dt>
                <dd>
                  <span>{value}</span>
                  {problem !== undefined && <p className="dv-problem" role="alert">{problem}</p>}
                  {label === 'Transcription' && inUse !== null && <p className="dv-help" role="status">{describeSttInUse(inUse)}</p>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      <div className="dv-actions">
        <Button variant="outline" size="sm" disabled={reloading} onClick={reload}>{reloading ? 'Reloading…' : 'Reload voice settings'}</Button>
        <a className="dv-link" href={link} target="_blank" rel="noreferrer" aria-disabled={link === undefined}>
          Open voice settings in Banter <span aria-hidden="true">↗</span><span className="dv-sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      <p className="dv-help" role="status">
        {feed.error !== null && feed.config !== null
          ? `Reload failed: ${feed.error}. Still using the settings loaded at ${new Date(feed.loadedAt ?? 0).toLocaleTimeString()}.`
          : feed.loadedAt !== null ? `Loaded at ${new Date(feed.loadedAt).toLocaleTimeString()}. Reloads by itself when you come back to this page and when voice starts.` : null}
      </p>
    </section>
  )
}

// ── Playback ─────────────────────────────────────────────────────────────

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

function PlaybackField() {
  const [streaming, setStreaming] = useState<StreamingBackend | 'auto'>(readStreamingChoice)
  return (
    <div className="dv-field">
      <label htmlFor="dv-streaming" className="dv-label">Playback method</label>
      <SelectField
        id="dv-streaming"
        value={streaming}
        alwaysEnabled
        options={[
          { value: 'auto', label: `Auto (${backendName(getDetectedBackend())})` },
          { value: 'mms', label: 'MMS streaming', disabled: typeof ManagedMediaSource === 'undefined' },
          { value: 'mse', label: 'MSE streaming', disabled: typeof MediaSource === 'undefined' },
          { value: 'blob', label: 'Blob fallback' },
        ]}
        // Kept in this browser's storage, where the engine reads it when it loads.
        onChange={value => {
          const choice = value as StreamingBackend | 'auto'
          setStreaming(choice)
          saveStreamingBackend(choice)
        }}
      />
      <p className="dv-help">
        How speech audio reaches this browser. Leave on Auto unless speech stutters or cuts out. Saved in this browser as soon as you change it;
        takes effect when you reload the page. Now using {backendName(STREAMING_BACKEND)}.
      </p>
    </div>
  )
}

