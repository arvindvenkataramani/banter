import type { CompactionPhase } from '@/lib/session'
import { Loader2, CheckCircle2 } from 'lucide-react'

interface Props {
  phase: CompactionPhase
}

export function CompactionIndicator({ phase }: Props) {
  if (!phase) return null

  const isSpinning = phase === 'active' || phase === 'retrying'
  const label =
    phase === 'active' ? 'Compacting context...' :
    phase === 'retrying' ? 'Retrying after compaction...' :
    'Context compacted'

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
    >
      {isSpinning ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <CheckCircle2 className="h-3 w-3 text-green-500" />
      )}
      <span>{label}</span>
    </div>
  )
}
