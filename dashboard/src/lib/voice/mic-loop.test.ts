import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MicLoop } from './mic-loop'
import type { MicLoopCallbacks } from './mic-loop'

// Mock the heavy ONNX deps so tests run without a real model
vi.mock('./silero-vad', () => {
  return {
    SileroVad: class {
      private ready = false
      reset = vi.fn(() => {})
      isReady = () => this.ready
      async load() { this.ready = true }
      async process() { return null }
      destroy() {}
    },
  }
})

vi.mock('./smart-turn', () => {
  return {
    SmartTurn: class {
      async load() {}
      async predict() { return 0 }
      destroy() {}
    },
  }
})

vi.mock('./mic-capture', () => {
  class MicCapture {
    static instances: MicCapture[] = []
    isInUtterance = false
    stop = vi.fn(() => {})
    clearBuffer = vi.fn(() => { this.isInUtterance = false })
    constructor() { MicCapture.instances.push(this) }
    async start() { /* ignore */ }
    beginUtterance() { this.isInUtterance = true }
    getUtteranceAudio() { return new Float32Array(0) }
    getUtteranceDuration() { return 0 }
    endUtterance() { this.isInUtterance = false }
  }
  return { MicCapture }
})

import { SileroVad } from './silero-vad'
import { SmartTurn } from './smart-turn'
import { MicCapture } from './mic-capture'

interface CallbackOverrides {
  isPlayerPlaying?: () => boolean
  isPlayerPaused?: () => boolean
  getConversationState?: () => { known: boolean; runActive: boolean }
}

// mic-loop no longer commands the playback engine — it reports facts to the
// playback arbiter (playback-arbiter.ts), which decides pause /
// resume / cancel / hold / release / drop. These tests assert on the facts
// mic-loop reports, which is what it now owns; the owner's fact→action
// mapping has its own home in playback-arbiter.ts's comments.
function makeCallbacks(overrides: CallbackOverrides = {}): { cb: MicLoopCallbacks; calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    onState: [], onReady: [], onError: [], onSttEndpointChange: [],
    sendMessage: [], reportSpeechOnset: [], reportCommitFalseAlarm: [],
    reportCommitSend: [], reportNothingToFlush: [], reportUtteranceAbandoned: [],
  }
  const cb: MicLoopCallbacks = {
    onState: (...a) => { calls.onState.push(a) },
    onReady: (...a) => { calls.onReady.push(a) },
    onError: (...a) => { calls.onError.push(a) },
    onSttEndpointChange: (...a) => { calls.onSttEndpointChange.push(a) },
    isPlayerPlaying: overrides.isPlayerPlaying ?? (() => false),
    isPlayerPaused: overrides.isPlayerPaused ?? (() => false),
    getPlayerRemainingSeconds: () => 0,
    getConversationState: overrides.getConversationState ?? (() => ({ known: true, runActive: false })),
    sendMessage: async (...a) => { calls.sendMessage.push(a) },
    reportSpeechOnset: (...a) => { calls.reportSpeechOnset.push(a) },
    reportCommitFalseAlarm: (facts) => { calls.reportCommitFalseAlarm.push([facts]) },
    reportCommitSend: (facts) => { calls.reportCommitSend.push([facts]) },
    reportNothingToFlush: (...a) => { calls.reportNothingToFlush.push(a) },
    reportUtteranceAbandoned: (facts) => { calls.reportUtteranceAbandoned.push([facts]) },
  }
  return { cb, calls }
}

// The mock's static instance registry, typed loosely since the real
// mic-capture.ts module has no such field.
interface MockMicCapture {
  stop: ReturnType<typeof vi.fn>
  clearBuffer: ReturnType<typeof vi.fn>
  isInUtterance: boolean
}
function mockInstances(): MockMicCapture[] {
  return (MicCapture as unknown as { instances: MockMicCapture[] }).instances
}

describe('MicLoop — VAD lifecycle (Bug A)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('start() resets VAD', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')
    expect(vad.reset).toHaveBeenCalled()
    loop.stop()
  })

  it('muteMic() resets VAD', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')
    ;(vad.reset as ReturnType<typeof vi.fn>).mockClear()
    loop.muteMic()
    expect(vad.reset).toHaveBeenCalled()
    loop.stop()
  })

  it('unmuteMic() resets VAD (the bug-A fix)', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')
    loop.muteMic()
    ;(vad.reset as ReturnType<typeof vi.fn>).mockClear()
    loop.unmuteMic()
    expect(vad.reset).toHaveBeenCalled()
    loop.stop()
  })

  it('stop() resets VAD', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')
    ;(vad.reset as ReturnType<typeof vi.fn>).mockClear()
    loop.stop()
    expect(vad.reset).toHaveBeenCalled()
  })
})

describe('MicLoop — mute is a software gate, not a stream release (phase 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInstances().length = 0
  })

  it('muteMic() keeps the capture open', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')
    const [instance] = mockInstances()

    loop.muteMic()

    expect(instance.stop).not.toHaveBeenCalled()
    expect(instance.clearBuffer).toHaveBeenCalled()
    loop.stop()
  })

  it('unmuteMic() reuses the capture', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')
    loop.muteMic()
    const countAfterMute = mockInstances().length
    const [instance] = mockInstances()
    instance.clearBuffer.mockClear()

    loop.unmuteMic()

    expect(mockInstances().length).toBe(countAfterMute) // no new MicCapture
    expect(instance.stop).not.toHaveBeenCalled()
    expect(instance.clearBuffer).toHaveBeenCalled()
    loop.stop()
  })

  it('muteMic() mid-utterance reports the utterance abandoned', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb, calls } = makeCallbacks({ isPlayerPaused: () => true })
    interface MuteInternals {
      state: string
      hadPausedAudio: boolean
      start(endpoint: string): void
      muteMic(): void
      stop(): void
    }
    const loop = new MicLoop(vad, new SmartTurn(), cb) as unknown as MuteInternals
    loop.start('http://stt')
    loop.state = 'hearing'
    loop.hadPausedAudio = true

    loop.muteMic()

    expect(calls.reportUtteranceAbandoned).toEqual([[{ hadPausedAudio: true, playerPaused: true }]])
    loop.stop()
  })

  it('muteMic() from idle reports nothing to abandon', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb, calls } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt') // state: idle

    loop.muteMic()

    expect(calls.reportUtteranceAbandoned).toEqual([])
    loop.stop()
  })
})

describe('MicLoop — VAD readiness gate (Bug C)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('processChunk drops chunks when VAD is not ready', async () => {
    const vad = new SileroVad()
    // do NOT call load() — vad stays not ready
    const { cb } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')

    // Reach into the private processChunk via type assertion
    const lp = loop as unknown as { processChunk(c: Float32Array): Promise<void> }
    await lp.processChunk(new Float32Array(512))
    // No state callback because VAD wasn't ready and chunk was dropped
    // (state stays 'idle' because nothing transitioned)
    loop.stop()
  })

  it('publishes ready=true when VAD is ready at start', async () => {
    const vad = new SileroVad()
    await vad.load()
    const { cb, calls } = makeCallbacks()
    const loop = new MicLoop(vad, new SmartTurn(), cb)
    loop.start('http://stt')
    expect(calls.onReady).toEqual([[true]])
    loop.stop()
  })
})

// Reaches into private state via type assertion, same pattern as the
// processChunk tests above — cleanupWithSend's branching is ground-truth
// driven now (getConversationState), not derivable by driving the full
// VAD/commit pipeline with fake audio.
interface MicLoopInternals {
  interruptionHadAudioLeft: boolean
  hadPausedAudio: boolean
  cleanupWithSend(transcript: string, force?: boolean): Promise<void>
}

function makeLoop(cb: MicLoopCallbacks): MicLoopInternals {
  return new MicLoop(new SileroVad(), new SmartTurn(), cb) as unknown as MicLoopInternals
}

describe('MicLoop — cleanupWithSend three-branch behavior', () => {
  it('runActive: true -> reports clearAudio, sends with interrupted-working, no old marker', async () => {
    const { cb, calls } = makeCallbacks({
      isPlayerPlaying: () => true,
      getConversationState: () => ({ known: true, runActive: true }),
    })
    const loop = makeLoop(cb)
    loop.interruptionHadAudioLeft = false // runActive takes priority regardless
    await loop.cleanupWithSend('hello')

    expect(calls.reportCommitSend).toEqual([[{ playerPlaying: true, playerPaused: false, clearAudio: true }]])
    expect(calls.sendMessage).toEqual([['hello', { annotation: 'interrupted-working' }]])
  })

  it('runActive: false, interruptionHadAudioLeft: true -> reports clearAudio, sends with interrupted-speaking', async () => {
    const { cb, calls } = makeCallbacks({
      isPlayerPlaying: () => true,
      getConversationState: () => ({ known: true, runActive: false }),
    })
    const loop = makeLoop(cb)
    loop.interruptionHadAudioLeft = true
    await loop.cleanupWithSend('hello')

    expect(calls.reportCommitSend).toEqual([[{ playerPlaying: true, playerPaused: false, clearAudio: true }]])
    expect(calls.sendMessage).toEqual([['hello', { annotation: 'interrupted-speaking' }]])
  })

  it('runActive: false, no interrupt, hadPausedAudio: true -> reports clearAudio (unchanged), plain send', async () => {
    const { cb, calls } = makeCallbacks({
      isPlayerPaused: () => true,
      getConversationState: () => ({ known: true, runActive: false }),
    })
    const loop = makeLoop(cb)
    loop.interruptionHadAudioLeft = false
    loop.hadPausedAudio = true
    await loop.cleanupWithSend('hello')

    expect(calls.reportCommitSend).toEqual([[{ playerPlaying: false, playerPaused: true, clearAudio: true }]])
    expect(calls.sendMessage).toEqual([['hello']])
  })

  it('runActive: false, no interrupt, no paused audio -> reports !clearAudio (release), plain send', async () => {
    const { cb, calls } = makeCallbacks({
      getConversationState: () => ({ known: true, runActive: false }),
    })
    const loop = makeLoop(cb)
    await loop.cleanupWithSend('hello')

    expect(calls.reportCommitSend).toEqual([[{ playerPlaying: false, playerPaused: false, clearAudio: false }]])
    expect(calls.sendMessage).toEqual([['hello']])
  })

  it('known: false -> plain send regardless of runActive/interrupt state, no local cleanup calls', async () => {
    const { cb, calls } = makeCallbacks({
      getConversationState: () => ({ known: false, runActive: true }),
    })
    const loop = makeLoop(cb)
    loop.interruptionHadAudioLeft = true
    await loop.cleanupWithSend('hello')

    expect(calls.sendMessage).toEqual([['hello']])
    expect(calls.reportCommitSend.length).toBe(0)
  })

  it('the old interruption-marker text is gone from every branch', async () => {
    const scenarios: Array<{ runActive: boolean; interrupt: boolean; known: boolean }> = [
      { runActive: true, interrupt: false, known: true },
      { runActive: false, interrupt: true, known: true },
      { runActive: false, interrupt: false, known: true },
      { runActive: true, interrupt: true, known: false },
    ]
    for (const s of scenarios) {
      const { cb, calls } = makeCallbacks({ getConversationState: () => ({ known: s.known, runActive: s.runActive }) })
      const loop = makeLoop(cb)
      loop.interruptionHadAudioLeft = s.interrupt
      await loop.cleanupWithSend('plain transcript')
      const [sentText] = calls.sendMessage[0]
      expect(sentText).toBe('plain transcript')
      expect(String(sentText)).not.toContain('the user interrupted your previous response')
    }
  })
})
