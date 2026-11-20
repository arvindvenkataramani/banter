// Reads the control plane's voice config for the page, and records which
// speech services it selects. The relays serve only those services, so the ids
// come from the host's own fetch, never from the page.

import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { engineConfig, selectedServices } from './settings.ts'

export type ConfigAnswer = { status: 200; config: VoiceConfig } | { status: 404 | 502; reason: string }

export interface SelectedServices {
  sttServiceId: string
  ttsServiceId: string
}

export interface VoiceConfigSource {
  /** Fetches the config and records the services it selects. */
  load(): Promise<ConfigAnswer>
  /** Fetches the config and records nothing: the relays keep the services the page is using. */
  check(): Promise<ConfigAnswer>
  /** The services the last successful load recorded, or null before one. */
  selected(): SelectedServices | null
  /** The selection the current one replaced, or null. */
  previous(): SelectedServices | null
  /**
   * The service ids the relays serve: the latest selection's and the one before it. A page that
   * started voice on the earlier selection keeps working until it reconfigures onto the new one.
   */
  allowed(): string[]
  /** Forgets the recorded services (the URL changed); a load already in flight records nothing. */
  clear(): void
  /** Called after a load that records different services, the first one included. */
  onChange(listener: () => void): () => void
}

/** How long a fetch to Banter may take; the relays wait on it, so a hung Banter must not hang them. */
const FETCH_TIMEOUT_MS = 5000

export function createVoiceConfigSource(deps: { controlPlaneUrl: () => string; fetch: typeof globalThis.fetch }): VoiceConfigSource {
  let selected: SelectedServices | null = null
  let previous: SelectedServices | null = null
  const listeners = new Set<() => void>()
  /** Loads are numbered; one that started before the latest recorded load, or before a clear, records nothing. */
  let started = 0
  let recorded = 0
  let clearedAt = 0

  const fetchConfig = async (): Promise<{ answer: ConfigAnswer; body?: VoiceConfig }> => {
    const url = deps.controlPlaneUrl().replace(/\/+$/, '')
    if (url === '') return { answer: { status: 404, reason: 'No Banter server URL is set' } }
    let response: Response
    try {
      response = await deps.fetch(`${url}/api/voice`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch {
      return { answer: { status: 502, reason: `No answer from ${url}` } }
    }
    if (!response.ok) return { answer: { status: 502, reason: `Banter answered ${response.status}` } }
    try {
      const body = await response.json() as VoiceConfig
      return { answer: { status: 200, config: engineConfig(body) }, body }
    } catch {
      return { answer: { status: 502, reason: 'Banter answered with something other than a voice config' } }
    }
  }

  return {
    async load() {
      const id = ++started
      const { answer, body } = await fetchConfig()
      if (body === undefined || id < recorded || id <= clearedAt) return answer
      recorded = id
      const next = selectedServices(body)
      const changed = selected === null || selected.sttServiceId !== next.sttServiceId || selected.ttsServiceId !== next.ttsServiceId
      if (changed) {
        previous = selected
        selected = next
        for (const listener of [...listeners]) listener()
      }
      return answer
    },
    async check() {
      return (await fetchConfig()).answer
    },
    selected: () => selected,
    previous: () => previous,
    allowed() {
      const ids = [selected?.sttServiceId, selected?.ttsServiceId, previous?.sttServiceId, previous?.ttsServiceId]
      return [...new Set(ids.filter((id): id is string => id !== undefined && id !== ''))]
    },
    clear() {
      selected = null
      previous = null
      clearedAt = started
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
