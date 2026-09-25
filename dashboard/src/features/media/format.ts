// Duration formatting shared by the list rows and the player pill: m:ss, or
// h:mm:ss once the total reaches an hour. `null`/`NaN` render as "—".
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${ss}`
  }
  return `${m}:${ss}`
}

// Relative age from an ISO createdAt. Same shape as
// features/services/service-card.tsx's `relativeTime`, extended with
// day/month/year buckets since media items can be much older than a
// service's last event.
export function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(months / 12)
  return `${years}y ago`
}
