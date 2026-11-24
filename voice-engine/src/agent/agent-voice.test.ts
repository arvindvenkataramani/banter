import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentVoice } from './agent-voice'
import type { SpeechPlayer } from '../system/playback-engine'

// An utterance with nothing to speak it through is reported, not dropped (docs/reference/design/service-apis.md, "Adapters").

const player = (): SpeechPlayer => ({ enqueueChat: vi.fn(async () => {}), beginRun: vi.fn(), endRun: vi.fn(), cancel: vi.fn() })

let agent: AgentVoice | undefined
afterEach(() => { agent?.detach(); agent = undefined })

describe('an agent side whose provider has no speech provision', () => {
  it('[P2] tells the caller why, once, and plays nothing', async () => {
    const p = player()
    agent = new AgentVoice(p)
    const told = vi.fn()
    agent.onCannotSpeak = told
    agent.ttsEndpoint = 'https://tts.test'
    agent.ttsSelection = { serviceId: 'tts-a', model: 'm', voice: 'v', speed: 1, resolution: { model: 'm', voice: { name: 'v' } } }
    agent.ttsProvision = null
    agent.ttsProvisionError = 'tts-a cannot synthesize: it provides openai.audio.transcriptions'

    // The chunker's callback is the closure under test; the chunker is private.
    const calls = (agent as unknown as { chunker: { cb: { enqueueChat(text: string): Promise<void> } } }).chunker.cb
    await calls.enqueueChat('hello')
    await calls.enqueueChat('again')

    expect(told).toHaveBeenCalledTimes(1)
    expect(told).toHaveBeenCalledWith('tts-a cannot synthesize: it provides openai.audio.transcriptions')
    expect(p.enqueueChat).not.toHaveBeenCalled()
  })
})
