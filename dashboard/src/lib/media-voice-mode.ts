import { create } from 'zustand'
import { useStore } from 'zustand'
import { flushSync } from 'react-dom'
import { useMediaEngine, close as closeMedia, setOnPlayCommand } from './media-engine'
import { useMuteStore } from './voice/human/mute-store'
import { useTurnManagerStore } from './voice/store/turn-manager-store'
import { voiceSystem, useVoiceSystemStore } from './voice/system'
import type { Snapshot } from './voice/turn-manager'

// the design record-H8. Media and voice never
// coexist — the invariant belongs to exactly three writers here, never to a
// component: loadTrack (media-engine's playTrack, observed via subscription),
// voiceOn/voiceOff, and closeMedia (media-engine's close, also observed via
// subscription). Each clears the other mode and the armed flag, which is
// what makes states 5, 7 and 8 unproducible rather than merely unlikely.
//
// The voice half of the invariant — the phase, the mode report, the devices,
// the session's services — belongs to the system (lib/voice/system); this
// module owns only the gate (armed) and derives the media/voice states from
// the system's phase and the mute store. Nothing under lib/voice/system
// imports from here.

export type MediaVoiceState = 1 | 2 | 3 | 4 | 6

interface ModeState {
  armed: boolean
}

const useModeStore = create<ModeState>(() => ({
  armed: false,
}))

function derivedVoice(): 'off' | 'live' | 'muted' {
  const phase = useVoiceSystemStore.getState().phase
  if (phase !== 'starting' && phase !== 'live') return 'off'
  return useMuteStore.getState().micMuted ? 'muted' : 'live'
}

/** The five reachable states, derived from the media engine and this store.
 * Never a source of truth on its own — components branch on this, nothing
 * writes it directly. */
export function getMediaVoiceState(): MediaVoiceState {
  const { track, playing } = useMediaEngine.getState()
  const voice = derivedVoice()
  if (track) return playing ? 4 : 6
  if (voice === 'live') return 2
  if (voice === 'muted') return 3
  return 1
}

export function isArmed(): boolean {
  return useModeStore.getState().armed
}

/** React-subscribed derived state (U-H1: components branch on this, never
 * on raw fields). Re-renders on any change to the media engine's track/
 * playing fields, the system's phase, or the mic mute. */
export function useMediaVoiceState(): MediaVoiceState {
  const track = useStore(useMediaEngine, (s) => s.track)
  const playing = useStore(useMediaEngine, (s) => s.playing)
  const phase = useStore(useVoiceSystemStore, (s) => s.phase)
  const micMuted = useStore(useMuteStore, (s) => s.micMuted)
  const voice = phase === 'starting' || phase === 'live' ? (micMuted ? 'muted' : 'live') : 'off'
  if (track) return playing ? 4 : 6
  if (voice === 'live') return 2
  if (voice === 'muted') return 3
  return 1
}

/** React-subscribed read of the gate's armed flag (H7). */
export function useArmed(): boolean {
  return useStore(useModeStore, (s) => s.armed)
}

/** React-subscribed read of the raw voice value — 'off' | 'live' | 'muted'.
 * Most chrome should read useMediaVoiceState() instead; this exists for
 * callers that need "is voice on at all" (live or muted, both keep the
 * session running — only muting differs) rather than the derived 1-6 state. */
export function useVoiceValue(): 'off' | 'live' | 'muted' {
  const phase = useStore(useVoiceSystemStore, (s) => s.phase)
  const micMuted = useStore(useMuteStore, (s) => s.micMuted)
  return phase === 'starting' || phase === 'live' ? (micMuted ? 'muted' : 'live') : 'off'
}

// Every exported writer flushes synchronously via react-dom's flushSync: a
// caller (a click handler, or a test driving the module directly the way
// the design record's frozen tests do) can read the
// DOM immediately afterward and see the committed result, with no
// `act()`/`waitFor` of its own required. flushSync must not nest, so
// runFlushed() below is the single entry point that owns it — internal
// helpers call each other directly, never through a wrapped export.
let flushing = false
function runFlushed(fn: () => void): void {
  if (flushing) { fn(); return }
  flushing = true
  try {
    flushSync(fn)
  } finally {
    flushing = false
  }
}

/** First press with media loaded: arms the gate. Changes no media x voice
 * state — the track stays exactly as it was. H6. */
export function armVoice(): void {
  runFlushed(() => {
    if (useMediaEngine.getState().track === null) {
      voiceOnInternal()
      return
    }
    useModeStore.setState({ armed: true })
  })
}

/** Second press: commits the gate. Dismisses media (discarded, not paused —
 * H3) and turns voice on. H6. */
export function commitVoice(): void {
  runFlushed(() => {
    useModeStore.setState({ armed: false })
    voiceOnInternal()
  })
}

/** Direct entry with nothing loaded — one press, no gate (H5). Also the
 * fallback armVoice() takes when called with nothing loaded, since arming an
 * empty gate has nothing to protect. `opts` passes through to the system,
 * e.g. `{ takeover: true }` from the held-transcription dialog's Take over. */
export function voiceOn(opts?: { takeover?: boolean }): void {
  runFlushed(() => voiceOnInternal(opts))
}

function voiceOnInternal(opts?: { takeover?: boolean }): void {
  useModeStore.setState({ armed: false })
  // Dismiss media first (discard, not pause) if anything is loaded — the
  // writer's own invariant, not a caller's responsibility.
  if (useMediaEngine.getState().track !== null) {
    closeMedia()
  }
  voiceSystem.voiceOn(opts)
}

/**
 * End the session — H10's stop-everything entry, reached by the exit ✕, the
 * composer's voice-off, a media track starting, and by the pipeline losing
 * something it cannot run without (the STT socket closing, a startup that
 * failed). Every one of those ends the session identically: the system's
 * phase reports `ending` then `off`, the devices release and the ended tone
 * plays.
 *
 * A no-op when no session is running or one is already ending — the
 * system's own voiceOff() guards that.
 */
export function voiceOff(): void {
  runFlushed(() => {
    useModeStore.setState({ armed: false })
    voiceSystem.voiceOff('user')
  })
}

/** Cancel / Escape / field focus / navigation / any writer. Re-locks the
 * gate. A stale armed state must never persist (H7). */
export function cancelArm(): void {
  runFlushed(() => {
    useModeStore.setState({ armed: false })
  })
}

/** Whether the agent's current utterance is audible right now, read from
 * the floor snapshot. */
function isAgentAudible(snapshot: Snapshot): boolean {
  const agent = snapshot.agent
  if (agent === null) return false
  return agent.utterances.some((u) => u.id === agent.id && u.phase === 'audible')
}

// ── The invariant, enforced by subscription ────────────────────────────────
//
// media-engine.ts cannot import this module (U-H7's dependency direction is
// unchanged — the media engine still imports nothing from lib/voice/, and by
// extension nothing from this module either, since that would let a voice
// concern leak back into it). So the media-side half of the invariant —
// loading a track turns voice off; closing clears the arm — is applied here,
// by subscribing to the engine's own store. Zustand subscriptions fire
// synchronously on setState, so isArmed()/getMediaVoiceState() read the
// post-invariant value immediately after playTrack()/close() return, with no
// microtask gap for a test (or a component) to observe a stale value in.

let lastTrackId: string | null = null
let lastPlaying = false
let wired = false

function wire(): void {
  if (wired) return
  wired = true

  useMediaEngine.subscribe((state) => {
    const trackId = state.track?.id ?? null
    // A library track ending rewinds to 0 and stops without changing the
    // track id — the gate armed against it is stale too (H7: a stale armed
    // state must never persist), so that transition re-locks as well.
    const ended = lastPlaying && !state.playing && state.currentTime === 0
    lastPlaying = state.playing
    if (trackId !== lastTrackId || ended) {
      lastTrackId = trackId
      // armed is cleared by every writer (H1/H7), on both loading and
      // closing. voice's own value is left untouched here on purpose: the
      // "media started -> voice off" half of the invariant is owned
      // entirely by setOnPlayCommand below, and closing media while voice
      // was already off must not spuriously touch it either — the only path
      // that turns media off *and* voice on is voiceOnInternal() above,
      // which starts the system itself.
      useModeStore.setState({ armed: false })
    }
  })

  // Media started (H3, forward direction): turn voice off if it was live —
  // discarding what voice was doing rather than the old pause-the-loser
  // behaviour. Read here (not from the media engine's own store update)
  // because setOnPlayCommand fires synchronously from playTrack()/toggle(),
  // before the track's own subscription above has necessarily run first —
  // both orders are safe since this only ever clears `armed`, never the
  // system's phase.
  setOnPlayCommand(() => {
    // Every play command re-locks the gate — including re-loading the track
    // already loaded, which changes no id and so never reaches the
    // subscription above (H1).
    runFlushed(() => {
      useModeStore.setState({ armed: false })
      // Starting media is a choice to stop listening — the same stop an exit
      // press performs.
      if (derivedVoice() !== 'off') voiceSystem.voiceOff('media')
    })
  })

  // Voice started (H4, reverse direction — defense in depth): if voice
  // playback begins advancing while media is somehow still marked as
  // playing, stop media. In practice voiceOnInternal() already dismisses
  // media before voice ever turns on, so this path is not normally reached;
  // it exists so calling the writers out of the UI's own sequence (as H2's
  // test does) still can never produce two sources advancing at once.
  let wasAudible = isAgentAudible(useTurnManagerStore.getState().snapshot)
  useTurnManagerStore.subscribe((state) => {
    const audible = isAgentAudible(state.snapshot)
    if (audible && !wasAudible) {
      const { track, playing } = useMediaEngine.getState()
      if (track && playing) closeMedia()
    }
    wasAudible = audible
  })
}

wire()

/** Test/debug hook only — resets this module's own state without touching
 * the media engine. */
export function debugResetMode(): void {
  lastTrackId = useMediaEngine.getState().track?.id ?? null
  lastPlaying = useMediaEngine.getState().playing
  useModeStore.setState({ armed: false })
  voiceSystem.resetForTest()
}
