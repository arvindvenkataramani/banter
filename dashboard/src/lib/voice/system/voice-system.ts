// Design: docs/design/voice-system.md
//
// The system: the third actor the voice floor names, alongside the human and
// agent sides. It owns the phase, the session id, the session's services and
// heartbeat, the two sides, the transcription connection and its reconnect
// policy, the session's tones, the voice player, and the last ending. What
// outlives a session — config, the selection, the gateway session, the
// service endpoints — stays in the session store; the devices and the turn
// manager are called and not owned.

import { create } from 'zustand'
import type { UseBoundStore, StoreApi } from 'zustand'
import {
  report,
  resetTurnManager,
  configureTurnManager,
  attachSession,
  detachSession,
} from '../store/turn-manager-store'
import { useMuteStore, resetMutes } from '../human/mute-store'
import { configureReveal } from '../store/transcript-store'
import {
  useVoiceSessionStore,
  setSttEndpoint,
  resolveSttMode,
  resolveChunkMs,
} from '../voice-session-store'
import type { SttModelFacts } from '../voice-session-store'
import { resolveChunkingFor } from '../agent/chunking-setting'
import type { VoiceConfig, VoiceSelection, ChunkStrategy } from '../voice-config'
import type { SttTransport } from '../human/stt-transport'
import type { SileroVad } from '../human/silero-vad'
import type { SmartTurn } from '../human/smart-turn'
import type { Session } from '../../session'
import type { SpeechPlayer, TonePlayer } from './playback-engine'

export type VoicePhase = 'off' | 'starting' | 'live' | 'ending'
export type EndReason = 'user' | 'start-failed' | 'connection-lost' | 'superseded' | 'held' | 'media'

export interface VoiceSystemState {
  phase: VoicePhase
  sessionId: string | null
  /** A saved provider change is readying its service and model. */
  reconfiguring: boolean
  lastEnd: { reason: EndReason; message?: string } | null
}

export interface HumanSide {
  readonly loop: { voiceConfig: VoiceConfig | null }
  transport: SttTransport | null
  start(): void
  stop(): Promise<void>
  replaceTransport(t: SttTransport): boolean
  receivePartial(text: string): void
}

export interface AgentSide {
  chunkConfig: { chunkStrategy: ChunkStrategy; minChunkWords: number | undefined; maxChunkWords: number | undefined }
  ttsEndpoint: string | null
  ttsSelection: VoiceSelection | null
  attach(session: Session): void
  detach(): void
}

/** The one player, for the page's lifetime: what the agent side plays speech
 * through and the tone queue plays tones through, plus the lifecycle calls
 * that belong to the system alone — nothing else calls init/reset/release. */
export interface VoicePlayer extends SpeechPlayer, TonePlayer {
  init(): void
  reset(): void
  release(): void
  setConcurrency(n: number | undefined): void
}

export interface VoiceSystemDeps {
  devices: { acquire(): Promise<boolean>; release(): void }
  tones: { play(name: 'attempted' | 'started' | 'ended'): Promise<void> }
  player: VoicePlayer
  services: {
    ensureTtsReady(serviceId: string): Promise<string>
    ensureServiceReady(serviceId: string): Promise<string>
    loadTtsModel(endpoint: string, modelKey: string): Promise<void>
    loadSttModel(endpoint: string, model: string, mode: 'batch' | 'streaming', chunkMs?: number): Promise<void>
    fetchSttModelFacts(endpoint: string, model: string): Promise<SttModelFacts>
    ping(serviceId: string): Promise<unknown>
  }
  loadModels(): Promise<{ vad: SileroVad; smartTurn: SmartTurn }>
  createTransport(opts: {
    endpoint: string
    serviceId?: string
    model?: string
    mode: 'batch' | 'streaming' | null
    sessionId?: string
    takeover?: boolean
    onPartial: (text: string) => void
    onReady: () => void
    onClosed: (reason: string, info: { dropped: number; code: string | null }) => void
  }): Promise<SttTransport>
  createHuman(vad: SileroVad, smartTurn: SmartTurn, cb: { onError: (msg: string) => void }): HumanSide
  createAgent(player: SpeechPlayer): AgentSide
  notify(message: string, persistent?: boolean): void
  now(): number
  newSessionId(): string
}

export const useVoiceSystemStore: UseBoundStore<StoreApi<VoiceSystemState>> = create<VoiceSystemState>(() => ({
  phase: 'off',
  sessionId: null,
  reconfiguring: false,
  lastEnd: null,
}))

const PING_INTERVAL_MS = 60_000

function modeFor(phase: VoicePhase, micMuted: boolean): 'off' | 'starting' | 'live' | 'muted' | 'ending' {
  if (phase === 'starting') return 'starting'
  if (phase === 'live') return micMuted ? 'muted' : 'live'
  if (phase === 'ending') return 'ending'
  return 'off'
}

export class VoiceSystem {
  private deps: VoiceSystemDeps
  private human: HumanSide | null = null
  private agent: AgentSide | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private startedAt = 0

  constructor(deps: VoiceSystemDeps) {
    this.deps = deps
    useMuteStore.subscribe((state, prev) => {
      if (state.micMuted === prev.micMuted) return
      if (useVoiceSystemStore.getState().phase !== 'live') return
      this.reportMode()
    })
    useVoiceSessionStore.subscribe((state, prev) => {
      if (!this.human && !this.agent) return
      if (state.voiceConfig !== prev.voiceConfig) {
        if (this.human) this.human.loop.voiceConfig = state.voiceConfig
        if (this.agent) {
          const chunking = resolveChunkingFor(state.voiceConfig, state.voiceSelection)
          this.agent.chunkConfig = {
            chunkStrategy: chunking.strategy,
            minChunkWords: chunking.minWords,
            maxChunkWords: chunking.maxWords,
          }
          this.deps.player.setConcurrency(chunking.concurrency)
        }
        if (state.voiceConfig?.stt?.turnTaking?.interruptionMinRemainingS !== undefined) {
          configureTurnManager({ interruptionMinRemainingS: state.voiceConfig.stt.turnTaking.interruptionMinRemainingS })
        }
        configureReveal({
          minIntervalMs: state.voiceConfig?.stt?.reveal?.minIntervalMs,
          maxIntervalMs: state.voiceConfig?.stt?.reveal?.maxIntervalMs,
        })
      }
      if (state.voiceSelection !== prev.voiceSelection || state.ttsEndpoint !== prev.ttsEndpoint) {
        if (this.agent) {
          this.agent.ttsSelection = state.voiceSelection
          this.agent.ttsEndpoint = state.ttsEndpoint
        }
      }
      if (state.session !== prev.session && state.session !== null) {
        this.agent?.attach(state.session)
        attachSession(state.session)
      }
    })
  }

  private reportMode(): void {
    const phase = useVoiceSystemStore.getState().phase
    const micMuted = useMuteStore.getState().micMuted
    report({ actor: 'mode', mode: modeFor(phase, micMuted) })
    if (phase === 'off') resetTurnManager()
  }

  private isCurrent(sessionId: string): boolean {
    const state = useVoiceSystemStore.getState()
    return state.sessionId === sessionId && (state.phase === 'starting' || state.phase === 'live')
  }

  /** From a tap. Synchronous until acquire has been called. `opts.takeover`
   *  asks every connection this session makes to take the transcription slot
   *  from whoever holds it, rather than being refused with `held`. */
  voiceOn(opts?: { takeover?: boolean }): void {
    const phase = useVoiceSystemStore.getState().phase
    if (phase === 'starting' || phase === 'live') return
    if (phase === 'ending') {
      useVoiceSystemStore.setState({ phase: 'off', sessionId: null })
      this.reportMode()
    }

    const sessionId = this.deps.newSessionId()
    this.startedAt = this.deps.now()
    useVoiceSystemStore.setState({ phase: 'starting', sessionId, lastEnd: null })
    this.reportMode()

    let acquired: Promise<boolean>
    try {
      acquired = this.deps.devices.acquire()
    } catch (err) {
      acquired = Promise.reject(err)
    }

    void this.runStart(sessionId, acquired, opts)
  }

  private async runStart(sessionId: string, acquired: Promise<boolean>, opts?: { takeover?: boolean }): Promise<void> {
    try {
      const ok = await acquired
      if (!ok) return
      if (!this.isCurrent(sessionId)) return

      const attempted = this.deps.tones.play('attempted')

      const { voiceConfig: config, voiceSelection: selection } = useVoiceSessionStore.getState()
      const provider = config?.tts.providers.find((p) => p.serviceId === selection?.serviceId)
      if (!config || !selection || !provider) {
        throw new Error('Voice not configured')
      }

      const [ttsEndpoint, sttEndpoint] = await Promise.all([
        this.deps.services.ensureTtsReady(provider.serviceId),
        config.stt?.serviceId ? this.deps.services.ensureServiceReady(config.stt.serviceId) : Promise.resolve(null),
      ])
      if (!this.isCurrent(sessionId)) return
      useVoiceSessionStore.setState({ ttsEndpoint, sttEndpoint })

      let facts: SttModelFacts | null = null
      let sttMode: 'batch' | 'streaming' | null = null
      if (sttEndpoint && config.stt?.model) {
        facts = await this.deps.services.fetchSttModelFacts(sttEndpoint, config.stt.model)
        if (!this.isCurrent(sessionId)) return
        sttMode = resolveSttMode(facts, config.stt.preferStreaming)
        if (facts.present === false) {
          console.warn(`[voice] ${config.stt.model} has no weights on this node yet — loading may be slow or fail`)
        }
      }
      await Promise.all([
        this.deps.services.loadTtsModel(ttsEndpoint, selection.modelKey),
        sttEndpoint && config.stt?.model && sttMode
          ? this.deps.services.loadSttModel(
              sttEndpoint,
              config.stt.model,
              sttMode,
              sttMode === 'streaming' && facts ? resolveChunkMs(facts, config.stt.chunkMs) : undefined,
            )
          : Promise.resolve(),
      ])
      if (!this.isCurrent(sessionId)) return

      this.startHeartbeat([provider.serviceId, ...(config.stt?.serviceId ? [config.stt.serviceId] : [])])

      const { vad, smartTurn } = await this.deps.loadModels()
      if (!this.isCurrent(sessionId)) return

      const session = useVoiceSessionStore.getState().session
      if (!session) throw new Error('Not connected to the agent')

      const chunking = resolveChunkingFor(config, selection)
      this.deps.player.init()
      const agent = this.deps.createAgent(this.deps.player)
      agent.chunkConfig = {
        chunkStrategy: chunking.strategy,
        minChunkWords: chunking.minWords,
        maxChunkWords: chunking.maxWords,
      }
      agent.ttsEndpoint = ttsEndpoint
      agent.ttsSelection = selection
      agent.attach(session)
      this.agent = agent
      this.deps.player.setConcurrency(chunking.concurrency)
      if (config.stt?.turnTaking?.interruptionMinRemainingS !== undefined) {
        configureTurnManager({ interruptionMinRemainingS: config.stt.turnTaking.interruptionMinRemainingS })
      }
      configureReveal({
        minIntervalMs: config.stt?.reveal?.minIntervalMs,
        maxIntervalMs: config.stt?.reveal?.maxIntervalMs,
      })

      resetMutes()
      const human = this.deps.createHuman(vad, smartTurn, { onError: (m) => this.deps.notify(m) })
      human.loop.voiceConfig = config
      this.human = human
      attachSession(session)

      await attempted
      if (!this.isCurrent(sessionId)) return
      if (this.deps.now() - this.startedAt >= 2000) {
        await this.deps.tones.play('started')
        if (!this.isCurrent(sessionId)) return
      }

      // Session ids and take-over are sent only to a service that declares
      // `sessions: true` — any other STT service is used exactly as before.
      const declaresSessions = config.stt?.options?.find(o => o.serviceId === config.stt?.serviceId)?.sessions === true
      const takeover = declaresSessions && (opts?.takeover === true || config.takeover === 'always')
      const transport = await this.openConnection(
        sessionId,
        sttEndpoint,
        config,
        sttMode,
        human,
        declaresSessions ? sessionId : undefined,
        takeover,
        declaresSessions,
      )
      if (!this.isCurrent(sessionId)) {
        // The stop ran while the socket was opening, before the human side
        // held it, so nothing else will close it and it would keep the slot.
        transport.close()
        return
      }
      human.transport = transport
      human.start()
      useVoiceSystemStore.setState({ phase: 'live' })
      this.reportMode()
    } catch (err) {
      if (!this.isCurrent(sessionId)) return
      const message = err instanceof Error ? err.message : String(err)
      this.deps.notify(`Voice failed to start: ${message}`)
      this.voiceOff('start-failed', message)
    }
  }

  private async openConnection(
    sessionId: string,
    sttEndpoint: string | null,
    config: VoiceConfig,
    sttMode: 'batch' | 'streaming' | null,
    human: HumanSide,
    transportSessionId: string | undefined,
    takeover: boolean,
    /** Whether this STT service declares `sessions: true`. A `held` close
     *  from a service that does not is not actionable — take-over cannot be
     *  requested without session support — so it is treated as an ordinary
     *  dropped connection rather than routed to the take-over dialog. */
    declaresSessions: boolean,
  ): Promise<SttTransport> {
    const retry = {
      attempts: config.stt?.reconnect?.attempts ?? 3,
      delayMs: config.stt?.reconnect?.delayMs ?? 1000,
      stableMs: config.stt?.reconnect?.stableMs ?? 10000,
    }
    let failures = 0
    let acceptedAt: number | null = null
    let lossNoticed = false

    const endVoice = (reason: EndReason, message: string, persistentNotice = true) => {
      if (persistentNotice) this.deps.notify(`Voice transcription disconnected: ${message}`, true)
      this.voiceOff(reason, message)
    }

    const connect = () => this.deps.createTransport({
      endpoint: sttEndpoint!,
      serviceId: config.stt?.serviceId,
      model: config.stt?.model,
      mode: sttMode,
      sessionId: transportSessionId,
      takeover,
      onPartial: (text) => human.receivePartial(text),
      onReady: () => { acceptedAt = this.deps.now() },
      onClosed: (reason, info) => { void reconnect(reason, info.dropped, info.code) },
    })

    const reconnect = async (reason: string, dropped: number, code: string | null): Promise<void> => {
      if (!this.isCurrent(sessionId)) return
      if (acceptedAt !== null && this.deps.now() - acceptedAt >= retry.stableMs) {
        failures = 0
        lossNoticed = false
      }
      acceptedAt = null
      if (code === 'superseded') { endVoice('superseded', reason); return }
      if (code === 'held') {
        // Actionable only when this service declares sessions — otherwise
        // there is no take-over to offer, and this is an ordinary drop.
        if (declaresSessions) { endVoice('held', reason, false); return }
        endVoice('connection-lost', 'another session is using the transcription server')
        return
      }
      failures += 1
      if (failures > retry.attempts) { endVoice('connection-lost', reason); return }
      console.warn(`[voice] transcription socket closed (${reason}); reconnecting, attempt ${failures}`)
      await new Promise((resolve) => setTimeout(resolve, retry.delayMs * (failures - 1)))
      if (!this.isCurrent(sessionId)) return
      let next: SttTransport
      try {
        next = await connect()
      } catch (err) {
        await reconnect(err instanceof Error ? err.message : String(err), dropped, null)
        return
      }
      if (!this.isCurrent(sessionId)) {
        next.close()
        return
      }
      const cut = human.replaceTransport(next)
      if ((dropped > 0 || cut) && !lossNoticed) {
        lossNoticed = true
        this.deps.notify('Transcription reconnected — some of what you had just said was lost.')
      }
    }

    return connect()
  }

  voiceOff(reason: EndReason = 'user', message?: string): void {
    const phase = useVoiceSystemStore.getState().phase
    if (phase === 'off' || phase === 'ending') return

    const sessionId = useVoiceSystemStore.getState().sessionId
    useVoiceSystemStore.setState({ phase: 'ending', lastEnd: { reason, message } })
    this.reportMode()

    resetMutes()
    this.deps.player.reset()

    this.agent?.detach()
    this.agent = null
    detachSession()

    const human = this.human
    this.human = null
    const humanStop = human ? human.stop().then(() => {
      human.transport?.close()
      human.transport = null
    }) : Promise.resolve()

    this.stopHeartbeat()
    useVoiceSessionStore.setState({ ttsEndpoint: null, sttEndpoint: null })

    this.deps.devices.release()
    const ended = this.deps.tones.play('ended')

    void Promise.all([humanStop, ended]).then(() => {
      if (useVoiceSystemStore.getState().sessionId !== sessionId) return
      this.deps.player.release()
      useVoiceSystemStore.setState({ phase: 'off', sessionId: null })
      this.reportMode()
    })
  }

  /** A saved provider change: ready the TTS service and model, re-aim the heartbeat when a session is live. */
  reconfigure(selection: VoiceSelection, sttServiceId: string | undefined): void {
    const prev = useVoiceSessionStore.getState().voiceConfig
    const provider = prev?.tts.providers.find((p) => p.serviceId === selection.serviceId)
    if (!provider) return

    useVoiceSystemStore.setState({ reconfiguring: true })
    this.deps.services.ensureTtsReady(provider.serviceId)
      .then((endpoint) => {
        useVoiceSessionStore.setState({ ttsEndpoint: endpoint })
        return this.deps.services.loadTtsModel(endpoint, selection.modelKey)
      })
      .then(() => { useVoiceSystemStore.setState({ reconfiguring: false }) })
      .catch(() => { useVoiceSystemStore.setState({ reconfiguring: false }) })

    const sttChanged = sttServiceId && sttServiceId !== prev?.stt?.serviceId
    if (sttChanged) {
      this.deps.services.ensureServiceReady(sttServiceId).then((endpoint) => { setSttEndpoint(endpoint) }).catch(() => {})
    }

    if (this.heartbeat) {
      const sttId = sttServiceId ?? prev?.stt?.serviceId
      this.startHeartbeat([provider.serviceId, ...(sttId ? [sttId] : [])])
    }
  }

  /** Dismiss the last ending, so a dialog reading `lastEnd` (the `held`
   *  take-over prompt) closes without waiting for the next session to start. */
  clearLastEnd(): void {
    useVoiceSystemStore.setState({ lastEnd: null })
  }

  /** Start loading the browser models. Idempotent. */
  preload(): void {
    this.deps.loadModels().catch((err) => {
      // Most often the ORT wasm runtime or the .onnx models 404 under
      // /models/, which otherwise leaves voice silently dead.
      const detail = err instanceof Error ? err.message : String(err)
      this.deps.notify(`Voice models failed to load — check /models/*.onnx and /models/ort-*.wasm are served. (${detail})`)
    })
  }

  /** Test seam: forget the current session without running a stop. */
  resetForTest(): void {
    this.stopHeartbeat()
    this.human = null
    this.agent = null
    useVoiceSystemStore.setState({ phase: 'off', sessionId: null, reconfiguring: false, lastEnd: null })
  }

  /** Test seam: the player this system owns — the only way to reach it. */
  playerForTest(): VoicePlayer {
    return this.deps.player
  }

  private startHeartbeat(serviceIds: string[]): void {
    this.stopHeartbeat()
    if (serviceIds.length === 0) return
    const ping = () => { for (const id of serviceIds) this.deps.services.ping(id).catch(() => {}) }
    ping()
    this.heartbeat = setInterval(ping, PING_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
  }
}
