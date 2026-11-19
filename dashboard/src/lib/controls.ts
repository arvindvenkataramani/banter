import type { Session } from './session'
import type { VoiceAnnotation } from '@platform/voice-engine/session'
import { haltAudio } from '@platform/voice-engine/audio-halters'

export type { VoiceAnnotation }

export const ANNOTATIONS: Record<VoiceAnnotation, string> = {
  'interrupted-speaking': '[[note: interrupted you while you were speaking]]',
  'interrupted-working': '[[note: interrupted you while you were working]]',
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
    haltAudio()
    return this.session.abort()
  }

  // The turn manager's abort of a run the human interrupted. No halters: the
  // player already cancels an interrupted turn's audio by reconciling.
  abort(): Promise<void> {
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
