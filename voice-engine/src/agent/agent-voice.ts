// Design: docs/reference/components/voice-turn-taking.md

import { SpeechChunker } from './speech-chunker'
import { report } from '../store/turn-manager-store'
import { registerAudioHalter } from '../audio-halters'
import type { VoiceSession } from '../session'
import type { VoiceSelection, ChunkStrategy } from '../voice-config'
import type { ConversationReport } from '../turn-manager'
import type { SpeechPlayer } from '../system/playback-engine'

/**
 * The agent side: reads the conversation as it streams, chunks it, and
 * plays it through the player it is given. Reports the conversation's own
 * state to the floor on every change; the player reports the agent's
 * utterance and audio supply itself. Reaches the gateway only by reading
 * `session.conversation` — it never calls `session.send`/`session.abort`,
 * and imports nothing from the human side.
 */
export class AgentVoice {
  private chunker: SpeechChunker
  private unsubscribeConversation: (() => void) | null = null
  private unregisterAudioHalter: (() => void) | null = null

  /** Pushed every render, the same way HumanVoice.loop.voiceConfig is —
   * read by the enqueue closure below rather than captured once at
   * construction, so a selection or endpoint change reaches the next
   * chunk without reattaching. */
  ttsEndpoint: string | null = null
  ttsSelection: VoiceSelection | null = null
  /** Told once per unresolved selection that there is nothing to speak with. */
  onCannotSpeak: ((reason: string) => void) | undefined
  private reportedUnresolved: VoiceSelection | null = null

  constructor(player: SpeechPlayer) {
    // Local "silence now" precedes ground truth — stop() halts audio
    // synchronously before the abort RPC resolves.
    // Unregistered at teardown — a voice session's own halter must not
    // outlive it, or a stop() belonging to a later session finds a stale
    // closure over a player it no longer plays through.
    this.unregisterAudioHalter = registerAudioHalter(() => player.cancel())

    this.chunker = new SpeechChunker({
      enqueueChat: async (text) => {
        const sel = this.ttsSelection
        const endpoint = this.ttsEndpoint
        if (sel && !sel.request && this.reportedUnresolved !== sel) {
          this.reportedUnresolved = sel
          this.onCannotSpeak?.(sel.requestError ?? 'the selection was not resolved')
        }
        if (!sel?.request || !endpoint) return
        await player.enqueueChat({
          endpoint,
          text,
          request: sel.request,
          format: sel.responseFormat,
          speed: sel.speed ?? 1.0,
        })
      },
      beginRun: (runId) => player.beginRun(runId),
      endRun: () => player.endRun(),
    })
  }

  set chunkConfig(c: { chunkStrategy: ChunkStrategy; minChunkWords: number | undefined; maxChunkWords: number | undefined }) {
    this.chunker.config = c
  }

  attach(session: VoiceSession): void {
    this.unsubscribeConversation?.()
    this.chunker.attach(session)
    const reportConversation = () => {
      const snap = session.conversation.getSnapshot()
      const conversation: ConversationReport = {
        known: snap.known,
        runActive: snap.runActive,
        runId: snap.runId,
        activity: snap.activity,
      }
      report({ actor: 'conversation', conversation })
    }
    reportConversation()
    this.unsubscribeConversation = session.conversation.subscribe(reportConversation)
  }

  detach(): void {
    this.chunker.detach()
    this.unsubscribeConversation?.()
    this.unsubscribeConversation = null
    this.unregisterAudioHalter?.()
    this.unregisterAudioHalter = null
  }
}
