import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Frame } from '../../system/devices'
import type { VadResult } from './silero-vad'
import type { VoiceConfig } from '../voice-config'

// The loop runs over the real UtteranceBuffer; only the frame source under it
// is faked, so every pushed frame is captured and counted exactly as it would
// be from the microphone. The confidence gate is driven by real sample counts.
let deliver: ((frame: Frame) => void) | null = null
const detach = vi.fn(() => { deliver = null })
vi.mock('../../system/devices', () => ({
  MIC_SAMPLE_RATE: 16000,
  frameSource: {
    attach: (onFrame: (frame: Frame) => void) => { deliver = onFrame },
    detach: () => detach(),
  },
}))

const { MicLoop } = await import('./mic-loop')
type MicLoopCallbacks = import('./mic-loop').MicLoopCallbacks

// 100ms frames. The buffer's rolling preroll is 160ms, so a fresh utterance
// starts at 0.1s and gains 0.1s per speech frame.
const FRAME = 1600

/** A VAD that returns exactly the verdict each test queues for the next frame,
 * one window per frame. `hold()` makes the next inference wait until released,
 * so a test can land something while it is in flight. */
function fakeVad() {
  const verdicts: VadResult[] = []
  let gate: Promise<void> | null = null
  return {
    verdicts,
    hold(): () => void {
      let release!: () => void
      gate = new Promise<void>((r) => { release = r })
      return release
    },
    reset: vi.fn(),
    setSpeechThreshold: vi.fn(),
    isReady: () => true,
    async process(): Promise<VadResult[]> {
      const v = verdicts.shift()
      if (gate) { const g = gate; gate = null; await g }
      return v ? [v] : []
    },
  }
}

const config = {
  stt: {
    vad: { minSpeechDurationS: 0.5, minSpeechProb: 0.7 },
    turnTaking: { pauseThresholdMs: 200, commitMinDelayMs: 100, commitMaxDelayMs: 100 },
    maxRecordingMs: 10000,
  },
} as unknown as VoiceConfig

function makeCallbacks() {
  const ended: Array<{ id: string; audio: Float32Array }> = []
  const cb = {
    onSpeechBegan: vi.fn(),
    onSpeechConfirmed: vi.fn<(id: string) => void>(),
    onUtteranceEnded: vi.fn((id: string, audio: Float32Array) => { ended.push({ id, audio }) }),
    onUnconfirmed: vi.fn<(durationS: number, peakProb: number) => void>(),
    onFrame: vi.fn<(chunk: Float32Array) => void>(),
  } satisfies MicLoopCallbacks
  return { cb, ended }
}

function setup() {
  const vad = fakeVad()
  const smartTurn = { predict: vi.fn(async () => 0) }
  const { cb, ended } = makeCallbacks()
  const loop = new MicLoop(vad as never, smartTurn as never, cb)
  loop.voiceConfig = config
  loop.start()

  /** Pushes one frame, filled with `fill`, carrying the given verdict. */
  async function push(speech: boolean | null, fill = 0, prob = speech ? 0.95 : 0.05): Promise<void> {
    if (speech !== null) vad.verdicts.push({ isSpeech: speech, speechProbability: prob, samples: FRAME } as VadResult)
    deliver!(new Float32Array(FRAME).fill(fill))
    await vi.advanceTimersByTimeAsync(0)
  }
  async function speak(n: number, fill = 1): Promise<void> {
    for (let i = 0; i < n; i++) await push(true, fill)
  }
  async function silence(n: number, fill = 0): Promise<void> {
    for (let i = 0; i < n; i++) await push(false, fill)
  }
  /** Speech until the gate passes: 0.1s + 4 × 0.1s = 0.5s. */
  async function confirm(fill = 1): Promise<string> {
    await speak(5, fill)
    expect(cb.onSpeechConfirmed).toHaveBeenCalled()
    return cb.onSpeechConfirmed.mock.calls.at(-1)![0]
  }
  return { loop, vad, cb, ended, push, speak, silence, confirm }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  detach.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MicLoop — the confidence gate', () => {
  it('speech short of the gate begins an utterance but confirms nothing', async () => {
    const { loop, cb, speak } = setup()
    await speak(4)

    expect(cb.onSpeechBegan).toHaveBeenCalledTimes(1)
    expect(cb.onSpeechConfirmed).not.toHaveBeenCalled()
    expect(loop.micState).toBe('listening')
    expect(loop.utteranceInProgress).toBeNull()
    loop.stop()
  })

  it('speech that reaches the gate confirms once, with a fresh id', async () => {
    const { loop, cb, confirm, speak } = setup()
    const id = await confirm()
    await speak(3)

    expect(cb.onSpeechBegan).toHaveBeenCalledTimes(1)
    expect(cb.onSpeechConfirmed).toHaveBeenCalledTimes(1)
    expect(loop.utteranceInProgress).toBe(id)
    expect(loop.micState).toBe('hearing')
    loop.stop()
  })

  it('long speech below the probability threshold never confirms', async () => {
    const { loop, cb, push } = setup()
    for (let i = 0; i < 10; i++) await push(true, 1, 0.6)

    expect(cb.onSpeechConfirmed).not.toHaveBeenCalled()
    loop.stop()
  })
})

describe('MicLoop — a cough times out unconfirmed', () => {
  it('raw speech that goes quiet past the pause threshold reports onUnconfirmed and nothing else', async () => {
    const { loop, cb, speak, silence } = setup()
    await speak(2)
    await silence(2)

    expect(cb.onUnconfirmed).toHaveBeenCalledTimes(1)
    const [durationS, peak] = cb.onUnconfirmed.mock.calls[0]
    expect(durationS).toBeGreaterThan(0)
    expect(peak).toBeCloseTo(0.95)
    expect(cb.onSpeechConfirmed).not.toHaveBeenCalled()
    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    expect(loop.micState).toBe('idle')

    await vi.advanceTimersByTimeAsync(20000)
    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    loop.stop()
  })

  it('the next speech after a cough begins a new span', async () => {
    const { loop, cb, speak, silence } = setup()
    await speak(2)
    await silence(2)
    await speak(1)

    expect(cb.onSpeechBegan).toHaveBeenCalledTimes(2)
    loop.stop()
  })
})

describe('MicLoop — a hand-off is terminal', () => {
  it('silence past the pause threshold hands off the utterance after the commit delay', async () => {
    const { loop, cb, ended, confirm, silence } = setup()
    const id = await confirm()
    await silence(2)
    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)

    expect(ended).toHaveLength(1)
    expect(ended[0].id).toBe(id)
    expect(ended[0].audio.length).toBeGreaterThan(0)
    expect(loop.utteranceInProgress).toBeNull()
    expect(loop.micState).toBe('idle')
    loop.stop()
  })

  it('speech inside the commit delay cancels the hand-off', async () => {
    const { loop, cb, confirm, silence, speak } = setup()
    await confirm()
    await silence(2)
    await speak(1)
    await vi.advanceTimersByTimeAsync(1000)

    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    loop.stop()
  })

  it('speech after a hand-off is a new utterance that re-earns the gate and gets a new id', async () => {
    const { loop, cb, confirm, silence, speak } = setup()
    const first = await confirm()
    await silence(2)
    await vi.advanceTimersByTimeAsync(100)

    await speak(2)
    expect(cb.onSpeechBegan).toHaveBeenCalledTimes(2)
    expect(cb.onSpeechConfirmed).toHaveBeenCalledTimes(1)

    await speak(5)
    expect(cb.onSpeechConfirmed).toHaveBeenCalledTimes(2)
    const second = cb.onSpeechConfirmed.mock.calls[1][0]
    expect(second).not.toBe(first)
    loop.stop()
  })

  it('commitUtterance() hands off at once, and does nothing when no utterance is being heard', async () => {
    const { loop, cb, ended, confirm, speak } = setup()
    loop.commitUtterance()
    await speak(2)
    loop.commitUtterance()
    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()

    const id = await confirm()
    loop.commitUtterance()
    expect(ended.map((e) => e.id)).toEqual([id])
    expect(loop.micState).toBe('idle')
    loop.stop()
  })
})

describe('MicLoop — a mute pauses a confirmed utterance', () => {
  it('muting while hearing pauses the same utterance, and unmuting resumes it', async () => {
    const { loop, cb, confirm } = setup()
    const id = await confirm()

    loop.muteMic()
    expect(loop.micState).toBe('paused')
    expect(loop.utteranceInProgress).toBe(id)
    expect(detach).not.toHaveBeenCalled()

    loop.unmuteMic()
    expect(loop.micState).toBe('hearing')
    expect(loop.utteranceInProgress).toBe(id)
    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    expect(cb.onUnconfirmed).not.toHaveBeenCalled()
    expect(cb.onSpeechConfirmed).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('a pending commit timer does not fire across a mute', async () => {
    const { loop, cb, confirm, silence } = setup()
    await confirm()
    await silence(2)
    loop.muteMic()
    await vi.advanceTimersByTimeAsync(1000)

    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    loop.stop()
  })

  it('the hand-off carries the audio from before the pause and after it, and none of the audio heard while muted', async () => {
    const { loop, ended, confirm, push, speak, silence } = setup()
    await confirm(1)
    const beforePause = loop['mic']!.getUtteranceAudio().length

    loop.muteMic()
    for (let i = 0; i < 6; i++) await push(null, 9)
    loop.unmuteMic()
    await speak(2, 2)
    await silence(2, 3)
    await vi.advanceTimersByTimeAsync(100)

    expect(ended).toHaveLength(1)
    const audio = ended[0].audio
    expect(audio.length).toBe(beforePause + 4 * FRAME)
    expect(audio.includes(9)).toBe(false)
    expect(audio.includes(1)).toBe(true)
    expect(audio.includes(2)).toBe(true)
    loop.stop()
  })

  it('a second pause on the same utterance keeps the audio from the first', async () => {
    const { loop, ended, confirm, speak } = setup()
    await confirm(1)
    const first = loop['mic']!.getUtteranceAudio().length
    loop.muteMic()
    loop.unmuteMic()
    await speak(2, 2)
    loop.muteMic()
    loop.unmuteMic()
    await speak(1, 3)
    loop.commitUtterance()

    expect(ended[0].audio.length).toBe(first + 3 * FRAME)
    expect([1, 2, 3].every((v) => ended[0].audio.includes(v))).toBe(true)
    loop.stop()
  })

  it('commitPaused() hands off the paused utterance it names, and ignores any other id', async () => {
    const { loop, ended, confirm } = setup()
    const id = await confirm()
    loop.muteMic()

    loop.commitPaused('human-not-this-one')
    expect(ended).toHaveLength(0)

    loop.commitPaused(id)
    expect(ended.map((e) => e.id)).toEqual([id])
    expect(loop.micState).toBe('idle')
    expect(loop.utteranceInProgress).toBeNull()
    loop.stop()
  })

  it('muting unconfirmed speech reports it unconfirmed rather than pausing it', async () => {
    const { loop, cb, speak } = setup()
    await speak(2)
    loop.muteMic()

    expect(cb.onUnconfirmed).toHaveBeenCalledTimes(1)
    expect(loop.micState).toBe('idle')
    loop.stop()
  })

  it('muting with nothing heard reports nothing', () => {
    const { loop, cb } = setup()
    loop.muteMic()

    expect(cb.onUnconfirmed).not.toHaveBeenCalled()
    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    loop.stop()
  })

  it('a mute landing during inference keeps that frame from beginning an utterance', async () => {
    const { loop, vad, cb, push } = setup()
    const release = vad.hold()
    const pushed = push(true)
    loop.muteMic()
    release()
    await pushed
    await vi.advanceTimersByTimeAsync(0)

    expect(cb.onSpeechBegan).not.toHaveBeenCalled()
    loop.stop()
  })
})

describe('MicLoop — silence after a resume', () => {
  it('silence before the first speech after a resume never ends the utterance', async () => {
    const { loop, cb, confirm, silence } = setup()
    await confirm()
    loop.muteMic()
    loop.unmuteMic()
    await silence(10)
    await vi.advanceTimersByTimeAsync(1000)

    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    expect(loop.micState).toBe('hearing')
    loop.stop()
  })

  it('once speech is heard again, silence ends the same utterance', async () => {
    const { loop, ended, confirm, silence, speak } = setup()
    const id = await confirm()
    loop.muteMic()
    loop.unmuteMic()
    await silence(5)
    await speak(1)
    await silence(2)
    await vi.advanceTimersByTimeAsync(100)

    expect(ended.map((e) => e.id)).toEqual([id])
    loop.stop()
  })
})

describe('MicLoop — the safety flush', () => {
  it('hands off an utterance that runs past maxRecordingMs from confirmation', async () => {
    const { loop, ended, confirm } = setup()
    const id = await confirm()
    await vi.advanceTimersByTimeAsync(9999)
    expect(ended).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(ended.map((e) => e.id)).toEqual([id])
    expect(loop.micState).toBe('idle')
    loop.stop()
  })

  it('does not fire during a pause, and re-arms for the full window on resume', async () => {
    const { loop, ended, confirm } = setup()
    const id = await confirm()
    await vi.advanceTimersByTimeAsync(6000)
    loop.muteMic()
    await vi.advanceTimersByTimeAsync(20000)
    expect(ended).toHaveLength(0)

    loop.unmuteMic()
    await vi.advanceTimersByTimeAsync(9999)
    expect(ended).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(ended.map((e) => e.id)).toEqual([id])
    loop.stop()
  })

  it('is disarmed by a hand-off', async () => {
    const { loop, cb, confirm, silence } = setup()
    await confirm()
    await silence(2)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(20000)

    expect(cb.onUtteranceEnded).toHaveBeenCalledTimes(1)
    loop.stop()
  })
})

describe('MicLoop — frames', () => {
  it('acts on every model window in a chunk, not only the last', async () => {
    const { loop, vad, cb } = setup()
    vad.process = async () => [
      { isSpeech: true, speechProbability: 0.95, samples: 512 },
      { isSpeech: false, speechProbability: 0.05, samples: 512 },
    ] as VadResult[]
    deliver!(new Float32Array(1024))
    await vi.advanceTimersByTimeAsync(0)

    expect(cb.onSpeechBegan).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('passes on every captured frame, while VAD is busy and while muted', async () => {
    const { loop, vad, cb } = setup()
    const release = vad.hold()
    deliver!(new Float32Array(FRAME))
    deliver!(new Float32Array(FRAME))
    loop.muteMic()
    deliver!(new Float32Array(FRAME))
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(cb.onFrame).toHaveBeenCalledTimes(3)
    loop.stop()
  })

  it('stop() ends an utterance in progress without handing it off', async () => {
    const { loop, cb, confirm } = setup()
    await confirm()
    loop.stop()
    await vi.advanceTimersByTimeAsync(20000)

    expect(cb.onUtteranceEnded).not.toHaveBeenCalled()
    expect(loop.utteranceInProgress).toBeNull()
    expect(detach).toHaveBeenCalledTimes(1)
  })
})
