import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MicLoopCallbacks, MicState } from './mic-loop'
import type { SttTransport } from './stt-transport'
import type { Report, Utterance } from '../turn-manager'

// The loop is faked with the state it exposes to HumanVoice — `micState`,
// `utteranceInProgress`, `micMuted` — kept the way the real loop keeps them
// (docs/components/voice-turn-taking.md, MicLoop), and driven through
// its callbacks. mic-loop.test.ts covers the loop itself.
class FakeMicLoop {
  static last: FakeMicLoop
  cb: MicLoopCallbacks
  micState: MicState = 'idle'
  utteranceInProgress: string | null = null
  micMuted = false
  voiceConfig: unknown = null
  start = vi.fn()
  stop = vi.fn(() => { this.micState = 'idle'; this.utteranceInProgress = null })
  constructor(_vad: unknown, _smartTurn: unknown, cb: MicLoopCallbacks) {
    this.cb = cb
    FakeMicLoop.last = this
  }
  muteMic = vi.fn(() => {
    this.micMuted = true
    if (this.micState === 'hearing' && this.utteranceInProgress !== null) {
      this.micState = 'paused'
      return
    }
    const wasListening = this.micState === 'listening'
    this.micState = 'idle'
    if (wasListening) this.cb.onUnconfirmed(0.2, 0.5)
  })
  unmuteMic = vi.fn(() => {
    this.micMuted = false
    if (this.micState === 'paused') this.micState = 'hearing'
  })
  commitUtterance = vi.fn(() => { if (this.micState === 'hearing') this.handOff() })
  commitPaused = vi.fn((id: string) => {
    if (this.micState === 'paused' && this.utteranceInProgress === id) this.handOff()
  })

  // Test drivers: what the real loop does when VAD and its timers decide.
  began(): void { this.micState = 'listening'; this.cb.onSpeechBegan() }
  confirm(id: string): void {
    if (this.micState !== 'listening') this.began()
    this.micState = 'hearing'
    this.utteranceInProgress = id
    this.cb.onSpeechConfirmed(id)
  }
  unconfirmed(): void { this.micState = 'idle'; this.cb.onUnconfirmed(0.2, 0.5) }
  handOff(): void {
    const id = this.utteranceInProgress!
    this.micState = 'idle'
    this.utteranceInProgress = null
    this.cb.onUtteranceEnded(id, new Float32Array(160))
  }
}

vi.mock('./mic-loop', () => ({ MicLoop: FakeMicLoop }))

vi.mock('../store/turn-manager-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/turn-manager-store')>()
  return { ...actual, report: vi.fn(actual.report) }
})

const { HumanVoice } = await import('./human-voice')
const { report, resetTurnManager, reportComposerFocus } = await import('../store/turn-manager-store')
const { useTranscriptStore } = await import('../store/transcript-store')

interface Commit {
  resolve: (text: string) => void
  reject: (err: unknown) => void
}

function fakeTransport() {
  const commits: Commit[] = []
  const transport = {
    onFrame: vi.fn(),
    commit: vi.fn(() => new Promise<string>((resolve, reject) => { commits.push({ resolve, reject }) })),
    discard: vi.fn(() => Promise.resolve()),
    setSending: vi.fn(),
    close: vi.fn(),
  } satisfies SttTransport
  return { transport, commits }
}

/** Every utterance HumanVoice has reported to the floor, in order. */
function humanReports(): Array<Utterance<'human'>> {
  return vi.mocked(report).mock.calls
    .map(([r]) => r)
    .filter((r): r is Extract<Report, { actor: 'human' }> => r.actor === 'human')
    .map((r) => r.utterance)
    .filter((u): u is Utterance<'human'> => u !== null)
}

function endedReports(): Array<Utterance<'human'>> {
  return humanReports().filter((u) => u.phase === 'ended')
}

function setControls(micMuted: boolean): void {
  report({ actor: 'controls', controls: { micMuted, speechMuted: false, autoMuted: false } })
}

let hv: InstanceType<typeof HumanVoice>
let loop: FakeMicLoop
let transport: ReturnType<typeof fakeTransport>['transport']
let commits: Commit[]
let onError: ReturnType<typeof vi.fn<(msg: string) => void>>

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetTurnManager()
  useTranscriptStore.setState({ settled: '', pending: [] })
  vi.mocked(report).mockClear()
  onError = vi.fn()
  hv = new HumanVoice({} as never, {} as never, { onError })
  loop = FakeMicLoop.last
  ;({ transport, commits } = fakeTransport())
  hv.transport = transport
  hv.start()
})

afterEach(async () => {
  const stopping = hv.stop()
  await vi.advanceTimersByTimeAsync(5000)
  await stopping
  vi.useRealTimers()
})

describe('HumanVoice — an utterance from confirmation to its words', () => {
  it('reports hearing, transcribing, and ended with the cleaned transcript, and settles the words', async () => {
    loop.confirm('a')
    expect(useTranscriptStore.getState().pending.map((p) => p.id)).toEqual(['a'])

    loop.handOff()
    expect(transport.commit).toHaveBeenCalledTimes(1)
    commits[0].resolve(' um hello  there ')
    await settle()

    expect(humanReports().map((u) => u.phase)).toEqual(['hearing', 'transcribing', 'ended'])
    expect(endedReports()[0]).toMatchObject({ id: 'a', outcome: 'transcribed', transcript: 'hello there' })
    expect(useTranscriptStore.getState()).toMatchObject({ settled: 'hello there', pending: [] })
  })

  it('an empty transcript drops the entry and ends rejected empty', async () => {
    loop.confirm('a')
    loop.handOff()
    commits[0].resolve('uh.')
    await settle()

    expect(endedReports()[0]).toMatchObject({ id: 'a', outcome: { rejected: 'empty' } })
    expect(useTranscriptStore.getState()).toMatchObject({ settled: '', pending: [] })
  })

  it('a failed commit keeps the words shown, ends rejected failed, and surfaces the error', async () => {
    loop.confirm('a')
    hv.receivePartial('half a thought')
    loop.handOff()
    commits[0].reject(new Error('boom'))
    await settle()

    expect(endedReports()[0]).toMatchObject({ id: 'a', outcome: { rejected: 'failed' } })
    expect(useTranscriptStore.getState()).toMatchObject({ settled: 'half a thought', pending: [] })
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('a commit failed by the transport closing surfaces no error', async () => {
    loop.confirm('a')
    loop.handOff()
    const closed = new Error('closed')
    closed.name = 'SttTransportClosed'
    commits[0].reject(closed)
    await settle()

    expect(endedReports()[0]).toMatchObject({ id: 'a', outcome: { rejected: 'failed' } })
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('HumanVoice — reports held while unconfirmed speech is in progress', () => {
  it('holds a transcript that returns during unconfirmed speech, and releases it after the next hearing', async () => {
    loop.confirm('a')
    loop.handOff()
    loop.began()
    commits[0].resolve('first')
    await settle()

    // The words are on screen; the turn is not closed.
    expect(useTranscriptStore.getState().settled).toBe('first')
    expect(endedReports()).toEqual([])

    loop.confirm('b')
    const tail = humanReports().slice(-2)
    expect(tail[0]).toMatchObject({ id: 'b', phase: 'hearing' })
    expect(tail[1]).toMatchObject({ id: 'a', phase: 'ended', outcome: 'transcribed', transcript: 'first' })
  })

  it('releases held reports when the speech goes unconfirmed, with no hearing before them, and discards on the transport', async () => {
    loop.confirm('a')
    loop.handOff()
    loop.began()
    commits[0].resolve('first')
    await settle()
    const before = humanReports().length

    loop.unconfirmed()

    expect(humanReports().slice(before)).toEqual([
      expect.objectContaining({ id: 'a', phase: 'ended', outcome: 'transcribed' }),
    ])
    expect(transport.discard).toHaveBeenCalledTimes(1)
  })

  it('releases several held reports in the order they were held', async () => {
    loop.confirm('a')
    loop.handOff()
    loop.confirm('b')
    loop.handOff()
    loop.began()
    commits[1].resolve('second')
    await settle()
    commits[0].resolve('first')
    await settle()
    expect(endedReports()).toEqual([])

    loop.confirm('c')

    expect(endedReports().map((u) => u.id)).toEqual(['b', 'a'])
    expect(useTranscriptStore.getState().settled).toBe('first second')
  })

  it('a report that returns after the speech was confirmed goes out at once', async () => {
    loop.confirm('a')
    loop.handOff()
    loop.confirm('b')
    commits[0].resolve('first')
    await settle()

    expect(endedReports().map((u) => u.id)).toEqual(['a'])
  })
})

describe('HumanVoice — stop()', () => {
  it('commits the utterance being heard and waits for its transcript within settleOnStopMs', async () => {
    loop.voiceConfig = { stt: { settleOnStopMs: 1000 } }
    loop.confirm('a')
    let stopped = false
    const stopping = hv.stop().then(() => { stopped = true })

    expect(transport.commit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(stopped).toBe(false)

    commits[0].resolve('last words')
    await stopping

    expect(useTranscriptStore.getState()).toMatchObject({ settled: 'last words', pending: [] })
    expect(endedReports()[0]).toMatchObject({ id: 'a', outcome: 'transcribed', transcript: 'last words' })
  })

  it('commits an utterance held paused', async () => {
    loop.confirm('a')
    setControls(true)
    expect(loop.micState).toBe('paused')

    const stopping = hv.stop()
    expect(loop.commitPaused).toHaveBeenCalledWith('a')
    expect(transport.commit).toHaveBeenCalledTimes(1)
    commits[0].resolve('paused words')
    await stopping

    expect(useTranscriptStore.getState().settled).toBe('paused words')
  })

  it('past settleOnStopMs, keeps the words shown, and a late transcript writes nothing more', async () => {
    loop.voiceConfig = { stt: { settleOnStopMs: 1000 } }
    loop.confirm('a')
    hv.receivePartial('what was visible')
    const stopping = hv.stop()
    await vi.advanceTimersByTimeAsync(1000)
    await stopping

    expect(useTranscriptStore.getState()).toMatchObject({ settled: 'what was visible', pending: [] })
    const reportsAtStop = humanReports().length

    commits[0].resolve('what was visible and then some')
    await settle()

    expect(useTranscriptStore.getState()).toMatchObject({ settled: 'what was visible', pending: [] })
    expect(humanReports().length).toBe(reportsAtStop)
  })

  it('releases a held report', async () => {
    loop.confirm('a')
    loop.handOff()
    loop.began()
    commits[0].resolve('first')
    await settle()
    expect(endedReports()).toEqual([])

    await hv.stop()

    expect(endedReports()).toEqual([expect.objectContaining({ id: 'a', outcome: 'transcribed' })])
  })
})

describe('HumanVoice — a reconnect cuts the utterance under way', () => {
  it('a confirmed utterance cut by the swap ends abandoned, its words before and after the swap in the transcript', async () => {
    loop.confirm('a')
    hv.receivePartial('hello')
    const next = fakeTransport()

    expect(hv.replaceTransport(next.transport)).toBe(true)
    expect(next.transport.setSending).toHaveBeenCalledWith(true)

    hv.receivePartial('wor')
    expect(useTranscriptStore.getState().pending[0].text).toBe('hello wor')

    loop.handOff()
    expect(next.transport.commit).toHaveBeenCalledTimes(1)
    next.commits[0].resolve('world')
    await settle()

    expect(useTranscriptStore.getState()).toMatchObject({ settled: 'hello world', pending: [] })
    expect(endedReports()[0]).toMatchObject({ id: 'a', outcome: 'abandoned' })
  })

  it('unconfirmed speech under way at the swap is cut once it confirms', async () => {
    loop.began()
    const next = fakeTransport()
    expect(hv.replaceTransport(next.transport)).toBe(false)

    loop.confirm('b')
    loop.handOff()
    next.commits[0].resolve('the rest')
    await settle()

    expect(endedReports()[0]).toMatchObject({ id: 'b', outcome: 'abandoned' })
    expect(useTranscriptStore.getState().settled).toBe('the rest')
  })

  it('a swap while muted keeps the new transport from sending', () => {
    setControls(true)
    const next = fakeTransport()
    hv.replaceTransport(next.transport)

    expect(next.transport.setSending).toHaveBeenCalledWith(false)
  })
})

describe('HumanVoice — mute reconciliation', () => {
  it('a mute while hearing pauses the utterance, and an unmute resumes it', () => {
    loop.voiceConfig = { stt: { pauseFlushMs: 800 } }
    loop.confirm('a')
    hv.receivePartial('so the thing')

    setControls(true)
    expect(loop.muteMic).toHaveBeenCalledTimes(1)
    expect(transport.setSending).toHaveBeenLastCalledWith(false, 800)
    expect(humanReports().at(-1)).toMatchObject({ id: 'a', phase: 'paused' })
    expect(useTranscriptStore.getState().pending[0]).toMatchObject({ id: 'a', text: 'so the thing', paused: true })

    setControls(false)
    expect(loop.unmuteMic).toHaveBeenCalledTimes(1)
    expect(transport.setSending).toHaveBeenLastCalledWith(true)
    expect(humanReports().at(-1)).toMatchObject({ id: 'a', phase: 'hearing' })
    expect(useTranscriptStore.getState().pending[0]).toMatchObject({ id: 'a', text: 'so the thing', paused: false })
  })

  it('a mute with nothing being heard stops sending with no flush and reports nothing', () => {
    setControls(true)

    expect(loop.muteMic).toHaveBeenCalledTimes(1)
    expect(transport.setSending).toHaveBeenLastCalledWith(false, 0)
    expect(humanReports()).toEqual([])
  })

  it('a mute does not redirect a commit already outstanding', async () => {
    loop.confirm('a')
    loop.handOff()
    setControls(true)
    commits[0].resolve('words')
    await settle()

    expect(endedReports()[0]).toMatchObject({ id: 'a', outcome: 'transcribed', transcript: 'words' })
  })
})

describe('HumanVoice — composer focus settles a paused utterance', () => {
  it('focusing the composer commits the utterance a mute paused', () => {
    loop.confirm('a')
    setControls(true)
    reportComposerFocus(true)

    expect(loop.commitPaused).toHaveBeenCalledWith('a')
    expect(humanReports().at(-1)).toMatchObject({ id: 'a', phase: 'transcribing' })
  })

  it('a mute landing while the composer is focused commits the utterance it pauses', () => {
    loop.confirm('a')
    reportComposerFocus(true)
    expect(transport.commit).not.toHaveBeenCalled()

    setControls(true)

    expect(transport.commit).toHaveBeenCalledTimes(1)
    expect(loop.micState).toBe('idle')
  })

  it('focus with the utterance still being heard commits nothing', () => {
    loop.confirm('a')
    reportComposerFocus(true)

    expect(loop.commitPaused).not.toHaveBeenCalled()
    expect(transport.commit).not.toHaveBeenCalled()
  })
})
