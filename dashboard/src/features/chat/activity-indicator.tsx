interface Props {
  show: boolean
}

// A placeholder for the gap before the active run has produced any visible
// content — not a running commentary on what kind of work is happening
// (thinking vs. tool vs. streaming). Shown once at run start, hidden the
// moment the first delta or tool-card appears, and never shown again for
// that turn — simplified 2026-08-09 after the finer-grained per-event-kind
// version caused a visible flicker as event kinds interleaved mid-stream.
export function ActivityIndicator({ show }: Props) {
  if (!show) return null

  return (
    <div data-testid="activity-indicator" className="px-4 py-2 text-sm text-muted-foreground/60">
      Working…
    </div>
  )
}
