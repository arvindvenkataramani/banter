import { describe, expect, it } from 'vitest'
import { loadVoiceSelection, type VoiceConfig } from '@platform/voice-engine/voice-config'
import {
  buildPatch, chunkingView, editChunking, resetChunking, resetTuning, roster, seedDraft, setModel, setPreferStreaming, setProvider, setSaveMicSamples, setScope,
  setSpeed, setSttService, setTakeover, setTuning, setVoice, TUNING_FIELDS, type Draft,
} from './voice-settings-model'

const SPEECH = { api: 'openai.audio.speech' }

// A voice config with two TTS providers (the second one's first model is not realtime), three STT options, chunking options, a stored
// preference for another model, vad and turn-taking values with a curve, and mic samples off. Providers and options carry
// `provides` and `models`, as GET /api/voice serves them.
const CONFIG = ({
  enabled: true,
  takeover: 'ask',
  tts: {
    models: [
      { id: 'a-one', name: 'A One', canClone: false, chunking: { mode: 'greedy', minWords: 4, maxWords: 50 } },
      { id: 'a-two', name: 'A Two', canClone: false },
      { id: 'a-batch', name: 'A Batch', canClone: false },
      { id: 'b-batch', name: 'B Batch', canClone: false },
      { id: 'b-live', name: 'B Live', canClone: false },
    ],
    providers: [
      {
        serviceId: 'tts-a',
        name: 'Provider A',
        provides: [SPEECH],
        models: { loading: 'none' },
        serves: [{ model: 'a-one', realtime: true }, { model: 'a-two', realtime: true }, { model: 'a-batch' }],
      },
      {
        serviceId: 'tts-b',
        provides: [SPEECH],
        models: { loading: 'none' },
        serves: [{ model: 'b-batch' }, { model: 'b-live', realtime: true }],
      },
    ],
    voices: [
      { id: 'a1', name: 'A1', renderings: [{ model: 'a-one', method: 'preset' }] },
      { id: 'a2', name: 'A2', renderings: [{ model: 'a-one', method: 'preset' }] },
      { id: 'b1', name: 'B1', renderings: [{ model: 'a-two', method: 'preset' }] },
      { id: 'c1', name: 'C1', renderings: [{ model: 'a-batch', method: 'preset' }] },
      { id: 'd1', name: 'D1', renderings: [{ model: 'b-batch', method: 'preset' }] },
      { id: 'e1', name: 'E1', renderings: [{ model: 'b-live', method: 'preset' }] },
      { id: 'e2', name: 'E2', renderings: [{ model: 'b-live', method: 'preset' }] },
    ],
    selection: { serviceId: 'tts-a', model: 'a-one', voice: 'a1', speed: 1.2, resolution: { model: 'a-one', voice: { name: 'a1' } } },
    options: { chunkStrategy: 'sentence', minChunkWords: 3, maxChunkWords: 40 },
    modelPrefs: { 'tts-a': { 'a-two': { chunking: { mode: 'paragraph' } } } },
    settingsScope: 'per-model',
  },
  stt: {
    serviceId: 'stt-a',
    model: 'stt-model-1',
    options: [
      { serviceId: 'stt-a', name: 'STT A', provides: [{ api: 'openai.audio.transcriptions' }], models: { loading: 'none' }, serves: [{ model: 'stt-model-1', key: 'stt-model-1' }] },
      { serviceId: 'stt-b', name: 'STT B', provides: [{ api: 'fluid.stt.stream' }], models: { loading: 'none' }, serves: [{ model: 'stt-model-1', key: 'stt-model-1' }] },
      { serviceId: 'stt-c', name: 'STT C', provides: [{ api: 'fluid.stt.stream', omits: ['parameter:session'] }], models: { loading: 'none' }, serves: [{ model: 'stt-model-1', key: 'stt-model-1' }] },
    ],
    // A streaming model, so the switch condition (the selected streaming provision) can hold.
    models: [{ id: 'stt-model-1', name: 'STT model', kind: 'streaming' }],
    vad: { minSpeechDurationS: 0.5 },
    turnTaking: { pauseThresholdMs: 700, commitMinDelayMs: 200, curve: { type: 'power', exponent: 2 } },
  },
  debug: { saveMicSamples: false },
}) as unknown as VoiceConfig

const draftOf = (config: VoiceConfig = CONFIG): Draft =>
  seedDraft(config, loadVoiceSelection(config)!)

const SELECTION = { serviceId: 'tts-a', model: 'a-one', voice: 'a1', speed: 1.2 }

describe('seeding', () => {
  it('the draft starts from the config\'s selection, STT service, take-over, mic samples, scope, chunking and tuning; take-over defaults to ask', () => {
    expect(draftOf()).toMatchObject({
      sttServiceId: 'stt-a',
      ttsServiceId: 'tts-a',
      ttsModel: 'a-one',
      ttsVoice: 'a1',
      ttsSpeed: 1.2,
      takeover: 'ask',
      saveMicSamples: false,
      scope: 'per-model',
      global: { mode: 'sentence', minWords: 3, maxWords: 40 },
    })
    expect(draftOf().tuning).toEqual({ minSpeechDurationS: 0.5, pauseThresholdMs: 700, commitMinDelayMs: 200 })
    const bare = draftOf({ ...CONFIG, takeover: undefined, debug: undefined })
    expect(bare).toMatchObject({ takeover: 'ask', saveMicSamples: false, preferStreaming: false })
    expect(draftOf({ ...CONFIG, stt: { ...CONFIG.stt, preferStreaming: true } }).preferStreaming).toBe(true)
  })
})

describe('rosters and cascades', () => {
  it('the model list holds only realtime models, and the voices are the selected model\'s', () => {
    const view = roster(draftOf())
    expect(view.models.map(m => m.id)).toEqual(['a-one', 'a-two'])
    expect(view.voices.map(v => v.id)).toEqual(['a1', 'a2'])
  })

  it('changing the provider selects its first realtime model and that model\'s first voice; changing the model selects its first voice', () => {
    expect(setProvider(draftOf(), 'tts-b')).toMatchObject({ ttsServiceId: 'tts-b', ttsModel: 'b-live', ttsVoice: 'e1' })
    expect(setModel(draftOf(), 'a-two')).toMatchObject({ ttsServiceId: 'tts-a', ttsModel: 'a-two', ttsVoice: 'b1', ttsSpeed: 1.2 })
  })

  // Take-over is a capability of the selected STT option's streaming provision, read
  // from that option alone: the TTS provider has no say (dev/specs/service-apis.md,
  // section 11). INVENTED: the roster view's flag is named `offersTakeover`.
  const offered = (draft: Draft): boolean => (roster(draft) as unknown as { offersTakeover: boolean }).offersTakeover

  it('[T2] take-over is offered when the selected STT option\'s stream provision holds it, and only then', () => {
    // stt-a has a batch provision only, stt-b a stream provision, stt-c a stream provision that omits the session parameter.
    expect(offered(draftOf())).toBe(false)
    expect(offered(setSttService(draftOf(), 'stt-b'))).toBe(true)
    expect(offered(setSttService(draftOf(), 'stt-c'))).toBe(false)
  })

  it('[T2] the selected TTS provider does not decide whether take-over is offered', () => {
    expect(offered(setProvider(setSttService(draftOf(), 'stt-b'), 'tts-b'))).toBe(true)
    expect(offered(setProvider(draftOf(), 'tts-b'))).toBe(false)
  })
})

describe('the patch Save sends', () => {
  it('an unchanged draft, or one whose edits were reverted, builds no patch', () => {
    expect(buildPatch(draftOf())).toBeNull()
    let draft = setVoice(setSpeed(draftOf(), 1.5), 'a2')
    draft = setVoice(setSpeed(draft, 1.2), 'a1')
    draft = setTuning(setTuning(draft, 'pauseThresholdMs', 900), 'pauseThresholdMs', 700)
    draft = setTakeover(setTakeover(draft, 'always'), 'ask')
    expect(buildPatch(draft)).toBeNull()
  })

  it('chunking edits that were reverted build no patch', () => {
    const perModel = resetChunking(editChunking(draftOf(), 'minWords', 9))
    expect(buildPatch(perModel)).toBeNull()
    const back = editChunking(editChunking(draftOf(), 'mode', 'paragraph'), 'mode', 'greedy')
    expect(buildPatch(back)).toBeNull()
    const global = setScope(editChunking(editChunking(setScope(draftOf(), 'global'), 'maxWords', 60), 'maxWords', 40), 'per-model')
    expect(buildPatch(global)).toBeNull()
  })

  it('a speed edit sends the selection and nothing else', () => {
    expect(buildPatch(setSpeed(draftOf(), 0.8))).toEqual({ ...SELECTION, speed: 0.8 })
  })

  it('the STT service, transcription mode, take-over, mic samples and scope are sent only when changed', () => {
    expect(buildPatch(setSttService(draftOf(), 'stt-b'))).toEqual({ ...SELECTION, sttServiceId: 'stt-b' })
    expect(buildPatch(setPreferStreaming(draftOf(), true))).toEqual({ ...SELECTION, preferStreaming: true })
    expect(buildPatch(setPreferStreaming(setPreferStreaming(draftOf(), true), false))).toBeNull()
    expect(buildPatch(setTakeover(draftOf(), 'always'))).toEqual({ ...SELECTION, takeover: 'always' })
    expect(buildPatch(setSaveMicSamples(draftOf(), true))).toEqual({ ...SELECTION, saveMicSamples: true })
    expect(buildPatch(setScope(draftOf(), 'global'))).toEqual({ ...SELECTION, settingsScope: 'global' })
  })

  it('a global chunking edit sends only the changed global options', () => {
    const draft = editChunking(setScope(draftOf(), 'global'), 'maxWords', 60)
    expect(buildPatch(draft)).toEqual({ ...SELECTION, settingsScope: 'global', maxChunkWords: 60 })
  })

  it('a per-model edit sends only the touched model\'s entry, and resetting a stored preference sends null for it', () => {
    expect(buildPatch(editChunking(draftOf(), 'minWords', 9))).toEqual({
      ...SELECTION,
      modelPrefs: { 'tts-a': { 'a-one': { chunking: { minWords: 9 } } } },
    })
    const reset = resetChunking(setModel(draftOf(), 'a-two'))
    expect(buildPatch(reset)).toEqual({
      serviceId: 'tts-a', model: 'a-two', voice: 'b1', speed: 1.2,
      modelPrefs: { 'tts-a': { 'a-two': null } },
    })
  })

  it('switching the model after a per-model edit keeps that edit for the first model', () => {
    let draft = editChunking(draftOf(), 'mode', 'paragraph')
    draft = setModel(draft, 'a-two')
    draft = editChunking(draft, 'maxWords', 70)
    expect(buildPatch(draft)?.modelPrefs).toEqual({
      'tts-a': {
        'a-one': { chunking: { mode: 'paragraph' } },
        'a-two': { chunking: { mode: 'paragraph', maxWords: 70 } },
      },
    })
  })

  it('a tuning edit sends only the changed field in its own section', () => {
    expect(buildPatch(setTuning(draftOf(), 'pauseThresholdMs', 950))).toEqual({ ...SELECTION, turnTaking: { pauseThresholdMs: 950 } })
    expect(buildPatch(setTuning(draftOf(), 'minSpeechProb', 0.8))).toEqual({ ...SELECTION, vad: { minSpeechProb: 0.8 } })
  })

  it('resetting a stored tuning field sends null for it; resetting one that was never stored sends nothing', () => {
    expect(buildPatch(resetTuning(draftOf(), 'pauseThresholdMs'))).toEqual({ ...SELECTION, turnTaking: { pauseThresholdMs: null } })
    expect(buildPatch(resetTuning(setTuning(draftOf(), 'minSpeechProb', 0.8), 'minSpeechProb'))).toBeNull()
  })
})

describe('tuning defaults', () => {
  it('every tuning field carries the engine default it falls back to, inside its slider range', () => {
    for (const f of TUNING_FIELDS) {
      expect(f.default).toBeGreaterThanOrEqual(f.min)
      expect(f.default).toBeLessThanOrEqual(f.max)
    }
    expect(Object.fromEntries(TUNING_FIELDS.map(f => [f.key, f.default]))).toEqual({
      minSpeechDurationS: 0.75, minSpeechProb: 0.7, pauseThresholdMs: 250, commitMinDelayMs: 250,
      commitMaxDelayMs: 2000, smartTurnThreshold: 0.7, smartTurnLowCutoff: 0.15,
    })
  })
})

describe('provenance', () => {
  it('provenance reports where each chunking value comes from, and which layers disagree', () => {
    const view = chunkingView(draftOf())
    expect(view.fields.mode).toEqual({ value: 'greedy', from: 'model' })
    expect(view.fields.minWords).toEqual({ value: 4, from: 'model' })
    expect(view.divergences.mode).toEqual([{ label: 'global', value: 'sentence' }])
    const global = chunkingView(setScope(setModel(draftOf(), 'a-two'), 'global'))
    expect(global.fields.mode).toEqual({ value: 'sentence', from: 'global' })
    expect(global.note).not.toBeNull()
    expect(chunkingView(draftOf()).note).toBeNull()
  })
})
