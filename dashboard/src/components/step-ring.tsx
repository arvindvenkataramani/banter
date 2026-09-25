import { cn } from '@/lib/utils'

// The ⟲15 / ⟳30 glyph. Lucide's RotateCcw/RotateCw put the step size beside
// the arrow as a separate numeral; this puts it inside the ring, so the step
// size is part of the glyph. glyphs/README.md §1-2 in the design bundle at
// the design-handoff zip under dashboard/design-handoff/.
//
// The SVG is the ring and arrowhead only (aria-hidden — the accessible name
// stays on the button). The numeral is composited as real text on top, on
// the mono type ramp, so a new step size is a string change, not a new
// drawing. Forward is the same paths mirrored via a CSS transform, not a
// second glyph.
//
// The sizing rule is scoped to this component's own elements only — a
// generic `svg { width }` rule elsewhere would shrink the ring while
// leaving the numeral at size (glyphs/README.md's own caution). Two sizes
// only (27px ring / 10px numeral on the mobile player card, 24px ring / 9px
// numeral in the pills), expressed as Tailwind variants rather than a
// numeric style prop — house rule: no style={{}} beyond CSS custom
// properties.

interface StepRingProps {
  /** Step size in seconds, rendered as the numeral inside the ring. */
  seconds: number
  direction: 'back' | 'forward'
  size: 27 | 24
  className?: string
}

export function StepRing({ seconds, direction, size, className }: StepRingProps) {
  return (
    <span
      className={cn(
        'relative inline-grid shrink-0 place-items-center',
        size === 27 ? 'size-[27px]' : 'size-6',
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={cn('col-start-1 row-start-1 size-full', direction === 'forward' && '-scale-x-100')}
      >
        <path
          d="M12 3.6 A8.4 8.4 0 1 1 6.1 6.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path d="M12.6 0.9 12.6 6.3 8.6 3.6Z" fill="currentColor" />
      </svg>
      <b
        aria-hidden="true"
        className={cn(
          'col-start-1 row-start-1 font-mono leading-none font-semibold tracking-[-0.03em]',
          size === 27 ? 'text-[10px]' : 'text-[9px]',
        )}
      >
        {seconds}
      </b>
    </span>
  )
}
