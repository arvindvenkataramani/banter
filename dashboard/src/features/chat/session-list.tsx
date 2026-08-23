import type { SessionListEntry } from '@/lib/gateway-types'
import { ScrollArea } from '@/components/ui/scroll-area'

interface Props {
  sessions: SessionListEntry[]
  currentSessionName: string
  onSelect: (sessionName: string) => void
}

function relativeTime(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function SessionList({ sessions, currentSessionName, onSelect }: Props) {
  if (!sessions.length) {
    return (
      <p className="px-3 py-6 text-[12.5px] text-muted-foreground">
        No conversations yet.
      </p>
    )
  }

  return (
    // Radix's scroll viewport wraps children in a display:table element, which
    // sizes to content rather than the viewport. Force it back to a block.
    <ScrollArea className="h-full [&>[data-radix-scroll-area-viewport]>div]:block!">
      <div className="flex flex-col gap-0.5 pb-2">
        {sessions.map((s) => {
          const isCurrent = s.name === currentSessionName
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onSelect(s.name)}
              aria-current={isCurrent ? 'true' : undefined}
              className={`w-full min-w-0 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.06] ${
                isCurrent ? 'bg-foreground/[0.06]' : ''
              }`}
            >
              {/* min-w-0 at every level: flex items default to min-width:auto. */}
              <div className="flex min-w-0 items-baseline gap-2">
                <p className={`min-w-0 flex-1 truncate text-[13px] ${isCurrent ? 'text-foreground font-medium' : 'text-foreground/90'}`}>
                  {s.title}
                </p>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {relativeTime(s.updatedAt)}
                </span>
              </div>
              {s.preview && (
                <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{s.preview}</p>
              )}
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}
