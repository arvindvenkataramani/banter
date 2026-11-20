// The voice config in use on this page, read from Banter through the host
// half. A reload puts what it reads in use; a check only reports whether
// Banter answers.

import type { VoiceConfig } from '@platform/voice-engine/voice-config'
import { CONFIG_CHECK_PATH, CONFIG_PATH } from '../host/relay.ts'

export interface FeedState {
  /** The config in use; null until a reload has succeeded. */
  config: VoiceConfig | null
  /** When the config in use was loaded, in ms since the epoch. */
  loadedAt: number | null
  /** Why the last reload failed, or null when it succeeded. */
  error: string | null
}

export type CheckResult = { ok: true } | { ok: false; reason: string }

export interface ConfigFeed {
  reload(): Promise<void>
  check(): Promise<CheckResult>
  state(): FeedState
  subscribe(listener: () => void): () => void
}

type Answer = { ok: true; config: VoiceConfig } | { ok: false; reason: string }

export function createConfigFeed(deps: { origin: string; fetch: typeof globalThis.fetch; now: () => number }): ConfigFeed {
  let state: FeedState = { config: null, loadedAt: null, error: null }
  const listeners = new Set<() => void>()
  /** Numbers each reload; a result is applied only when no later reload has landed. */
  let started = 0
  let landed = 0

  const set = (next: FeedState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }

  const ask = async (path: string): Promise<Answer> => {
    let response: Response
    try {
      // The host gives up on Banter after 5 s; this bounds the page's wait on the host.
      response = await deps.fetch(`${deps.origin}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    } catch {
      return { ok: false, reason: 'No answer from dsh' }
    }
    try {
      const body = await response.json() as unknown
      if (response.ok) return { ok: true, config: body as VoiceConfig }
      const reason = (body as { reason?: unknown } | null)?.reason
      return { ok: false, reason: typeof reason === 'string' ? reason : `dsh answered ${response.status}` }
    } catch {
      return { ok: false, reason: `dsh answered ${response.status}` }
    }
  }

  return {
    async reload() {
      const id = ++started
      const answer = await ask(CONFIG_PATH)
      if (id < landed) return
      landed = id
      set(answer.ok
        ? { config: answer.config, loadedAt: deps.now(), error: null }
        : { ...state, error: answer.reason })
    },
    async check() {
      const answer = await ask(CONFIG_CHECK_PATH)
      return answer.ok ? { ok: true } : { ok: false, reason: answer.reason }
    },
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
