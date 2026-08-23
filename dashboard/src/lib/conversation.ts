import { extractMessageText, extractSenderAgentId, historyId } from './gateway-utils'
import type { RunState } from './run-state'

export type DeliveryStatus = 'pending' | 'confirmed' | 'failed'

export type ConversationItem =
  | { id: string; kind: 'user-message'; text: string; senderAgentId?: string; delivery?: DeliveryStatus }
  | { id: string; kind: 'assistant-text'; runId?: string; text: string; isStreaming?: boolean }
  | { id: string; kind: 'tool-card'; title: string; status: 'running' | 'done' | 'interrupted' | 'error' | 'unknown' }
  | { id: string; kind: 'error'; message: string }
  | { id: string; kind: 'compaction'; phase: 'active' | 'retrying' | 'complete' }

// The design doc's original "a tool was run" generic marker assumed history
// couldn't carry per-tool detail. Confirmed false against real chat.history
// (Decision 3, 2026-08-09 follow-up): the toolCall block carries name +
// arguments directly, same data the OpenClaw web UI already displays for the
// same rows. Titled the same way live cards are (tool name, plus its primary
// argument when recognized) rather than inventing new formatting.
//
// Checked in priority order rather than a generic "first string value" scan
// — arguments commonly carry more than one string field (e.g. a description
// alongside the actual target), and the wrong one would be a worse title
// than none at all.
const TITLE_ARG_KEYS = ['command', 'path', 'file', 'url', 'query'] as const

function blockToolTitle(block: Record<string, unknown>): string {
  const name = typeof block.name === 'string' ? block.name : 'a tool was run'
  const args = block.arguments ?? block.input
  if (!isRecord(args)) return name
  for (const key of TITLE_ARG_KEYS) {
    if (typeof args[key] === 'string') return `${name}: ${args[key]}`
  }
  return name
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

// Accepts both Anthropic (`tool_use`/`tool_use_id`/`is_error`) and OpenClaw
// (`toolCall`/`toolCallId`/`isError`) field-naming conventions: no real
// chat.history capture containing tool blocks was available to confirm which
// one the gateway actually emits, so both are handled.
function blockToolCallId(block: Record<string, unknown>): string | null {
  if (typeof block.toolCallId === 'string') return block.toolCallId
  if (typeof block.id === 'string') return block.id
  return null
}

function blockResultToolCallId(block: Record<string, unknown>): string | null {
  if (typeof block.toolCallId === 'string') return block.toolCallId
  if (typeof block.tool_use_id === 'string') return block.tool_use_id
  return null
}

function blockIsError(block: Record<string, unknown>): boolean {
  return block.isError === true || block.is_error === true
}

function blockResultText(block: Record<string, unknown>): string {
  if (typeof block.text === 'string') return block.text
  return extractMessageText(block)
}

// The two known abort-artifact text styles (plan + design doc, quoted
// verbatim): synthetic-repair results for calls whose result never returned,
// and explicit results for calls that were in flight when the abort landed.
// Neither is a real failure.
function isAbortArtifactText(text: string): boolean {
  return text.includes('inserted synthetic error result') || text.includes('This operation was aborted')
}

export function seedFromHistory(rows: unknown[], offset = 0): ConversationItem[] {
  const items: ConversationItem[] = []
  const cardIndexByToolCallId = new Map<string, number>()

  rows.forEach((row, i) => {
    if (!isRecord(row)) return
    const role = row.role

    if (role === 'user' || role === 'assistant') {
      const text = extractMessageText(row)
      if (text) {
        const senderAgentId = extractSenderAgentId(row)
        items.push(
          role === 'user'
            ? { id: historyId(row, offset + i), kind: 'user-message', text, senderAgentId }
            : { id: historyId(row, offset + i), kind: 'assistant-text', text }
        )
      }
    }

    // Top-level tool-result rows (role: 'toolResult') — this OpenClaw build's
    // real shape, confirmed against live chat.history: the result is a
    // sibling message with toolCallId/isError on the row itself, not a
    // tool_result-typed block nested in any content array.
    //
    // No 'interrupted' status here: a real abort produces no result row at
    // all (confirmed live — an aborted call's card just stays 'unknown'
    // forever), so a row that did arrive is never an abort artifact. Only
    // the live run facet (Session/Conversation.ingest, run-state.ts) can
    // ever know a call was interrupted — history only ever records attempts
    // and their outcomes, never intent.
    if (role === 'toolResult') {
      const toolCallId = blockResultToolCallId(row)
      if (toolCallId) {
        const idx = cardIndexByToolCallId.get(toolCallId)
        if (idx !== undefined) {
          const existing = items[idx]
          if (existing.kind === 'tool-card') {
            items[idx] = { ...existing, status: blockIsError(row) ? 'error' : 'done' }
          }
        }
      }
    }

    const content = row.content
    if (!Array.isArray(content)) return

    for (const b of content) {
      if (!isRecord(b)) continue
      if (b.type === 'tool_use' || b.type === 'toolCall') {
        const toolCallId = blockToolCallId(b)
        if (!toolCallId) continue
        // Outcome unknown until a matching result row (or block) says
        // otherwise — history alone never proves success.
        const card: ConversationItem = { id: `hist-tool-${toolCallId}`, kind: 'tool-card', title: blockToolTitle(b), status: 'unknown' }
        cardIndexByToolCallId.set(toolCallId, items.length)
        items.push(card)
      } else if (b.type === 'tool_result') {
        const toolCallId = blockResultToolCallId(b)
        if (!toolCallId) continue
        const idx = cardIndexByToolCallId.get(toolCallId)
        if (idx === undefined) continue // orphaned result, no matching call in this page — tolerated
        const existing = items[idx]
        if (existing.kind !== 'tool-card') continue
        if (!blockIsError(b)) {
          items[idx] = { ...existing, status: 'done' }
          continue
        }
        const text = blockResultText(b)
        items[idx] = { ...existing, status: isAbortArtifactText(text) ? 'interrupted' : 'error' }
      }
    }
  })

  return items
}

function buildRunSegments(run: RunState): ConversationItem[] {
  if (!run.runId) return []
  const out: ConversationItem[] = []
  const marks = [...run.marks].sort((a, b) => a.textOffset - b.textOffset)
  let cursor = 0
  let segIdx = 0

  for (const mark of marks) {
    const segText = run.text.slice(cursor, mark.textOffset)
    if (segText.length > 0) {
      out.push({ id: `live:${run.runId}:text:${segIdx++}`, kind: 'assistant-text', runId: run.runId, text: segText, isStreaming: run.runActive })
    }
    out.push({ id: `live:${run.runId}:tool:${mark.toolCallId}`, kind: 'tool-card', title: mark.title ?? mark.name, status: mark.status })
    cursor = mark.textOffset
  }

  const tail = run.text.slice(cursor)
  if (tail.length > 0) {
    out.push({ id: `live:${run.runId}:text:${segIdx++}`, kind: 'assistant-text', runId: run.runId, text: tail, isStreaming: run.runActive })
  }

  return out
}

export function applyLiveRun(items: ConversationItem[], run: RunState): ConversationItem[] {
  if (!run.runId) return items
  const prefix = `live:${run.runId}:`
  const base = items.filter((i) => !i.id.startsWith(prefix))
  return [...base, ...buildRunSegments(run)]
}

export function finalizeRun(items: ConversationItem[], run: RunState): ConversationItem[] {
  const applied = applyLiveRun(items, run)
  if (!run.runId) return applied
  return applied.map((i) => (i.kind === 'assistant-text' && i.runId === run.runId ? { ...i, isStreaming: false } : i))
}
