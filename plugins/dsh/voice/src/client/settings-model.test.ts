import { describe, expect, it } from 'vitest'
import { resolveVoiceSelection, type StoredVoiceSelection, type VoiceConfig } from '@platform/voice-engine/voice-config'
import { resolveChunkingFor } from '@platform/voice-engine/agent/chunking-setting'
import { DEFAULT_SETTINGS, settingsFromVoiceConfig, voiceConfigFromSettings, type PluginSettings } from '../host/settings.ts'
import {
  buildWrite, chunkingView, editChunking, resetChunking, roster, seedDraft, setControlPlaneUrl, setKeepVoiceOutside, setModel, setProvider,
  setScope, setSpeed, setSttService, setTakeover, setTuning, setVoice, type Draft, type SettingsOp,
} from './settings-model.ts'

// A control-plane voice config with two TTS providers (the second one's first model is not realtime), two STT options, and every
// rest-backed setting present: chunking options, a stored preference for another model, vad and turn-taking values, a curve.
const CONFIG: VoiceConfig = {
  enabled: true,
  takeover: 'ask',
  tts: {
    providers: [
      {
        serviceId: 'tts-a',
        name: 'Provider A',
        responseFormat: 'mp3',
        sessions: true,
        models: [
          {
            id: 'a-one', key: 'a-one-key', realtime: true, chunking: { mode: 'greedy', minWords: 4, maxWords: 50 },
            voices: [{ id: 'a1', name: 'A1', key: 'a1-key' }, { id: 'a2', name: 'A2', key: 'a2-key' }],
          },
          { id: 'a-two', key: 'a-two-key', realtime: true, voices: [{ id: 'b1', name: 'B1', key: 'b1-key' }] },
          { id: 'a-batch', key: 'a-batch-key', voices: [{ id: 'c1', name: 'C1', key: 'c1-key' }] },
        ],
      },
      {
        serviceId: 'tts-b',
        responseFormat: 'aac',
        models: [
          { id: 'b-batch', key: 'b-batch-key', voices: [{ id: 'd1', name: 'D1', key: 'd1-key' }] },
          { id: 'b-live', key: 'b-live-key', realtime: true, voices: [{ id: 'e1', name: 'E1', key: 'e1-key' }, { id: 'e2', name: 'E2', key: 'e2-key' }] },
        ],
      },
    ],
    selection: { serviceId: 'tts-a', model: 'a-one', voice: 'a1', speed: 1.2 },
    options: { chunkStrategy: 'sentence', minChunkWords: 3, maxChunkWords: 40 },
    modelPrefs: { 'tts-a': { 'a-two': { chunking: { mode: 'paragraph' } } } },
    settingsScope: 'per-model',
  },
  stt: {
    serviceId: 'stt-a',
    model: 'stt-model-1',
    options: [{ serviceId: 'stt-a', name: 'STT A' }, { serviceId: 'stt-b', name: 'STT B', sessions: true }],
    reveal: { minIntervalMs: 60, maxIntervalMs: 180 },
    vad: { minSpeechDurationS: 0.5 },
    turnTaking: { pauseThresholdMs: 700, commitMinDelayMs: 200, curve: { type: 'power', exponent: 2 } },
  },
  debug: { saveMicSamples: false },
}

const seeded = (): PluginSettings => settingsFromVoiceConfig(CONFIG, 'http://control.invalid:7000')
const draftOf = (settings = seeded()): Draft => seedDraft(settings)

/** What the host's config holds after a write: the ops applied to the settings the draft was seeded from. */
function applyOps(settings: PluginSettings, ops: readonly SettingsOp[]): PluginSettings {
  const next: Record<string, unknown> = { ...settings }
  for (const op of ops) if (op.op === 'set') next[op.path[0]] = op.value
  return next as unknown as PluginSettings
}

const writeOf = (settings: PluginSettings, draft: Draft) => buildWrite(settings, draft)
const restOf = (settings: PluginSettings): VoiceConfig => JSON.parse(settings.rest) as VoiceConfig
const fieldsOf = (ops: readonly SettingsOp[]): string[] => ops.map(op => op.path[0]).sort()

describe('seeding', () => {
  it('the draft starts from the stored selection, STT service, URL, flag and the rest-backed values', () => {
    const draft = draftOf()
    expect(draft).toMatchObject({
      controlPlaneUrl: 'http://control.invalid:7000',
      sttServiceId: 'stt-a',
      ttsServiceId: 'tts-a',
      ttsModel: 'a-one',
      ttsVoice: 'a1',
      ttsSpeed: 1.2,
      keepVoiceOutside: false,
      takeover: 'ask',
      scope: 'per-model',
      global: { mode: 'sentence', minWords: 3, maxWords: 40 },
      tuning: { minSpeechDurationS: 0.5, pauseThresholdMs: 700, commitMinDelayMs: 200 },
    })
  })

  it('a field the stored config does not set stays unset in the tuning draft, and take-over defaults as Banter does', () => {
    const draft = draftOf()
    expect(draft.tuning.minSpeechProb).toBeUndefined()
    expect(draft.tuning.smartTurnThreshold).toBeUndefined()
    const bare = draftOf({ ...seeded(), rest: JSON.stringify({ tts: { providers: [] }, stt: {} }) })
    expect(bare).toMatchObject({ takeover: 'ask', scope: 'per-model' })
  })

  it('settings with no roster seed an empty roster instead of failing', () => {
    const view = roster(draftOf(DEFAULT_SETTINGS))
    expect(view.providers).toEqual([])
    expect(view.models).toEqual([])
    expect(view.voices).toEqual([])
    expect(view.sttOptions).toEqual([])
    expect(view.declaresSessions).toBe(false)
  })
})

describe('rosters and cascades', () => {
  it('the model list holds only realtime models, and the voices are the selected model\'s', () => {
    const view = roster(draftOf())
    expect(view.models.map(m => m.id)).toEqual(['a-one', 'a-two'])
    expect(view.voices.map(v => v.id)).toEqual(['a1', 'a2'])
  })

  it('changing the provider selects its first realtime model, skipping a non-realtime one, and that model\'s first voice', () => {
    const draft = setProvider(draftOf(), 'tts-b')
    expect(draft).toMatchObject({ ttsServiceId: 'tts-b', ttsModel: 'b-live', ttsVoice: 'e1' })
  })

  it('changing the model selects its first voice and keeps the provider and speed', () => {
    const draft = setModel(draftOf(), 'a-two')
    expect(draft).toMatchObject({ ttsServiceId: 'tts-a', ttsModel: 'a-two', ttsVoice: 'b1', ttsSpeed: 1.2 })
  })

  it('a provider with no realtime model leaves model and voice empty', () => {
    const config: VoiceConfig = { ...CONFIG, tts: { ...CONFIG.tts, providers: [{ serviceId: 'tts-x', responseFormat: 'mp3', models: [{ id: 'm', key: 'm', voices: [{ id: 'v', name: 'V', key: 'v' }] }] }] } }
    const draft = setProvider(seedDraft(settingsFromVoiceConfig(config, '')), 'tts-x')
    expect(draft).toMatchObject({ ttsServiceId: 'tts-x', ttsModel: '', ttsVoice: '' })
  })

  it('take-over is offered when the selected TTS provider or the selected STT option declares sessions, and only then', () => {
    expect(roster(draftOf()).declaresSessions).toBe(true) // tts-a declares sessions
    const noTts = setProvider(draftOf(), 'tts-b')
    expect(roster(noTts).declaresSessions).toBe(false)
    expect(roster(setSttService(noTts, 'stt-b')).declaresSessions).toBe(true)
  })
})

describe('buildWrite: typed fields', () => {
  it('an unchanged draft writes nothing and leaves the settings as they were', () => {
    const settings = seeded()
    const write = writeOf(settings, draftOf(settings))
    expect(write.ops).toEqual([])
    expect(write.next).toEqual(settings)
  })

  it('an unchanged draft writes nothing even when the stored rest is formatted differently from a fresh serialisation', () => {
    const settings = { ...seeded(), rest: JSON.stringify(restOf(seeded()), null, 2) }
    const write = writeOf(settings, draftOf(settings))
    expect(write.ops).toEqual([])
    expect(write.next.rest).toBe(settings.rest)
  })

  it('an edit that is reverted before saving writes nothing', () => {
    const settings = seeded()
    let draft = setVoice(draftOf(settings), 'a2')
    draft = setSpeed(draft, 1.5)
    draft = setVoice(setSpeed(draft, 1.2), 'a1')
    draft = setTuning(setTuning(draft, 'pauseThresholdMs', 900), 'pauseThresholdMs', 700)
    expect(writeOf(settings, draft).ops).toEqual([])
  })

  it('a provider change writes the three selection fields and nothing else', () => {
    const settings = seeded()
    const write = writeOf(settings, setProvider(draftOf(settings), 'tts-b'))
    expect(fieldsOf(write.ops)).toEqual(['ttsModel', 'ttsServiceId', 'ttsVoice'])
    expect(write.next).toMatchObject({ ttsServiceId: 'tts-b', ttsModel: 'b-live', ttsVoice: 'e1', ttsSpeed: 1.2 })
    expect(write.next.rest).toBe(settings.rest)
  })

  it('a speed edit writes only the speed and a voice edit only the voice', () => {
    const settings = seeded()
    expect(writeOf(settings, setSpeed(draftOf(settings), 0.8)).ops).toEqual([{ op: 'set', path: ['ttsSpeed'], value: 0.8 }])
    expect(writeOf(settings, setVoice(draftOf(settings), 'a2')).ops).toEqual([{ op: 'set', path: ['ttsVoice'], value: 'a2' }])
  })

  it('the STT model is left as stored when the STT provider changes', () => {
    const settings = seeded()
    const write = writeOf(settings, setSttService(draftOf(settings), 'stt-b'))
    expect(write.ops).toEqual([{ op: 'set', path: ['sttServiceId'], value: 'stt-b' }])
    const config = voiceConfigFromSettings(applyOps(settings, write.ops))
    expect(config.stt).toMatchObject({ serviceId: 'stt-b', model: 'stt-model-1' })
  })

  it('the control-plane URL and keep-voice-outside write their own fields and never touch rest', () => {
    const settings = seeded()
    const draft = setKeepVoiceOutside(setControlPlaneUrl(draftOf(settings), 'http://other.invalid:9000'), true)
    const write = writeOf(settings, draft)
    expect(write.ops).toEqual([
      { op: 'set', path: ['controlPlaneUrl'], value: 'http://other.invalid:9000' },
      { op: 'set', path: ['keepVoiceOutside'], value: true },
    ])
    expect(write.next.rest).toBe(settings.rest)
  })
})

describe('buildWrite: rest-backed settings', () => {
  it('a global chunking edit lands in tts.options, leaves the other options and the stored preferences alone, and round-trips into the engine config', () => {
    const settings = seeded()
    const draft = editChunking(editChunking(setScope(draftOf(settings), 'global'), 'mode', 'greedy'), 'maxWords', 60)
    const write = writeOf(settings, draft)
    expect(fieldsOf(write.ops)).toEqual(['rest'])
    const rest = restOf(write.next)
    expect(rest.tts.options).toEqual({ chunkStrategy: 'greedy', minChunkWords: 3, maxChunkWords: 60 })
    expect(rest.tts.settingsScope).toBe('global')
    expect(rest.tts.modelPrefs).toEqual(CONFIG.tts.modelPrefs)
    const engine = voiceConfigFromSettings(write.next)
    expect(resolveChunkingFor(engine, resolveVoiceSelection(engine, engine.tts.selection as StoredVoiceSelection))).toMatchObject({ strategy: 'greedy', minWords: 3, maxWords: 60 })
  })

  it('a per-model edit writes only the selected model\'s preference, as a whole entry, and leaves the global options', () => {
    const settings = seeded()
    const write = writeOf(settings, editChunking(draftOf(settings), 'minWords', 9))
    const rest = restOf(write.next)
    expect(rest.tts.modelPrefs).toEqual({
      'tts-a': { 'a-one': { chunking: { minWords: 9 } }, 'a-two': { chunking: { mode: 'paragraph' } } },
    })
    expect(rest.tts.options).toEqual(CONFIG.tts.options)
    const engine = voiceConfigFromSettings(write.next)
    expect(resolveChunkingFor(engine, resolveVoiceSelection(engine, engine.tts.selection as StoredVoiceSelection))).toMatchObject({ strategy: 'greedy', minWords: 9, maxWords: 50 })
  })

  it('switching the model after a per-model edit keeps that edit for the first model and starts the second from its own stored preference', () => {
    const settings = seeded()
    let draft = editChunking(draftOf(settings), 'mode', 'paragraph') // differs from what the model ships, so it is an override
    draft = setModel(draft, 'a-two')
    expect(chunkingView(draft).fields.mode).toEqual({ value: 'paragraph', from: 'override' })
    draft = editChunking(draft, 'maxWords', 70)
    const rest = restOf(writeOf(settings, draft).next)
    expect(rest.tts.modelPrefs?.['tts-a']?.['a-one']).toEqual({ chunking: { mode: 'paragraph' } })
    expect(rest.tts.modelPrefs?.['tts-a']?.['a-two']).toEqual({ chunking: { mode: 'paragraph', maxWords: 70 } })
  })

  it('reset to model defaults removes the model\'s stored preference and its provider bucket once empty, and keeps the others', () => {
    const settings = seeded()
    const onTwo = setModel(draftOf(settings), 'a-two')
    const rest = restOf(writeOf(settings, resetChunking(onTwo)).next)
    expect(rest.tts.modelPrefs).toEqual({})
    const withOne = editChunking(setModel(draftOf(settings), 'a-one'), 'minWords', 9)
    const both = restOf(writeOf(settings, resetChunking(setModel(withOne, 'a-two'))).next)
    expect(both.tts.modelPrefs).toEqual({ 'tts-a': { 'a-one': { chunking: { minWords: 9 } } } })
  })

  it('a per-model edit that is undone leaves the stored rest untouched', () => {
    const settings = { ...seeded(), rest: JSON.stringify({ ...restOf(seeded()), tts: { ...restOf(seeded()).tts, modelPrefs: undefined } }) }
    const edited = editChunking(draftOf(settings), 'minWords', 9)
    const undone = resetChunking(edited)
    const write = writeOf(settings, undone)
    expect(write.ops).toEqual([])
    expect(write.next.rest).toBe(settings.rest)
  })

  it('take-over and scope each land in their own rest path and leave their siblings', () => {
    const settings = seeded()
    const draft = setScope(setTakeover(draftOf(settings), 'always'), 'global')
    const rest = restOf(writeOf(settings, draft).next)
    expect(rest.takeover).toBe('always')
    expect(rest.debug).toEqual({ saveMicSamples: false })
    expect(rest.tts.settingsScope).toBe('global')
    expect(rest.tts.options).toEqual(CONFIG.tts.options)
    expect(rest.enabled).toBe(true)
  })

  it('a stored debug section is carried through a write untouched, and the draft has no switch for it', () => {
    const base = seeded()
    const settings = { ...base, rest: JSON.stringify({ ...JSON.parse(base.rest), debug: { saveMicSamples: true, other: 1 } }) }
    const draft = draftOf(settings)
    expect('saveMicSamples' in draft).toBe(false)
    const rest = restOf(writeOf(settings, setTakeover(draft, 'always')).next)
    expect(rest.takeover).toBe('always')
    expect(rest.debug).toEqual({ saveMicSamples: true, other: 1 })
  })

  it('a tuning edit merges into its own section: vad stays apart from turnTaking, and the section\'s other values and curve survive', () => {
    const settings = seeded()
    let draft = setTuning(draftOf(settings), 'pauseThresholdMs', 950)
    draft = setTuning(draft, 'minSpeechDurationS', 0.7)
    const rest = restOf(writeOf(settings, draft).next)
    expect(rest.stt?.vad).toEqual({ minSpeechDurationS: 0.7 })
    expect(rest.stt?.turnTaking).toEqual({ pauseThresholdMs: 950, commitMinDelayMs: 200, curve: { type: 'power', exponent: 2 } })
    expect(rest.stt?.reveal).toEqual(CONFIG.stt?.reveal)
    expect(rest.tts.providers).toEqual(CONFIG.tts.providers)
  })

  it('a rest-backed write leaves the typed fields and the STT service and model out of rest', () => {
    const settings = seeded()
    const write = writeOf(settings, setTakeover(draftOf(settings), 'always'))
    const rest = restOf(write.next) as unknown as Record<string, Record<string, unknown>>
    expect(rest.tts.selection).toBeUndefined()
    expect(rest.stt.serviceId).toBeUndefined()
    expect(rest.stt.model).toBeUndefined()
    expect(voiceConfigFromSettings(write.next).stt).toMatchObject({ serviceId: 'stt-a', model: 'stt-model-1' })
  })

  it('provenance reports where each chunking value comes from, and which layers disagree', () => {
    const view = chunkingView(draftOf())
    expect(view.fields.mode).toEqual({ value: 'greedy', from: 'model' })
    expect(view.fields.minWords).toEqual({ value: 4, from: 'model' })
    expect(view.divergences.mode).toEqual([{ label: 'global', value: 'sentence' }])
    expect(view.modelName).toBe('a-one')
    const global = chunkingView(setScope(setModel(draftOf(), 'a-two'), 'global'))
    expect(global.fields.mode).toEqual({ value: 'sentence', from: 'global' })
    expect(global.note).toBe('Saved values for a-two are set aside while every model shares one set.')
  })
})
