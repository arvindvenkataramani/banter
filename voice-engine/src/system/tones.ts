// Event tones for voice mode, played through the speech engine's own
// element so the page has one media element. Tones never overlap speech:
// the engine refuses a tone while a run is active, and a run beginning cuts
// one. Attempted plays once the microphone is acquired after the tap that
// turns voice on, started when voice is fully ready and the start was not
// warm, ended when voice turns off. They play one at a time, in order.

import { useTurnManagerStore } from '../store/turn-manager-store'
import type { TonePlayer } from './playback-engine'

const TONE_URLS = {
  attempted: '/tones/voice/voice-attempted.mp3',
  started: '/tones/voice/voice-started.mp3',
  ended: '/tones/voice/voice-ended.mp3',
} as const

export type ToneName = keyof typeof TONE_URLS

/** Each tone's length in seconds, which the engine uses to place its end on
 * the speech timeline. Re-measure (ffprobe) when an asset changes. */
const TONE_DURATIONS_S: Record<ToneName, number> = {
  attempted: 1.2,
  started: 0.792,
  ended: 1.08,
}

// The tone bytes, fetched once per page — shared by every queue, since the
// bytes themselves don't depend on which player plays them.
const loaded: Partial<Record<ToneName, Uint8Array>> = {}
let preloading: Promise<void> | null = null

/** Fetch every tone into memory once, so no play waits on the network.
 * Safe to call repeatedly. */
export function preloadTones(): Promise<void> {
  if (preloading) return preloading
  preloading = Promise.all((Object.keys(TONE_URLS) as ToneName[]).map(async (name) => {
    try {
      const res = await fetch(TONE_URLS[name])
      if (res.ok) loaded[name] = new Uint8Array(await res.arrayBuffer())
    } catch {
      // Fetched again at play time.
    }
  })).then(() => undefined)
  return preloading
}

async function bytesFor(name: ToneName): Promise<Uint8Array | null> {
  const have = loaded[name]
  if (have) return have
  try {
    const res = await fetch(TONE_URLS[name])
    if (!res.ok) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    loaded[name] = bytes
    return bytes
  } catch {
    return null
  }
}

export interface ToneQueue {
  /** Enqueue a tone. Resolves when that tone has been heard, cut, or
   * skipped; never rejects. */
  play(name: ToneName): Promise<void>
  /** Test seam: every tone that has started playing, in order. */
  playedForTest(): readonly ToneName[]
  /** Test seam: forget this queue's own state. The shared byte cache is
   * untouched — call resetTonesForTest() to forget that too. */
  resetForTest(): void
}

/** One queue per player, so a page with more than one voice system (a test
 * harness among them) never shares queue state across them. */
export function createToneQueue(player: TonePlayer): ToneQueue {
  const queue: Array<{ name: ToneName; resolve: () => void }> = []
  let playing = false
  const history: ToneName[] = []

  async function playNext(): Promise<void> {
    const next = queue.shift()
    if (!next) {
      playing = false
      return
    }
    playing = true
    history.push(next.name)
    const bytes = await bytesFor(next.name)
    if (bytes) await player.enqueueTone(bytes, TONE_DURATIONS_S[next.name])
    next.resolve()
    void playNext()
  }

  return {
    play(name) {
      // Tones abide by speech mute, skipped rather than deferred: speech
      // mute is deliberately non-destructive, and a tone held to the
      // unmute would sound late, into a microphone that is already open.
      if (useTurnManagerStore.getState().snapshot.controls.speechMuted) {
        return Promise.resolve()
      }
      const done = new Promise<void>((resolve) => { queue.push({ name, resolve }) })
      if (!playing) void playNext()
      return done
    },
    playedForTest() {
      return history
    },
    resetForTest() {
      queue.length = 0
      playing = false
      history.length = 0
    },
  }
}

/** Test seam: forget the shared byte cache. */
export function resetTonesForTest(): void {
  preloading = null
  for (const name of Object.keys(loaded) as ToneName[]) delete loaded[name]
}
