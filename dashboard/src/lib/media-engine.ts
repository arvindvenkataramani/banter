import { create } from 'zustand'

// Module-scope media playback engine. the design record.
//
// Creates the <audio> element in JavaScript at module scope (B2) and owns
// src/play/pause/seek/Media Session. No component owns the element, so no
// unmount destroys it (B1). React reads everything through the store (B3);
// the only way to command playback is through this module's exported
// functions. Imports nothing from dashboard/src/lib/voice/ (U3) — the
// coordinator is the only module that knows both engines exist.

export interface MediaTrack {
  id: string
  title: string
  /** Manifest duration, shown until the element's own duration is known
   * (B20) — the element always wins once it fires durationchange. */
  manifestDuration: number | null
  /** Where the listener reached this track from, which decides what happens
   * when it finishes. A slot is always reachable again from the contextual
   * surface that launched it, so its chrome can be dismissed on end without
   * stranding anyone. A library track has no such home, so it stays and
   * resets instead. */
  origin: MediaTrackOrigin
  /** Presence (not content) drives H23's source-text control — a slot's
   * briefing has none, so the control is absent for one. Optional: existing
   * callers (and the frozen media-engine.test.ts) construct tracks without
   * it. */
  sourceText?: string | null
}

export type MediaTrackOrigin = 'slot' | 'library'

export type MediaEngineClosedState = 'never-played' | 'closed'

export interface MediaEngineState {
  track: MediaTrack | null
  playing: boolean
  currentTime: number
  /** The live element's own duration, once known. Null until then or after
   * a close. Distinct from track.manifestDuration — see B20. */
  elementDuration: number | null
  /** B6: closed and never-played are distinct internal states, so anything
   * keyed off "is there a player" can say which it means. */
  closedState: MediaEngineClosedState
  /** Increments on every playback error. The page watches this (not a
   * boolean) so a second error while the toast from the first is still
   * showing is still observable as a change. */
  errorSeq: number
}

export const useMediaEngine = create<MediaEngineState>(() => ({
  track: null,
  playing: false,
  currentTime: 0,
  elementDuration: null,
  closedState: 'never-played',
  errorSeq: 0,
}))

let el: HTMLAudioElement | null = null

// The coordinator's hook into "a media command started playback" — set via
// setOnPlayCommand, never read by this module. Fired synchronously from
// playTrack()/toggle() rather than from the element's own `play` event: the
// jsdom test harness stubs HTMLMediaElement.play() to a resolved promise, so
// no real `play` event ever fires, and the coordinator needs a signal that
// exists under test as well as in a browser.
let onPlayCommand: (() => void) | null = null

export function setOnPlayCommand(fn: (() => void) | null): void {
  onPlayCommand = fn
}

function element(): HTMLAudioElement {
  if (el) return el
  const audio = new Audio()
  audio.preload = 'metadata'
  // Keep playback local to the device rather than offering AirPlay, matching
  // the voice playback engine (playback-engine.ts's attachMMS).
  ;(audio as unknown as { disableRemotePlayback?: boolean }).disableRemotePlayback = true

  audio.addEventListener('timeupdate', () => {
    useMediaEngine.setState({ currentTime: audio.currentTime })
  })
  const captureDuration = () => {
    if (Number.isFinite(audio.duration)) useMediaEngine.setState({ elementDuration: audio.duration })
  }
  // Both events, deliberately: durationchange is the general-purpose signal,
  // but the previous page-scoped element listened to loadedmetadata (the
  // event that reliably carries a known duration at that point) — kept so
  // duration resolution behaves exactly as it did before the fold-in.
  audio.addEventListener('durationchange', captureDuration)
  audio.addEventListener('loadedmetadata', captureDuration)
  audio.addEventListener('play', () => useMediaEngine.setState({ playing: true }))
  audio.addEventListener('pause', () => useMediaEngine.setState({ playing: false }))
  // What ending means depends on where the track came from. A slot closes —
  // the homepage trigger that launched it is still there to launch it again.
  // A library track has no contextual home to return to, so the chrome stays
  // and rewinds: pressing play restarts it rather than resuming a finished
  // track at its end.
  audio.addEventListener('ended', () => {
    if (useMediaEngine.getState().track?.origin === 'slot') {
      close()
      return
    }
    audio.currentTime = 0
    useMediaEngine.setState({ playing: false, currentTime: 0 })
  })
  audio.addEventListener('error', () => {
    // An empty-string src (see close()'s comment) resolves to the page's own
    // URL in a real browser and fires a spurious error trying to decode it —
    // ignore an error with no real src, matching page.tsx's prior guard.
    if (!audio.getAttribute('src')) return
    close()
    useMediaEngine.setState((s) => ({ errorSeq: s.errorSeq + 1 }))
  })

  el = audio
  return audio
}

function setMediaSessionMetadata(title: string): void {
  if (!('mediaSession' in navigator)) return
  try {
    // eslint-disable-next-line no-undef
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Sutradhara' })
  } catch {
    /* ignore — guarded call only */
  }
}

function clearMediaSessionMetadata(): void {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = null
  } catch {
    /* ignore */
  }
}

const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']

function withActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.setActionHandler(action, handler)
  } catch {
    /* action not supported by this browser — ignore */
  }
}

function registerActionHandlers(): void {
  withActionHandler('play', () => { void play() })
  withActionHandler('pause', () => pause())
  // rewind-15 is the on-screen control (player.tsx); seekbackward's default
  // offset (10s) doesn't match it, so an explicit offset is always applied.
  withActionHandler('seekbackward', (details) => seekBy(-(details.seekOffset ?? 15)))
  withActionHandler('seekforward', (details) => seekBy(details.seekOffset ?? 15))
  withActionHandler('seekto', (details) => {
    if (typeof details.seekTime === 'number') seekTo(details.seekTime)
  })
}

/** Undo registerActionHandlers() — a lock screen or headset control must not
 * reach a closed engine's handlers, which would resurrect audio on an
 * abandoned source (F4/F6). */
function clearActionHandlers(): void {
  for (const action of MEDIA_SESSION_ACTIONS) withActionHandler(action, null)
}

/** Load a track and start it. Must be called inside a user gesture on iOS. */
export function playTrack(track: MediaTrack): Promise<void> {
  const audio = element()
  audio.src = `/api/media/${track.id}/audio`
  useMediaEngine.setState((s) => ({
    track,
    // Set optimistically, ahead of the element's own `play` event: a real
    // browser fires that event asynchronously, and under jsdom (used by the
    // frozen harmonisation-spec tests) HTMLMediaElement.play() is stubbed
    // to a resolved promise that never fires it at all. The `play`/`pause`
    // listeners registered in element() still correct this from the real
    // element's own state once events do arrive.
    playing: true,
    currentTime: 0,
    elementDuration: null,
    // B6: closed and never-played are distinct — a track that has already
    // been closed once and is now playing again is not "never played."
    // Only unset it if it was never set (F5).
    closedState: s.closedState === 'closed' ? 'closed' : 'never-played',
  }))
  setMediaSessionMetadata(track.title)
  registerActionHandlers()
  onPlayCommand?.()
  return Promise.resolve(audio.play())
}

/** True once a track has been loaded and not yet closed — guards the
 * commands below from resurrecting audio on an abandoned element (F6),
 * reachable via a stale Media Session handler surviving past close() (F4).
 */
function hasActiveTrack(): boolean {
  return useMediaEngine.getState().track !== null
}

export function toggle(): Promise<void> {
  if (!hasActiveTrack()) return Promise.resolve()
  const audio = element()
  if (audio.paused) {
    onPlayCommand?.()
    useMediaEngine.setState({ playing: true }) // see playTrack()'s comment
    return Promise.resolve(audio.play())
  }
  audio.pause()
  useMediaEngine.setState({ playing: false })
  return Promise.resolve()
}

/** Resume-only — unlike toggle(), never pauses. For an effect that reacts to
 * "should be playing" and must not flip to pause on a re-run while already
 * playing. */
export function play(): Promise<void> {
  if (!hasActiveTrack()) return Promise.resolve()
  const audio = element()
  if (!audio.paused) return Promise.resolve()
  onPlayCommand?.()
  return Promise.resolve(audio.play())
}

export function pause(): void {
  el?.pause()
}

// No unknown-duration guard here: rewind-15 (player.tsx's on-screen control)
// and the B9 seekbackward Media Session handler both seek through this
// function with duration unknown, and B15 pins that behaviour unchanged.
// The arrow-key path's own guard (page.tsx's handleSeekBy) is a call-site
// concern, not this function's — see D12.
export function seekBy(delta: number): void {
  if (!hasActiveTrack()) return
  const audio = element()
  const next = Math.max(0, audio.currentTime + delta)
  audio.currentTime = Number.isFinite(audio.duration) ? Math.min(audio.duration, next) : next
}

export function seekTo(time: number): void {
  if (!hasActiveTrack()) return
  const audio = element()
  audio.currentTime = time
}

/** Stop and discard the active track. The engine survives (B5) — only the
 * track and the element's source go away. */
export function close(): void {
  const audio = element()
  audio.pause()
  // Set to the empty string rather than removing the attribute: a frozen
  // test observes "src cleared" by reading getAttribute('src') and requires
  // it to be non-null (proof the clear happened) but empty —
  // removeAttribute makes getAttribute return null, indistinguishable from
  // "never touched."
  audio.setAttribute('src', '')
  try {
    // .load() is not implemented in jsdom; real browsers need it to fully
    // abandon the previous source rather than just clearing the attribute.
    audio.load()
  } catch {
    /* jsdom: HTMLMediaElement.load() not implemented */
  }
  clearMediaSessionMetadata()
  clearActionHandlers()
  useMediaEngine.setState({
    track: null,
    playing: false,
    currentTime: 0,
    elementDuration: null,
    closedState: 'closed',
  })
}

/** Test/debug hook: the live element, so a harness or the coordinator's
 * pause-check can read it without going through React. */
export function debugElement(): HTMLAudioElement | null {
  return el
}
