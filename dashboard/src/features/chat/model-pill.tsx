import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface ModelOption {
  id: string
  label: string
}

interface Props {
  models: ModelOption[]
  currentModel: string
  onModelChange: (id: string) => void
}

// pl-0: the trigger sits at the composer's own left inset (pl-4 on the
// container), same as the textarea above it (which has no extra padding of
// its own) — any left padding here would offset the label text from the
// placeholder text above it.
const modelPillClass = "h-7 gap-1 rounded-md border-transparent bg-transparent pl-0 pr-1.5 text-xs font-sans font-[480] text-muted-foreground shadow-none hover:text-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] [&>svg]:size-[11px] [&>svg]:opacity-70"

const modelPopupClass = "rounded-xl"

/**
 * Mobile model-selector trigger: quiet text-only control (no border, no
 * pill shape) so it doesn't compete with the voice cluster/composer footer
 * for attention — deliberately lighter than the mobile handoff's literal
 * spec (1px border, rounded-full, 22px side padding), which read as too
 * prominent in review. Reuses the desktop Select popover for picking rather
 * than a bottom sheet — just a different trigger style around the same
 * primitive. The popup's radius is also tightened from the app-wide
 * rounded-3xl default, which read as oversized for a compact 2-4 item list.
 */
export function ModelPill({ models, currentModel, onModelChange }: Props) {
  return (
    <Select value={currentModel} onValueChange={onModelChange}>
      <SelectTrigger className={modelPillClass}>
        <SelectValue placeholder="Model" />
      </SelectTrigger>
      <SelectContent className={modelPopupClass}>
        {models.map((m) => (
          <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
