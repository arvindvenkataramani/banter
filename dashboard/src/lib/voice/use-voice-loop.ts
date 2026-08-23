import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { SileroVad } from './silero-vad'
import { SmartTurn } from './smart-turn'
import { MicLoop } from './mic-loop'
import { TurnManager } from './turn-manager'
import { useMicStore } from './store/mic-store'
import { usePlayerStore, getPlaybackEngine, disposePlaybackEngine } from './store/player-store'
import { useLLMStore, type LLMState } from './store/llm-store'
import { useMuteStore, setMuteMicLoop, resetMutes, toggleMuteAll, toggleSpeechMuted, relinkMutes, setMicAutoMuted } from './store/mute-store'
import { reportRunBeginning, reportRunEnding, reportCommitFalseAlarm, reportCommitSend, reportSpeechOnset, reportNothingToFlush, reportUtteranceAbandoned, haltAll, shouldHoldChunk, shouldDiscardChunk } from './playback-arbiter'
import { registerAudioHalter } from '../controls'
import type { VoiceConfig, VoiceSelection, ChunkStrategy } from './voice-config'
import type { Session } from '../session'
import type { MicState } from './store/mic-store'
import type { PlayerState } from './playback-engine'

// Backward-compatible aliases for existing UI code
export type LoopState = MicState
export type PlaybackState = PlayerState

export interface UseVoiceLoopOpts {
  enabled: boolean
  sttEndpoint: string | null
  voiceConfig: VoiceConfig | null
  session: Session | null
  ttsEndpoint: string | null
  ttsSelection: VoiceSelection | null
  chunkStrategy?: ChunkStrategy
  minChunkWords?: number
  maxChunkWords?: number
  ttsConcurrency?: number
  /**
   * MediaStream acquired synchronously in the tap handler that enabled voice
   * mode. iOS Safari only prompts for mic permission when getUserMedia runs
   * inside the gesture frame, so the page acquires it there and hands it down
   * for MicCapture to consume on first start.
   */
  micStream?: MediaStream | null
  onSttEndpointChange?: (endpoint: string) => void
  onError?: (message: string) => void
}

export interface UseVoiceLoopResult {
  loopState: MicState
  playbackState: PlayerState
  isVoiceReady: boolean
  /** Mic loop has acquired the stream and the VAD is warmed (first frames flowing). */
  micReady: boolean
  micMuted: boolean
  speechMuted: boolean
  /**
   * Whether mic and speech mute move together. Starts linked: the big mute
   * button drives both. Toggling either one individually unlinks them, so the
   * user can hold "mic on, speech off" (or the reverse) without the next
   * press collapsing it. Unmuting both re-links — at that point there is no
   * divergence left to preserve. Neither the mute states nor the linkage
   * survive: both are session-scoped and reset at each voice-mode on.
   */
  muteLinked: boolean
  /** Re-link and bring both to the mic's current state. */
  relinkMutes: () => void
  toggleSpeechMuted: () => void
  toggleMuteAll: () => void
  /** Auto-mute the mic while the user is typing. */
  setMicAutoMuted: (active: boolean) => void
}

export function useVoiceLoop(opts: UseVoiceLoopOpts): UseVoiceLoopResult {
  const [isVoiceReady, setIsVoiceReady] = useState(false)

  // Read store-driven state via Zustand selectors.
  const loopState = useStore(useMicStore, s => s.state)
  const micReady = useStore(useMicStore, s => s.ready)
  const playbackState = useStore(usePlayerStore, s => s.state)
  const micMuted = useStore(useMuteStore, s => s.micMuted)
  const speechMuted = useStore(useMuteStore, s => s.speechMuted)
  const muteLinked = useStore(useMuteStore, s => s.muteLinked)

  const vadRef = useRef<SileroVad | null>(null)
  const smartTurnRef = useRef<SmartTurn | null>(null)
  const micLoopRef = useRef<MicLoop | null>(null)
  const turnManagerRef = useRef<TurnManager | null>(null)
  // Tracks which MediaStream we've already handed to MicLoop. MicCapture will
  // stop the tracks when the loop tears down, so on a subsequent effect re-run
  // (e.g. sttEndpoint changes) opts.micStream still references the dead stream
  // — we must not pass it again. iOS will allow gUM-fallback at that point
  // because the permission grant from the initial tap is cached.
  const consumedStreamRef = useRef<MediaStream | null>(null)

  // Latest error sink, so the mount-time model loader (a []-dep effect) can
  // report without capturing a stale callback.
  const onErrorRef = useRef(opts.onError)
  onErrorRef.current = opts.onError

  // Load VAD + SmartTurn once
  useEffect(() => {
    if (vadRef.current) return
    let cancelled = false
    async function load() {
      const vad = new SileroVad()
      const smartTurn = new SmartTurn()
      // Load both in parallel so the silero (1.8MB) and smart-turn (8.3MB)
      // downloads overlap instead of running back-to-back.
      await Promise.all([vad.load(), smartTurn.load()])
      if (cancelled) { vad.destroy(); smartTurn.destroy(); return }
      vadRef.current = vad
      smartTurnRef.current = smartTurn
      setIsVoiceReady(true)
    }
    load().catch((err) => {
      if (cancelled) return
      // Most common cause in production: the ORT wasm runtime (or the .onnx
      // models) 404s under /models/, so the VAD/SmartTurn sessions never build.
      // Surface it loudly instead of leaving voice silently dead.
      const detail = err instanceof Error ? err.message : String(err)
      const msg = `Voice models failed to load — check /models/*.onnx and /models/ort-*.wasm are served. (${detail})`
      console.error('[voice]', msg, err)
      onErrorRef.current?.(msg)
    })
    return () => { cancelled = true }
  }, [])

  // Push opts into the loop instance every render (config + chunking)
  const micLoop = micLoopRef.current
  const turnManager = turnManagerRef.current
  if (micLoop) {
    micLoop.voiceConfig = opts.voiceConfig
    micLoop.micMuted = micMuted
  }
  if (turnManager) {
    turnManager.config = {
      chunkStrategy: opts.chunkStrategy ?? 'two-chunk',
      minChunkWords: opts.minChunkWords,
      maxChunkWords: opts.maxChunkWords,
    }
  }

  // Configure the playback engine's concurrency cap and chunk predicates
  useEffect(() => {
    const engine = getPlaybackEngine()
    engine.setConcurrency(opts.ttsConcurrency)
    // Bug C: shouldHold reads mic state directly (not a stale latched flag)
    engine.setShouldHold(shouldHoldChunk)
    engine.setShouldDiscard(shouldDiscardChunk)
  }, [opts.ttsConcurrency])

  // Single effect: lifecycle of the voice loop
  useEffect(() => {
    if (!opts.enabled || !isVoiceReady || !opts.sttEndpoint || !opts.session) {
      // Tear down
      turnManagerRef.current?.detach()
      if (micLoopRef.current) {
        micLoopRef.current.stop()
        micLoopRef.current = null
        setMuteMicLoop(null)
      }
      turnManagerRef.current = null
      disposePlaybackEngine()
      useMicStore.setState({ state: 'idle', speaking: false, ready: false })
      useLLMStore.setState({ state: 'idle', activeRunId: null })
      return
    }

    // Set up the player engine
    const engine = getPlaybackEngine()
    engine.init()
    engine.setConcurrency(opts.ttsConcurrency)
    engine.setShouldHold(shouldHoldChunk)
    engine.setShouldDiscard(shouldDiscardChunk)

    // Turn driver — attaches to the session's Conversation directly (its own
    // ordered tap + subscribe) rather than being fed React snapshots. Tool-
    // start flushing and reset/markUnknown discard are handled entirely
    // inside TurnManager now.
    const turnManager = new TurnManager({
      enqueueChat: async (text) => {
        const sel = opts.ttsSelection
        const endpoint = opts.ttsEndpoint
        if (!sel || !endpoint) return
        await engine.enqueueChat({
          endpoint,
          text,
          modelId: sel.model,
          voiceId: sel.voice,
          speed: sel.speed ?? 1.0,
          params: sel.params,
        })
      },
      beginRun: reportRunBeginning,
      endRun: reportRunEnding,
    })
    turnManager.config = {
      chunkStrategy: opts.chunkStrategy ?? 'two-chunk',
      minChunkWords: opts.minChunkWords,
      maxChunkWords: opts.maxChunkWords,
    }
    turnManager.attach(opts.session)
    turnManagerRef.current = turnManager

    // llm-store mirrors the conversation's ground truth directly — no
    // TurnManager-local state machine anymore. 'tool' and 'active'/'thinking'
    // both count as "generating" for isLLMActive()'s purposes; only actively
    // streamed text counts as "streaming".
    const syncLLMStore = () => {
      const snap = opts.session!.conversation.getSnapshot()
      const state: LLMState = !snap.runActive
        ? 'idle'
        : snap.activity === 'speaking'
          ? 'streaming'
          : 'generating'
      useLLMStore.setState({ state, activeRunId: snap.runId })
    }
    syncLLMStore()
    const unsubscribeLLM = opts.session.conversation.subscribe(syncLLMStore)

    // Local "silence now" precedes ground truth — stop() halts audio
    // synchronously before the abort RPC resolves.
    const unregisterHalter = registerAudioHalter(haltAll)

    // Mic loop — wires mic store + reports playback-arbiter events + delegates to LLM
    const micLoop = new MicLoop(vadRef.current!, smartTurnRef.current!, {
      onState: (state) => {
        const speaking = state !== 'idle'
        useMicStore.setState({ state, speaking })
      },
      onReady: (ready) => useMicStore.setState({ ready }),
      onError: (msg) => opts.onError?.(msg),
      onSttEndpointChange: (endpoint) => opts.onSttEndpointChange?.(endpoint),
      isPlayerPlaying: () => usePlayerStore.getState().state === 'playing',
      isPlayerPaused: () => usePlayerStore.getState().state === 'paused',
      getPlayerRemainingSeconds: () => engine.remainingSeconds,
      getConversationState: () => opts.session!.conversation.getSnapshot(),
      sendMessage: (text, sendOpts) => turnManager.send(text, sendOpts),
      reportSpeechOnset,
      reportCommitFalseAlarm,
      reportCommitSend,
      reportNothingToFlush,
      reportUtteranceAbandoned,
    })
    micLoop.voiceConfig = opts.voiceConfig
    // Voice mode always begins live and linked. Mute is only meaningful while
    // the mic and playback exist, so a state carried across voice-off would
    // describe a session that has ended.
    micLoop.micMuted = false
    resetMutes()
    if (opts.micStream && opts.micStream !== consumedStreamRef.current) {
      micLoop.setMicStream(opts.micStream)
      consumedStreamRef.current = opts.micStream
    }
    micLoopRef.current = micLoop
    setMuteMicLoop(micLoop)
    micLoop.start(opts.sttEndpoint)
    if (micLoop.micMuted) {
      micLoop.muteMic()
    }

    return () => {
      micLoop.stop()
      micLoopRef.current = null
      setMuteMicLoop(null)
      turnManager.detach()
      turnManagerRef.current = null
      unsubscribeLLM()
      unregisterHalter()
      disposePlaybackEngine()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, isVoiceReady, opts.sttEndpoint, opts.session])

  return {
    loopState,
    playbackState,
    isVoiceReady,
    micReady,
    micMuted,
    speechMuted,
    muteLinked,
    relinkMutes,
    toggleSpeechMuted,
    toggleMuteAll,
    setMicAutoMuted,
  }
}

