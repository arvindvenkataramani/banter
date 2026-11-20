// The page-level voice runtime: the one VoiceSystem, the dsh session it is
// attached to, Banter's voice settings as the engine reads them, and the facts
// the controls show. It lives outside React so it outlives every slot mount.

import type { VoiceSystem } from '@platform/voice-engine/system/voice-system'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import { haltAudio } from '@platform/voice-engine/audio-halters'
import { resolveVoiceSelection, type VoiceConfig } from '@platform/voice-engine/voice-config'
import { setVoiceConfig, setVoiceSelection, publishSession } from '@platform/voice-engine/voice-session-store'
import { toggleMuteAll, useMuteStore } from '@platform/voice-engine/human/mute-store'
import { editTranscript, takeTranscript } from '@platform/voice-engine/store/transcript-store'
import { LIVE_HEARTBEAT_MS, LIVE_PATH } from '../host/relay.ts'
import { DEFAULT_SETTINGS, type PluginSettings } from '../host/settings.ts'
import type { ConfigFeed } from './config-feed.ts'
import type { DshClientContext, DshConfigForm, DshObservable } from './dsh-types.ts'
import { restoreToTranscript, type DraftMirror, type MirrorSnapshot } from './draft-mirror.ts'
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
  /** Banter's voice settings as this page last read them. */
  feed: ConfigFeed
  /** The plugin's own stored settings. */
  settings(): PluginSettings
  /** Turns voice on for a session; call it from the click that asks for it. */
  start(sessionId: string, opts?: { takeover?: boolean }): void
  stop(): void
  /** Mic mute, or the end of the mute for typing. */
  toggleMic(): void
  /**
   * The mirror of a mounted text box, so the runtime can reach it from the engine's side.
   * `resume` is the state of this attach's previous box for the session when it comes back, else null.
   */
  registerBox(sessionId: string, mirror: DraftMirror): { resume: MirrorSnapshot | null; unregister(): void }
  /** Clears the "Not sent" notice once the person sends through dsh instead. */
  clearSendNotice(): void
  dispose(): void
}

export interface RuntimeDeps {
  ctx: DshClientContext
  shown: DshObservable<ShownSession>
  form: DshConfigForm<PluginSettings>
  feed: ConfigFeed
  origin: string
}

/** The source label under which the runtime retains the session voice is attached to. */
const RETAIN_SOURCE = 'dshVoice'

export function createVoiceRuntime({ ctx, shown, form, feed, origin }: RuntimeDeps): VoiceRuntime {
  let settings: PluginSettings = DEFAULT_SETTINGS
  let attached: { sessionId: string; adapter: ReturnType<typeof createVoiceSession>; release(): void } | null = null
  const boxes = new Map<string, DraftMirror>()
  /** The attached session's box state while its composer is away (a panel is open). */
  let away: { sessionId: string; snapshot: MirrorSnapshot } | null = null
  /** The notice a failed send set, so a later send can clear that notice and no other. */
  let sendNotice: string | null = null
  const ui = createValue<VoiceUi>({ attachedSessionId: null, typing: false, notice: null })
  const patchUi = (patch: Partial<VoiceUi>): void => { ui.set({ ...ui.get(), ...patch }) }

  const services = createPluginServices({ origin, fetch: (...args) => fetch(...args) })
  const system = createVoiceSystem({
    services,
    notify: (message) => { patchUi({ notice: message }) },
  })

  const phase = (): string => useVoiceSystemStore.getState().phase
  const running = (): boolean => phase() === 'starting' || phase() === 'live'

  // The plugin's own settings: the Banter URL and keep-voice-outside.
  const syncSettings = (): void => {
    const state = form.getSnapshot()
    if (state.status !== 'ready' || state.value === undefined) return
    settings = { ...DEFAULT_SETTINGS, ...state.value }
  }
  syncSettings()
  const stopSettings = form.subscribe(syncSettings)

  // Banter's voice settings, as the feed last read them, are the engine's voice config and selection.
  let applied: VoiceConfig | null = null
  const syncConfig = (): void => {
    const config = feed.state().config
    if (config === null || config === applied) return
    // A starting system reads the store once, at a moment the runtime can't see; a config that lands
    // meanwhile waits for the start to end, then goes in by reconfiguring as any live change does.
    if (phase() === 'starting') return
    const previous = applied
    applied = config
    const selection = config.tts.selection ? resolveVoiceSelection(config, config.tts.selection) : null
    const changed = previous !== null && (
      previous.tts.selection?.serviceId !== config.tts.selection?.serviceId
      || previous.tts.selection?.model !== config.tts.selection?.model
      || previous.stt?.serviceId !== config.stt?.serviceId)
    // Reconfiguring reads the config it replaces to see whether the STT service changed, so it runs before the store is updated.
    if (phase() === 'live' && changed && selection) system.reconfigure(selection, config.stt?.serviceId || undefined)
    setVoiceConfig(config)
    setVoiceSelection(selection)
  }
  syncConfig()
  const stopConfig = feed.subscribe(syncConfig)
  const stopConfigAfterStart = useVoiceSystemStore.subscribe((state, prev) => {
    if (prev.phase === 'starting' && state.phase !== 'starting') syncConfig()
  })
  const reload = (): void => { void feed.reload() }
  const onFocus = (): void => { reload() }
  const onVisibility = (): void => { if (document.visibilityState === 'visible') reload() }
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)
  reload()

  const detach = (): void => {
    if (attached === null) return
    const { adapter, release } = attached
    attached = null
    away = null
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
      // The words go back into the box, or into the transcript when no box is mounted, and the voice button says why they were not sent.
      // The transcript is the attached session's draft, so a send that failed after voice moved to another session drops its words.
      sendFailed: (text, message) => {
        if (attached?.sessionId === sessionId) {
          const box = boxes.get(sessionId)
          if (box) box.restore(text)
          else restoreToTranscript({ editTranscript, takeTranscript }, text)
        }
        sendNotice = `Not sent: ${message}`
        patchUi({ notice: sendNotice })
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
    feed,
    settings: () => settings,
    start(sessionId, opts) {
      if (running()) return
      if (feed.state().config === null) {
        const url = settings.controlPlaneUrl
        patchUi({ notice: url === '' ? 'No Banter server URL is set' : `Can't reach Banter at ${url}` })
        reload()
        return
      }
      patchUi({ notice: null })
      // voiceOn runs synchronously up to the microphone request, inside the click; the session is
      // attached before the start reads it, which happens after the first await. The reload is not
      // awaited: a changed selection reaches the system through the reconfigure in syncConfig.
      system.voiceOn(opts)
      attachTo(sessionId)
      reload()
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
      const resume = away?.sessionId === sessionId ? away.snapshot : null
      away = null
      return {
        resume,
        unregister: () => {
          if (boxes.get(sessionId) === mirror) boxes.delete(sessionId)
          // A box that goes while voice stays on this session comes back to the same attach.
          if (attached?.sessionId === sessionId) away = { sessionId, snapshot: mirror.snapshot() }
          patchUi({ typing: false })
        },
      }
    },
    clearSendNotice() {
      if (sendNotice !== null && ui.get().notice === sendNotice) patchUi({ notice: null })
    },
    dispose() {
      stopSettings()
      stopConfig()
      stopConfigAfterStart()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
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
