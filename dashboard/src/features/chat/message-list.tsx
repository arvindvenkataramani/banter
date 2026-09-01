import { MessageBubble } from './message-bubble'
import { ToolRunGroup } from './tool-run-group'
import { ActivityIndicator } from './activity-indicator'
import { ReasoningRow } from './reasoning-row'
import type { ConversationItem } from '@/lib/conversation-store'

interface Props {
  items: ReadonlyArray<ConversationItem>
  runActive: boolean
  onResend: (itemId: string) => void
}

type ToolCardItem = Extract<ConversationItem, { kind: 'tool-card' }>

// A "tool run" is a maximal run of consecutive tool-card items — closed the
// moment any other item kind appears, reopened on the next tool-card. This
// is deliberately a real grouping concept (not just a rendering shortcut):
// it's where richer per-run detail (a shared header, expand/collapse, timing)
// belongs when that lands later, rather than bolting it onto individual
// cards. Groups render tight internally and with reduced (not zero) spacing
// to their neighbors — still visually distinct blocks, just closer than the
// spacing between unrelated turns (2026-08-09).
function groupIntoToolRuns(items: ReadonlyArray<ConversationItem>): Array<ConversationItem | ToolCardItem[]> {
  const groups: Array<ConversationItem | ToolCardItem[]> = []
  for (const item of items) {
    const last = groups[groups.length - 1]
    if (item.kind === 'tool-card' && Array.isArray(last)) {
      last.push(item)
    } else if (item.kind === 'tool-card') {
      groups.push([item])
    } else {
      groups.push(item)
    }
  }
  return groups
}

export function MessageList({ items, runActive, onResend }: Props) {
  function renderItem(item: ConversationItem) {
    switch (item.kind) {
      case 'user-message':
        return (
          <MessageBubble
            key={item.id}
            role="user"
            text={item.text}
            senderAgentId={item.senderAgentId}
            delivery={item.delivery}
            onResend={() => onResend(item.id)}
          />
        )
      case 'assistant-text':
        return <MessageBubble key={item.id} role="assistant" text={item.text} isStreaming={item.isStreaming} />
      case 'thinking':
        return <ReasoningRow key={item.id} text={item.text} running={item.isStreaming === true} />
      case 'tool-card':
        // Unreachable directly — tool-card items are always consumed via
        // groupIntoToolRuns/ToolRunGroup below, even a run of one.
        return null
      case 'error':
        return (
          <div key={item.id} role="alert" className="self-start rounded-lg bg-destructive/10 text-destructive px-3 py-1.5 text-sm">
            {item.message}
          </div>
        )
      case 'compaction':
        // Not reachable yet — ingest() no-ops on compaction events until
        // the compaction migration step; CompactionIndicator (page.tsx)
        // is still the real source for now.
        return null
    }
  }

  const groups = groupIntoToolRuns(items)

  // "Processing" is a placeholder for the gap before any content exists for
  // the active run — not a running commentary on what kind of work is
  // happening. Once the first reasoning line, delta or tool-card shows up,
  // that content is itself the evidence something's happening, and the
  // reasoning row takes over the job of showing the model at work. Driving
  // this off which event kind last arrived flickers as they interleave.
  // Only one run is ever active at a time, so any live: item's presence
  // means the active run already has visible content.
  const activeRunHasContent = items.some((i) => i.id.startsWith('live:'))
  const showProcessing = runActive && !activeRunHasContent

  return (
    <div className="py-8 md:py-10 flex flex-col min-w-0 gap-7 md:gap-8">
      {groups.map((group, i) => {
        if (!Array.isArray(group)) return renderItem(group)
        // Tight to the turn's own text on both sides, full turn-to-turn gap
        // to anything from a different turn — approximated here as "tight
        // to text neighbors, normal to everything else" since items don't
        // currently carry a turn/runId grouping of their own.
        const prev = i > 0 ? groups[i - 1] : null
        const next = i < groups.length - 1 ? groups[i + 1] : null
        const tightBefore = prev !== null && !Array.isArray(prev) && prev.kind === 'assistant-text'
        const tightAfter = next !== null && !Array.isArray(next) && next.kind === 'assistant-text'
        return (
          <ToolRunGroup key={group[0].id} cards={group} tightBefore={tightBefore} tightAfter={tightAfter} />
        )
      })}
      <ActivityIndicator show={showProcessing} />
    </div>
  )
}
