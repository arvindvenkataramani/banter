import { ToolCard } from './tool-card'
import type { ConversationItem } from '@/lib/conversation-store'

type ToolCardItem = Extract<ConversationItem, { kind: 'tool-card' }>

interface Props {
  cards: ToolCardItem[]
  // Whether the neighbor on that side is the turn's own assistant text —
  // pulls the group closer than the outer list's turn-to-turn gap without
  // collapsing it to zero (still two visually distinct blocks, just closer
  // than unrelated turns).
  tightBefore: boolean
  tightAfter: boolean
}

// One run of consecutive tool calls, rendered as a single unit. Real
// grouping boundary (not just a spacing hack) so a shared header,
// expand/collapse, or richer per-call detail has somewhere to live later
// without re-deriving the grouping logic again.
export function ToolRunGroup({ cards, tightBefore, tightAfter }: Props) {
  const margin = [tightBefore && '-mt-4 md:-mt-5', tightAfter && '-mb-4 md:-mb-5'].filter(Boolean).join(' ')

  return (
    <div className={`flex flex-col gap-1.5 self-start min-w-0 max-w-full ${margin}`}>
      {cards.map((card) => (
        <ToolCard key={card.id} title={card.title} status={card.status} />
      ))}
    </div>
  )
}
