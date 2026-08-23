import type { Session } from './session'

export type VoiceAnnotation = 'interrupted-speaking' | 'interrupted-working'

export const ANNOTATIONS: Record<VoiceAnnotation, string> = {
  'interrupted-speaking': '[[note: interrupted you while you were speaking]]',
  'interrupted-working': '[[note: interrupted you while you were working]]',
}

// Module-level, not per-instance: there is one voice engine, not one per
// session. use-voice-loop registers `() => engine.cancel()`; import
// direction is voice → controls only, never the reverse.
const audioHalters = new Set<() => void>()

export function registerAudioHalter(halt: () => void): () => void {
  audioHalters.add(halt)
  return () => {
    audioHalters.delete(halt)
  }
}

const ABORT_THEN_SEND_TIMEOUT_MS = 5000

export class SessionControls {
  private session: Session

  constructor(session: Session) {
    this.session = session
  }

  async send(text: string, opts?: { annotation?: VoiceAnnotation }): Promise<void> {
    const finalText = opts?.annotation ? `${ANNOTATIONS[opts.annotation]} ${text}` : text
    const id = this.session.conversation.addUserMessage(finalText)
    await this.deliver(id, finalText)
  }

  async resend(itemId: string): Promise<void> {
    const text = this.session.conversation.getItemText(itemId)
    if (text === null) return
    this.session.conversation.setDelivery(itemId, 'pending')
    await this.deliver(itemId, text)
  }

  // chat.abort + registered audio halters fired synchronously before the RPC
  // resolves — a stop control that keeps talking for half a second feels
  // broken, so local silence precedes ground truth.
  stop(): Promise<void> {
    for (const halt of audioHalters) halt()
    return this.session.abort()
  }

  // Send never fires during an active run without abort first — the
  // gateway's mid-run send path kills the run without a reply. Dropping the
  // user's words is worse than a risky send, so this waits at most 5s for
  // the run-ended fact and sends anyway if it never arrives.
  private async deliver(id: string, text: string): Promise<void> {
    if (this.session.conversation.getSnapshot().runActive) {
      await this.session.abort()
      await this.session.conversation.waitForRunEnd(ABORT_THEN_SEND_TIMEOUT_MS)
    }
    try {
      await this.session.send(text)
      this.session.conversation.setDelivery(id, 'confirmed')
    } catch (err) {
      this.session.conversation.setDelivery(id, 'failed')
      this.session.conversation.setError(err instanceof Error ? err.message : 'Send failed')
      throw err
    }
  }
}
