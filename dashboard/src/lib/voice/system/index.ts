// The page's one instance of the system, built from the real collaborators.

import { toast } from 'sonner'
import { pingService } from '@/lib/api'
import { VoiceSystem } from './voice-system'
import { acquire, release } from '../../system/devices'
import { PlaybackEngine } from './playback-engine'
import { createToneQueue } from './tones'
import { ensureTtsReady, ensureServiceReady, loadTtsModel, loadSttModel } from '../voice-service'
import { fetchSttModelFacts, createSttTransport } from '../voice-session-store'
import { HumanVoice } from '../human/human-voice'
import { AgentVoice } from '../agent/agent-voice'
import { SileroVad } from '../human/silero-vad'
import { SmartTurn } from '../human/smart-turn'

// The browser models are page-lifetime singletons, loaded once the first
// time the system asks for them. A load that fails is retried on the next
// call rather than remembered as a permanent failure.
let modelsPromise: Promise<{ vad: SileroVad; smartTurn: SmartTurn }> | null = null

function loadModels(): Promise<{ vad: SileroVad; smartTurn: SmartTurn }> {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      const vad = new SileroVad()
      const smartTurn = new SmartTurn()
      await Promise.all([vad.load(), smartTurn.load()])
      return { vad, smartTurn }
    })().catch((err) => {
      modelsPromise = null
      throw err
    })
  }
  return modelsPromise
}

// The one player for the page's lifetime: what the agent side plays speech
// through and the tone queue plays tones through. Only the system calls
// init/reset/release on it.
const player = new PlaybackEngine()
const tones = createToneQueue(player)

export const voiceSystem = new VoiceSystem({
  devices: { acquire, release },
  tones: { play: (name) => tones.play(name) },
  player,
  services: {
    ensureTtsReady,
    ensureServiceReady,
    loadTtsModel,
    loadSttModel,
    fetchSttModelFacts,
    ping: pingService,
  },
  loadModels,
  createTransport: createSttTransport,
  createHuman: (vad, smartTurn, cb) => new HumanVoice(vad, smartTurn, cb),
  createAgent: (speechPlayer) => new AgentVoice(speechPlayer),
  notify: (message, persistent) => toast.error(message, persistent ? { duration: Infinity, closeButton: true } : undefined),
  now: () => performance.now(),
  // randomUUID exists only in a secure context; a dashboard served over plain
  // http on a LAN still needs an id.
  newSessionId: () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
})

export { VoiceSystem, useVoiceSystemStore } from './voice-system'
export type { VoicePhase, EndReason, VoiceSystemState, VoiceSystemDeps, HumanSide, AgentSide } from './voice-system'
