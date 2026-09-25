import { Badge } from '@/components/ui/badge'
import type { FieldOrigin } from '@/lib/voice/model-settings'

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

export function FieldProvenance({ origin, modelName, diverges }: {
  origin: FieldOrigin
  modelName: string
  diverges: Array<{ label: string; value: string }>
}) {
  const badgeText =
    origin === 'override' ? 'Yours'
      : origin === 'model' ? `From ${modelName}`
        : origin === 'global' ? 'Global'
          : 'Default'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="text-xs">{badgeText}</Badge>
      {diverges.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {diverges.map(d => `${d.label} ${d.value}`).join(' · ')}
        </span>
      )}
    </div>
  )
}
