import { useEffect, useState } from 'react'
import { getEvents, type Event } from '@/lib/api'

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function dataSummary(data: Record<string, unknown>): string {
  return Object.entries(data).map(([k, v]) => `${k}: ${String(v)}`).join(', ')
}

/** The event list on its own, for embedding where a dialog is already open. */
export function ServiceHistoryList({ serviceId }: { serviceId: string }) {
  // Loading is derived: the stored result belongs to one service, so a
  // different serviceId reads as loading without a setState in the effect.
  const [result, setResult] = useState<{ serviceId: string; events: Event[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    getEvents({ limit: 10, subjectId: serviceId })
      .then((data) => { if (!cancelled) setResult({ serviceId, events: data }) })
      .catch(() => { if (!cancelled) setResult({ serviceId, events: [] }) })
    return () => { cancelled = true }
  }, [serviceId])

  const loaded = result?.serviceId === serviceId
  return <EventList events={loaded ? result.events : []} loading={!loaded} />
}

function EventList({ events, loading }: { events: Event[]; loading: boolean }) {
  if (loading) return <p className="text-xs text-muted-foreground">Loading…</p>
  if (events.length === 0) return <p className="text-xs text-muted-foreground">No events recorded.</p>

  return (
    <div className="space-y-2">
      {events.map((evt) => (
        <div key={evt.id} className="flex items-start gap-3 text-xs min-w-0">
          <span className="text-muted-foreground shrink-0 tabular-nums w-14">
            {relativeTime(evt.timestamp)}
          </span>
          <span className="font-mono shrink-0">{evt.type}</span>
          {Object.keys(evt.data).length > 0 && (
            <span className="text-muted-foreground min-w-0 break-all whitespace-pre-wrap">{dataSummary(evt.data)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

