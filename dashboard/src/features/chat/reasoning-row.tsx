import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

interface Props {
  text: string
  running: boolean
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

// The trailing line is clipped by CSS rather than by a character budget: it
// changes on every delta, and where it ends depends on container width and
// font, which only the browser knows.
//
// Running shows the latest line scrolled to its right edge, so it reads as a
// single ticking line of work. Settled shows the first line from the start, a
// stable preview of what was explored. Expansion is the reader's own state and
// survives both — a row opened mid-run keeps growing rather than collapsing
// under them.
export function ReasoningRow({ text, running }: Props) {
  const [expanded, setExpanded] = useState(false)
  const lineRef = useRef<HTMLSpanElement>(null)
  const line = running ? latestLine(text) : firstLine(text)
  const frameRef = useRef<number | null>(null)

  // Coalesced onto an animation frame: reasoning arrives faster than reply
  // text, and a scroll write per delta would land on the render path.
  useEffect(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const el = lineRef.current
      if (el) el.scrollLeft = running ? el.scrollWidth - el.clientWidth : 0
    })
    return () => {
      if (frameRef.current === null) return
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [line, running])

  // The right inset keeps the trailing line clear of the column edge, where it
  // would otherwise run flush and read as overflowing rather than clipped.
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="self-start w-full min-w-0 pr-6">
      <CollapsibleTrigger className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground">
        <span className="shrink-0">Explore</span>
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        {!expanded && (
          <span ref={lineRef} className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground/70">
            {line}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full whitespace-pre-wrap break-words py-1 pl-2 text-xs text-muted-foreground">
        {text}
      </CollapsibleContent>
    </Collapsible>
  )
}
