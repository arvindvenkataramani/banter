import type { ChatEventPayload } from './gateway-types'

// Extract text from gateway chat event message (which is { role, content: [{ type: 'text', text }] })
export function extractMessageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''
  const msg = message as Record<string, unknown>
  // Try .text field first (older protocol / delta shorthand)
  if (typeof msg.text === 'string') return msg.text
  // content is a union: plain string or array of blocks.
  if (typeof msg.content === 'string') return msg.content
  // Then content array
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: unknown) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
      .map((b: unknown) => String((b as Record<string, unknown>).text ?? ''))
      .join('')
  }
  return ''
}

export function normalizeChatPayload(raw: unknown): ChatEventPayload {
  const p = raw as Record<string, unknown>
  return {
    runId: String(p.runId ?? ''),
    sessionKey: String(p.sessionKey ?? ''),
    seq: Number(p.seq ?? 0),
    state: String(p.state ?? 'error') as ChatEventPayload['state'],
    message: extractMessageText(p.message),
    errorMessage: typeof p.errorMessage === 'string' ? p.errorMessage : undefined,
  }
}

export function makeSessionKey(agent: string, session: string): string {
  return `agent:${agent}:${session}`
}

// Rows carry `__openclaw.id` (transcript entry identity) and `seq`. Anchor on
// those rather than synthesising positional ids, so a message keeps the same
// identity across reloads and can be reconciled against live events.
export function historyId(msg: Record<string, unknown>, fallbackIndex: number): string {
  const meta = msg.__openclaw as { id?: unknown; seq?: unknown } | undefined
  if (typeof meta?.id === 'string' && meta.id) return `hist-${meta.id}`
  if (typeof meta?.seq === 'number') return `hist-seq-${meta.seq}`
  return `hist-idx-${fallbackIndex}`
}

export function extractSenderAgentId(message: unknown): string | undefined {
  const msg = message as Record<string, unknown>
  if (msg.role !== 'user') return undefined
  const p = msg.provenance as { kind?: string; sourceSessionKey?: string } | undefined
  if (p?.kind !== 'inter_session' || !p.sourceSessionKey) return undefined
  const match = p.sourceSessionKey.match(/^agent:([^:]+):/)
  return match?.[1] ?? undefined
}
