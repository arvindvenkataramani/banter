import { Loader2, CheckCircle2, MinusCircle, XCircle, Circle } from 'lucide-react'
import { badgeVariants } from '@/components/ui/badge'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

interface Props {
  title: string
  status: 'running' | 'done' | 'interrupted' | 'error' | 'unknown'
}

// Line budgets are plain character counts, not measured pixel widths — the
// row is always one line at a fixed font size, so a constant is enough and
// needs no resize/measurement machinery. Two constants (not one responsive
// value) because the truncated *string* has to be picked at render time —
// CSS can hide/show either version per breakpoint, but can't itself decide
// where the ellipsis goes.
const LINE_BUDGET_DESKTOP = 100
const LINE_BUDGET_MOBILE = 55

const MAX_HEAD_UNITS = 3
const MAX_TAIL_UNITS = 8

// Splits after whitespace and after '/' — so one long path still yields
// several units instead of being stuck as a single unsplittable blob.
// Units keep their trailing separator, so joining them back together needs
// no extra spacing logic.
function splitAtWordAndPathBoundaries(text: string): string[] {
  return text.split(/(?<=\s)|(?<=\/)/).filter((u) => u.length > 0)
}

// Keeps the start of the argument (what kind of call, what it's roughly
// doing) and its end (often the most identifying part — a filename, the
// tail of a path), collapsing whatever's between them with a single
// ellipsis. Tries progressively fewer head/tail units until the result
// fits budget, so a long path contributes as many segments as space
// allows rather than being included whole or not at all. Returns the
// input unchanged if it already fits.
function truncateMiddle(title: string, budget: number): string {
  if (title.length <= budget) return title

  const colonIdx = title.indexOf(': ')
  const prefix = colonIdx === -1 ? '' : title.slice(0, colonIdx + 2)
  const rest = colonIdx === -1 ? title : title.slice(colonIdx + 2)
  const units = splitAtWordAndPathBoundaries(rest)

  // Shrinks the tail first (it's usually less identifying to lose one of
  // several tail units than to lose the only head unit), then gives up a
  // head unit and retries — the smallest change that gets closer to budget.
  for (let headCount = Math.min(MAX_HEAD_UNITS, units.length); headCount >= 1; headCount--) {
    for (let tailCount = Math.min(MAX_TAIL_UNITS, units.length - headCount); tailCount >= 0; tailCount--) {
      const head = units.slice(0, headCount).join('').trimEnd()
      const tail = units.slice(units.length - tailCount).join('')
      const truncated = `${prefix}${head}…${tail}`
      if (truncated.length <= budget) return truncated
    }
  }

  // Not even one unit on each side fits — hard character clip as a last resort.
  return `${title.slice(0, Math.max(budget - 1, 0))}…`
}

// "Doing X" presence badge. Titles are usually short (a tool name, maybe one
// arg) and render as plain, non-interactive single-line text — nothing to
// expand when the whole thing is already visible. Longer titles (a full
// shell command, a long path) get a middle-truncated single line instead of
// wrapping or end-clipping, so the density stays high in the tool-run list,
// and become a click-to-expand affordance revealing the untruncated text.
// Built on Collapsible rather than a hand-rolled button so expand/collapse
// keyboard and aria semantics come from Radix, not reimplemented here.
// Interrupted (an abort artifact) renders as interrupted, never as a
// failure — only a genuine tool error gets destructive styling. 'unknown'
// is history-seeded calls whose result row couldn't be matched — no
// checkmark, since we have no evidence the call actually succeeded.
export function ToolCard({ title, status }: Props) {
  const variant = status === 'error' ? 'destructive' : status === 'done' ? 'secondary' : 'outline'

  const desktopTitle = truncateMiddle(title, LINE_BUDGET_DESKTOP)
  const mobileTitle = truncateMiddle(title, LINE_BUDGET_MOBILE)
  const canExpand = desktopTitle !== title || mobileTitle !== title

  const icon = status === 'running' ? <Loader2 className="shrink-0 animate-spin" />
    : status === 'done' ? <CheckCircle2 className="shrink-0" />
    : status === 'interrupted' ? <MinusCircle className="shrink-0" />
    : status === 'error' ? <XCircle className="shrink-0" />
    : <Circle className="shrink-0" />

  // justify-start overrides badgeVariants' centered layout — with an icon and
  // long text as flex siblings, center justification clips both edges on
  // overflow instead of just the trailing one.
  const pillClassName = cn(badgeVariants({ variant }), 'self-start min-w-0 max-w-full justify-start')
  const titleText = (
    <span className="min-w-0 whitespace-nowrap">
      <span className="md:hidden">{mobileTitle}</span>
      <span className="hidden md:inline">{desktopTitle}</span>
    </span>
  )

  if (!canExpand) {
    return (
      <span className={pillClassName}>
        {icon}
        {titleText}
      </span>
    )
  }

  return (
    <Collapsible className="self-start min-w-0 max-w-full">
      <CollapsibleTrigger className={cn(pillClassName, 'cursor-pointer text-left')}>
        {icon}
        {titleText}
      </CollapsibleTrigger>
      {/* pl-6 (24px) lines the text up with the trigger's own text, which
          sits past its px-2 padding, size-3 icon, and gap-1 between them. */}
      <CollapsibleContent className="w-full whitespace-normal break-words py-1 pr-2 pl-6 text-xs text-foreground">
        {title}
      </CollapsibleContent>
    </Collapsible>
  )
}
