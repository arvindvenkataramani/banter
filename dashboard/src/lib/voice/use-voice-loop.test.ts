import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { PlaybackEngine } from './playback-engine'
import { resetMutes } from './store/mute-store'

// Mount-time model loader runs unconditionally (even with enabled: false), so
// the heavy ONNX deps need mocking or the hook would attempt real fetches.
vi.mock('./silero-vad', () => ({
  SileroVad: class {
    async load() { /* resolves immediately */ }
    destroy() {}
  },
}))

vi.mock('./smart-turn', () => ({
  SmartTurn: class {
    async load() { /* resolves immediately */ }
    destroy() {}
  },
}))

const { useVoiceLoop } = await import('./use-voice-loop')

function mountHook() {
  return renderHook(() => useVoiceLoop({
    enabled: false,
    sttEndpoint: null,
    voiceConfig: null,
    session: null,
    ttsEndpoint: null,
    ttsSelection: null,
  }))
}

// These tests spy on PlaybackEngine.prototype.resume/pause and assert on
// whether the arbiter *intended* to resume or pause — not on whether audio
// was genuinely paused under jsdom's fake <audio> element. resume() is
// self-guarded on its own internal `userPaused` flag (see playback-engine.ts),
// so the spy fires on every call regardless of that internal state; no
// paused-audio fixture is needed to observe it.
describe('useVoiceLoop mute coupling', () => {
  let resumeSpy: ReturnType<typeof vi.spyOn>
  let pauseSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    localStorage.clear()
    resetMutes()
    // Spy on the prototype: enabled:false disposes any prior engine on mount,
    // and applySpeech builds a fresh instance via getPlaybackEngine() — an
    // instance-level spy would be watching a discarded object.
    resumeSpy = vi.spyOn(PlaybackEngine.prototype, 'resume')
    pauseSpy = vi.spyOn(PlaybackEngine.prototype, 'pause')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('LINKED + mic: both flip together, stays LINKED', () => {
    const { result } = mountHook()
    expect(result.current.muteLinked).toBe(true)
    expect(result.current.micMuted).toBe(false)
    expect(result.current.speechMuted).toBe(false)

    act(() => { result.current.toggleMuteAll() })

    expect(result.current.micMuted).toBe(true)
    expect(result.current.speechMuted).toBe(true)
    expect(result.current.muteLinked).toBe(true)
  })

  it('LINKED + speech: speech flips alone, becomes UNLINKED', () => {
    const { result } = mountHook()

    act(() => { result.current.toggleSpeechMuted() })

    expect(result.current.speechMuted).toBe(true)
    expect(result.current.micMuted).toBe(false)
    expect(result.current.muteLinked).toBe(false)
  })

  it('UNLINKED + mic: mic flips alone, speech untouched, stays UNLINKED', () => {
    const { result } = mountHook()
    // Reach UNLINKED with mic live, speech muted.
    act(() => { result.current.toggleSpeechMuted() })
    expect(result.current.muteLinked).toBe(false)

    act(() => { result.current.toggleMuteAll() })

    expect(result.current.micMuted).toBe(true)
    expect(result.current.speechMuted).toBe(true) // untouched by the mic toggle
    expect(result.current.muteLinked).toBe(false)
  })

  it('UNLINKED + speech: speech flips alone, stays UNLINKED', () => {
    const { result } = mountHook()
    // Reach UNLINKED with mic muted, speech muted (both muted, unlinked).
    act(() => { result.current.toggleSpeechMuted() }) // -> speech muted, UNLINKED
    act(() => { result.current.toggleMuteAll() }) // -> mic muted too, still UNLINKED
    expect(result.current.micMuted).toBe(true)
    expect(result.current.speechMuted).toBe(true)
    expect(result.current.muteLinked).toBe(false)

    act(() => { result.current.toggleSpeechMuted() })

    expect(result.current.speechMuted).toBe(false)
    expect(result.current.micMuted).toBe(true) // untouched, still muted
    expect(result.current.muteLinked).toBe(false) // mic still muted, so no relink
  })

  it('UNLINKED + chain (relinkMutes): speech adopts mic value, becomes LINKED', () => {
    const { result } = mountHook()
    // UNLINKED, mic muted, speech live.
    act(() => { result.current.toggleSpeechMuted() }) // speech muted, UNLINKED
    act(() => { result.current.toggleMuteAll() }) // mic muted too
    act(() => { result.current.toggleSpeechMuted() }) // speech live again, mic still muted, UNLINKED
    expect(result.current.micMuted).toBe(true)
    expect(result.current.speechMuted).toBe(false)
    expect(result.current.muteLinked).toBe(false)

    act(() => { result.current.relinkMutes() })

    expect(result.current.speechMuted).toBe(true) // adopts mic's muted state
    expect(result.current.micMuted).toBe(true)
    expect(result.current.muteLinked).toBe(true)
  })

  it('† UNLINKED + mic landing on both live returns to LINKED', () => {
    const { result } = mountHook()
    // UNLINKED, mic muted, speech live.
    act(() => { result.current.toggleSpeechMuted() }) // speech muted, UNLINKED
    act(() => { result.current.toggleMuteAll() }) // mic muted too, both muted, UNLINKED
    act(() => { result.current.toggleSpeechMuted() }) // speech live, mic muted, UNLINKED
    expect(result.current.muteLinked).toBe(false)

    act(() => { result.current.toggleMuteAll() }) // mic live too -> both live

    expect(result.current.micMuted).toBe(false)
    expect(result.current.speechMuted).toBe(false)
    expect(result.current.muteLinked).toBe(true)
  })

  it('† UNLINKED + speech landing on both live returns to LINKED', () => {
    const { result } = mountHook()
    // UNLINKED, mic live, speech muted.
    act(() => { result.current.toggleSpeechMuted() }) // speech muted, mic live, UNLINKED
    expect(result.current.muteLinked).toBe(false)
    expect(result.current.micMuted).toBe(false)

    act(() => { result.current.toggleSpeechMuted() }) // speech live too -> both live

    expect(result.current.micMuted).toBe(false)
    expect(result.current.speechMuted).toBe(false)
    expect(result.current.muteLinked).toBe(true)
  })

  it('unmute-all while linked resumes playback', () => {
    const { result } = mountHook()
    act(() => { result.current.toggleMuteAll() }) // mute both, still LINKED
    expect(result.current.muteLinked).toBe(true)
    resumeSpy.mockClear()

    act(() => { result.current.toggleMuteAll() }) // unmute both -> everything live

    expect(resumeSpy).toHaveBeenCalled()
  })

  it('unmuting speech resumes even while the mic stays muted', () => {
    const { result } = mountHook()
    // UNLINKED with mic muted, speech muted.
    act(() => { result.current.toggleSpeechMuted() }) // speech muted, UNLINKED
    act(() => { result.current.toggleMuteAll() }) // mic muted too, UNLINKED
    expect(result.current.muteLinked).toBe(false)
    resumeSpy.mockClear()

    act(() => { result.current.toggleSpeechMuted() }) // speech live, mic still muted

    // Speech mute is a playback control on its own: resume follows speech,
    // not "everything live". The mic staying muted doesn't hold this back.
    expect(resumeSpy).toHaveBeenCalled()
    expect(result.current.muteLinked).toBe(false) // mic still muted, no relink
  })

  it('unmuting the mic does not resume playback', () => {
    const { result } = mountHook()
    // UNLINKED with mic muted, speech live.
    act(() => { result.current.toggleSpeechMuted() }) // speech muted, UNLINKED
    act(() => { result.current.toggleMuteAll() }) // mic muted too, UNLINKED
    act(() => { result.current.toggleSpeechMuted() }) // speech live again, mic muted, UNLINKED
    expect(result.current.micMuted).toBe(true)
    expect(result.current.speechMuted).toBe(false)
    expect(result.current.muteLinked).toBe(false)
    resumeSpy.mockClear()

    act(() => { result.current.toggleMuteAll() }) // unmute mic -> everything live

    expect(result.current.micMuted).toBe(false)
    // The mic is not a playback control: it never touches resume, in either
    // direction, even when unmuting it happens to land on everything live.
    expect(resumeSpy).not.toHaveBeenCalled()
  })

  it('muting the mic alone does not pause playback', () => {
    const { result } = mountHook()
    act(() => { result.current.toggleSpeechMuted() }) // speech muted, mic live, UNLINKED
    expect(result.current.muteLinked).toBe(false)
    pauseSpy.mockClear()

    act(() => { result.current.toggleMuteAll() }) // mic muted too — mic-only, UNLINKED

    // The mic never touches playback: muting it alone is not a pause command.
    expect(pauseSpy).not.toHaveBeenCalled()
  })

  it('chain-relink from (mic live, speech muted) resumes playback', () => {
    const { result } = mountHook()
    act(() => { result.current.toggleSpeechMuted() }) // speech muted, mic live, UNLINKED
    expect(result.current.micMuted).toBe(false)
    expect(result.current.speechMuted).toBe(true)
    resumeSpy.mockClear()

    act(() => { result.current.relinkMutes() })

    expect(result.current.speechMuted).toBe(false) // adopts mic's live state
    expect(result.current.muteLinked).toBe(true)
    expect(resumeSpy).toHaveBeenCalled()
  })

  it('always mounts live and linked, ignoring stale localStorage mute values', () => {
    localStorage.setItem('voice:mic-muted', 'true')
    localStorage.setItem('voice:speech-muted', 'true')

    const { result } = mountHook()

    expect(result.current.micMuted).toBe(false)
    expect(result.current.speechMuted).toBe(false)
    expect(result.current.muteLinked).toBe(true)
  })
})
