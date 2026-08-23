import { useState } from 'react'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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

interface Props {
  serviceId: string
  serviceName: string
  disabled?: boolean
}

export function ServiceHistory({ serviceId, serviceName, disabled }: Props) {
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(false)

  async function handleOpen(open: boolean) {
    if (!open) return
    setLoading(true)
    try {
      const data = await getEvents({ limit: 10, subjectId: serviceId })
      setEvents(data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog onOpenChange={handleOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <History />
          History
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{serviceName} · History</DialogTitle>
        </DialogHeader>
        <div className="pt-2">
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-muted-foreground">No events recorded.</p>
          ) : (
            <div className="space-y-2">
              {events.map((evt) => (
                <div key={evt.id} className="flex items-start gap-3 text-xs">
                  <span className="text-muted-foreground shrink-0 tabular-nums w-14">
                    {relativeTime(evt.timestamp)}
                  </span>
                  <span className="font-mono shrink-0">{evt.type}</span>
                  {Object.keys(evt.data).length > 0 && (
                    <span className="text-muted-foreground truncate">{dataSummary(evt.data)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
