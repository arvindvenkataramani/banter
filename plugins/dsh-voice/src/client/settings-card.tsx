// The plugin's section of dsh's bundle config card. Each field saves through
// dsh's settings document when it is committed.

import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { DshConfigForm } from './dsh-types.ts'
import type { PluginSettings } from '../host/settings.ts'

export type CardFields = Omit<PluginSettings, 'rest'>

const TEXT_FIELDS: Array<[Exclude<keyof CardFields, 'ttsSpeed' | 'keepVoiceOutside'>, string]> = [
  ['controlPlaneUrl', 'Control plane URL'],
  ['sttServiceId', 'STT service'],
  ['sttModel', 'STT model'],
  ['ttsServiceId', 'TTS service'],
  ['ttsModel', 'TTS model'],
  ['ttsVoice', 'TTS voice'],
]

export function SettingsCard({ form }: { form: DshConfigForm<PluginSettings> }) {
  // dsh's forms are class instances whose methods read `this`, so they are called through the form.
  const state = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const value = state.value
  if (state.status !== 'ready' || value === undefined) return <p data-dsh-voice="settings-status">{state.status}</p>
  const disabled = !state.writable
  return (
    <div data-dsh-voice="settings">
      {TEXT_FIELDS.map(([field, label]) => (
        <Field key={field} label={label}>
          <Text value={value[field]} disabled={disabled} field={field} onCommit={next => form.set(field, next)} />
        </Field>
      ))}
      <Field label="TTS speed">
        <Text value={String(value.ttsSpeed)} disabled={disabled} field="ttsSpeed" onCommit={next => form.set('ttsSpeed', Number(next))} />
      </Field>
      <Field label="Keep voice on outside a conversation">
        <input
          type="checkbox"
          data-dsh-field="keepVoiceOutside"
          checked={value.keepVoiceOutside}
          disabled={disabled}
          onChange={event => { void form.set('keepVoiceOutside', event.target.checked) }}
        />
      </Field>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: 'block', margin: '8px 0' }}><span style={{ display: 'block' }}>{label}</span>{children}</label>
}

/** A text input that holds its draft locally and commits on blur or Enter. */
function Text({ value, field, disabled, onCommit }: { value: string; field: string; disabled: boolean; onCommit(next: string): unknown }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft !== null && draft !== value) void onCommit(draft)
    setDraft(null)
  }
  return (
    <input
      data-dsh-field={field}
      value={draft ?? value}
      disabled={disabled}
      onChange={event => { setDraft(event.target.value) }}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') commit() }}
    />
  )
}
