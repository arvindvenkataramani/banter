// The page-level voice runtime: the one VoiceSystem, the dsh session it is
// attached to, the plugin's settings as the engine reads them, and the facts
// the controls show. It lives outside React so it outlives every slot mount.

import type { VoiceSystem } from '@platform/voice-engine/system/voice-system'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import { haltAudio } from '@platform/voice-engine/audio-halters'
import { resolveVoiceSelection } from '@platform/voice-engine/voice-config'
import { setVoiceConfig, setVoiceSelection, publishSession } from '@platform/voice-engine/voice-session-store'
import { toggleMuteAll, useMuteStore } from '@platform/voice-engine/human/mute-store'
import { LIVE_HEARTBEAT_MS, LIVE_PATH } from '../host/relay.ts'
import { DEFAULT_SETTINGS, voiceConfigFromSettings, type PluginSettings } from '../host/settings.ts'
import type { DshClientContext, DshConfigForm, DshObservable } from './dsh-types.ts'
import type { DraftMirror } from './draft-mirror.ts'
import { createValue, type Value } from './observable.ts'
import { followShownSession } from './presence.ts'
import { createPluginServices, type PluginServices } from './services.ts'
import { createVoiceSession, type VoiceSessionDeps } from './session-adapter.ts'
import type { ShownSession } from './shown-session.ts'
import { createVoiceSystem } from './system.ts'

/** What the controls show beyond the system's own state. */
export interface VoiceUi {
  /** The session voice is attached to. */
  attachedSessionId: string | null
  /** The mic is muted while the person types in dsh's text box. */
  typing: boolean
  /** The latest message the system asked to show. */
  notice: string | null
}

export interface VoiceRuntime {
  system: VoiceSystem
  services: PluginServices
  ui: Value<VoiceUi>
  settings(): PluginSettings
  /** Turns voice on for a session; call it from the click that asks for it. */
  start(sessionId: string, opts?: { takeover?: boolean }): void
  stop(): void
  /** Mic mute, or the end of the mute for typing. */
  toggleMic(): void
  /** The mirror of a mounted text box, so the runtime can reach it from the engine's side. */
  registerBox(sessionId: string, mirror: DraftMirror): () => void
  dispose(): void
}

export interface RuntimeDeps {
  ctx: DshClientContext
  shown: DshObservable<ShownSession>
  form: DshConfigForm<PluginSettings>
  origin: string
}

/** The source label under which the runtime retains the session voice is attached to. */
const RETAIN_SOURCE = 'dshVoice'

export function createVoiceRuntime({ ctx, shown, form, origin }: RuntimeDeps): VoiceRuntime {
  let settings: PluginSettings = DEFAULT_SETTINGS
  let attached: { sessionId: string; adapter: ReturnType<typeof createVoiceSession>; release(): void } | null = null
  const boxes = new Map<string, DraftMirror>()
  const ui = createValue<VoiceUi>({ attachedSessionId: null, typing: false, notice: null })
  const patchUi = (patch: Partial<VoiceUi>): void => { ui.set({ ...ui.get(), ...patch }) }

  const services = createPluginServices({ origin, fetch: (...args) => fetch(...args) })
  const system = createVoiceSystem({
    services,
    notify: (message) => { patchUi({ notice: message }) },
  })

  const phase = (): string => useVoiceSystemStore.getState().phase
  const running = (): boolean => phase() === 'starting' || phase() === 'live'

  // The plugin's settings are the engine's voice config and selection.
  const syncSettings = (): void => {
    const state = form.getSnapshot()
    if (state.status !== 'ready' || state.value === undefined) return
    const previous = settings
    settings = { ...DEFAULT_SETTINGS, ...state.value }
    const config = voiceConfigFromSettings(settings)
    const selection = config.tts.selection ? resolveVoiceSelection(config, config.tts.selection) : null
    const providerChanged = previous.ttsServiceId !== settings.ttsServiceId || previous.ttsModel !== settings.ttsModel
      || previous.sttServiceId !== settings.sttServiceId
    // Reconfiguring reads the config it replaces to see whether the STT service changed.
    if (phase() === 'live' && providerChanged && selection) system.reconfigure(selection, settings.sttServiceId || undefined)
    setVoiceConfig(config)
    setVoiceSelection(selection)
  }
  syncSettings()
  const stopSettings = form.subscribe(syncSettings)

  const detach = (): void => {
    if (attached === null) return
    const { adapter, release } = attached
    attached = null
    adapter.dispose()
    release()
    publishSession(null)
    patchUi({ attachedSessionId: null, typing: false })
  }

  const attachTo = (sessionId: string): void => {
    detach()
    const reference = ctx.sessions.retain(sessionId, { source: RETAIN_SOURCE })
    const { session, eventSource } = reference.binding
    const deps: VoiceSessionDeps = {
      haltAudio,
      clearDraft: () => {
        boxes.get(sessionId)?.clear()
        patchUi({ notice: null })
      },
      // The words go back into the box and the voice button says why they were not sent.
      sendFailed: (text, message) => {
        boxes.get(sessionId)?.restore(text)
        patchUi({ notice: `Not sent: ${message}` })
      },
    }
    const adapter = createVoiceSession({
      sessionId,
      prompt: (content, mode) => session.prompt(content, mode),
      cancel: () => session.cancel(),
      eventSource,
    }, deps)
    attached = { sessionId, adapter, release: () => { reference.release() } }
    publishSession(adapter)
    patchUi({ attachedSessionId: sessionId })
  }

  // The session is released when voice ends, whichever way it ends.
  const stopSystemWatch = useVoiceSystemStore.subscribe((state) => {
    if (state.phase === 'ending' || state.phase === 'off') detach()
  })

  const stopFollowing = followShownSession({
    shown,
    keepOnOutside: () => settings.keepVoiceOutside,
    isLive: running,
    attach: attachTo,
    voiceOff: () => { system.voiceOff() },
  })

  // The host adds the voice guidance to the prompt of a session that has voice live.
  let reported: string | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const post = (sessionId: string, live: boolean): void => {
    // keepalive lets the report outlive a page that is closing.
    void fetch(`${origin}${LIVE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, live }),
      keepalive: true,
    }).catch(() => { /* the guidance is lost for this session; voice itself is unaffected */ })
  }
  const endReport = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat)
    heartbeat = null
    if (reported !== null) post(reported, false)
    reported = null
  }
  const reportLive = (): void => {
    const next = phase() === 'live' ? ui.get().attachedSessionId : null
    if (next === reported) return
    endReport()
    reported = next
    if (next === null) return
    post(next, true)
    // The host lets a report lapse, so a page that dies without ending it does not keep the guidance on.
    heartbeat = setInterval(() => { post(next, true) }, LIVE_HEARTBEAT_MS)
  }
  const stopReportingPhase = useVoiceSystemStore.subscribe(reportLive)
  const stopReportingUi = ui.subscribe(reportLive)
  // A page that is going away ends its report; one restored from the back-forward cache reports again.
  const onPageHide = (): void => { endReport() }
  const onPageShow = (event: PageTransitionEvent): void => { if (event.persisted) reportLive() }
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)

  return {
    system,
    services,
    ui,
    settings: () => settings,
    start(sessionId, opts) {
      if (running()) return
      patchUi({ notice: null })
      // voiceOn runs synchronously up to the microphone request, inside the click; the session is
      // attached before the start reads it, which happens after the first await.
      system.voiceOn(opts)
      attachTo(sessionId)
    },
    stop() {
      system.voiceOff()
    },
    toggleMic() {
      const box = attached === null ? undefined : boxes.get(attached.sessionId)
      if (ui.get().typing && box !== undefined) {
        box.onUnmute()
        if (!useMuteStore.getState().micMuted) return
      }
      toggleMuteAll()
    },
    registerBox(sessionId, mirror) {
      boxes.set(sessionId, mirror)
      return () => {
        if (boxes.get(sessionId) === mirror) boxes.delete(sessionId)
        patchUi({ typing: false })
      }
    },
    dispose() {
      stopSettings()
      stopSystemWatch()
      stopFollowing()
      stopReportingPhase()
      stopReportingUi()
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      endReport()
      detach()
    },
  }
}
