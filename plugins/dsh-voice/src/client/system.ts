// The page's one VoiceSystem, built from the engine's real collaborators and
// the plugin's services, as dashboard/src/lib/voice/system/index.ts builds it.

import { VoiceSystem } from '@platform/voice-engine/system/voice-system'
import { acquire, release } from '@platform/voice-engine/devices'
import { PlaybackEngine } from '@platform/voice-engine/system/playback-engine'
import { createToneQueue } from '@platform/voice-engine/system/tones'
import { fetchSttModelFacts, createSttTransport } from '@platform/voice-engine/voice-session-store'
import { HumanVoice } from '@platform/voice-engine/human/human-voice'
import { AgentVoice } from '@platform/voice-engine/agent/agent-voice'
import { SileroVad } from '@platform/voice-engine/human/silero-vad'
import { SmartTurn } from '@platform/voice-engine/human/smart-turn'
import { loadSttModel, loadTtsModel, type PluginServices } from './services.ts'

export interface VoiceSystemParts {
  services: PluginServices
  /** The configured input device id; empty means the browser's default. */
  inputDevice(): string
  /** Shows a message on the voice button. */
  notify(message: string, persistent?: boolean): void
}

/**
 * Opens the microphone, on the configured device when there is one. The
 * engine's `acquire` asks for the stream before its first await and takes no
 * device, so the device id is added to that one call.
 */
export function acquireMicrophone(deviceId: string): Promise<boolean> {
  if (deviceId === '') return acquire()
  const media = navigator.mediaDevices
  const original = media.getUserMedia
  media.getUserMedia = (constraints) => {
    media.getUserMedia = original
    const audio = typeof constraints?.audio === 'object' ? constraints.audio : {}
    return original.call(media, { ...constraints, audio: { ...audio, deviceId: { exact: deviceId } } })
  }
  try {
    return acquire().catch((err: unknown) => {
      // The browser words a refused device constraint as an empty message.
      const name = err instanceof Error ? err.name : ''
      if (name === 'OverconstrainedError' || name === 'NotFoundError') throw new Error('The configured input device is not available')
      throw err
    })
  } finally {
    media.getUserMedia = original
  }
}

export function createVoiceSystem(parts: VoiceSystemParts): VoiceSystem {
  // The browser models load once for the page's life; a failed load is retried on the next call.
  let modelsPromise: Promise<{ vad: SileroVad; smartTurn: SmartTurn }> | null = null
  const loadModels = (): Promise<{ vad: SileroVad; smartTurn: SmartTurn }> => {
    modelsPromise ??= (async () => {
      const vad = new SileroVad()
      const smartTurn = new SmartTurn()
      await Promise.all([vad.load(), smartTurn.load()])
      return { vad, smartTurn }
    })().catch((err: unknown) => {
      modelsPromise = null
      throw err
    })
    return modelsPromise
  }

  // One player for the page's life: speech and tones play through it.
  const player = new PlaybackEngine()
  const tones = createToneQueue(player)
  const { services } = parts

  return new VoiceSystem({
    devices: { acquire: () => acquireMicrophone(parts.inputDevice()), release },
    tones: { play: (name) => tones.play(name) },
    player,
    services: {
      ensureTtsReady: services.ensureTtsReady,
      ensureServiceReady: services.ensureServiceReady,
      loadTtsModel,
      loadSttModel,
      fetchSttModelFacts,
      ping: services.ping,
    },
    loadModels,
    createTransport: (opts) => createSttTransport({ ...opts, ensureServiceReady: services.ensureServiceReady }),
    createHuman: (vad, smartTurn, cb) => new HumanVoice(vad, smartTurn, cb),
    createAgent: (speechPlayer) => new AgentVoice(speechPlayer),
    notify: parts.notify,
    now: () => performance.now(),
    // randomUUID exists only in a secure context.
    newSessionId: () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
  })
}
