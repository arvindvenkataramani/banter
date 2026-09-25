import { useState } from 'react'
import { useStore } from 'zustand'
import { AudioLines, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMediaEngine, toggle as toggleMedia, close as closeMedia } from '@/lib/media-engine'
import { useMediaVoiceState, useArmed, cancelArm } from '@/lib/media-voice-mode'
import {
  RewindButton, PlayPauseButton, ForwardButton, CloseButton, TrackTitleTime, Scrubber,
} from '@/components/media/transport-atoms'
import { useIsMobile } from '@/lib/use-is-mobile'
import { formatDuration } from '@/features/media/format'
import { ChatComposer } from './chat-composer'
import type { ComponentProps } from 'react'

// ComposerDock — the Chat-column host (U-H4). A flow child at the end of
// Chat's own column (README §6, "not absolutely positioned, or it covers
// the last message") that renders the whole Chat matrix column: the player
// row when media is loaded (states 4/6), the two-click gate's armed
// treatment, and the composer beneath, unchanged. Owns no logic of its own
// beyond arrangement selection — every value comes from the media engine's
// store or the props threaded down to ChatComposer (U-H3).
//
// The composer's own voice-on forms (ChatComposer's inline row / the
// caller's VoiceControlsMobile swap on mobile) are unaffected: with voice on
// nothing is loaded (H1), so the player row here never coexists with them.

type ComposerProps = ComponentProps<typeof ChatComposer>

export function ComposerDock(props: ComposerProps) {
  const track = useStore(useMediaEngine, (s) => s.track)
  const isPlaying = useStore(useMediaEngine, (s) => s.playing)
  const currentTime = useStore(useMediaEngine, (s) => s.currentTime)
  const elementDuration = useStore(useMediaEngine, (s) => s.elementDuration)
  const state = useMediaVoiceState()
  const armed = useArmed()
  const isMobile = useIsMobile()
  // README §3: blurring the field always restores the full row, drafted
  // text or not (§3 of the harmonisation spec, tier-1). The collapsed form
  // below is therefore keyed on focus alone, never on hasContent.
  const [fieldFocused, setFieldFocused] = useState(false)

  const hasPlayer = state === 4 || state === 6

  if (!hasPlayer) {
    // States 1-3: nothing to fuse. The composer renders exactly as it does
    // today — its own voice-on row (desktop) or the caller's
    // VoiceControlsMobile swap (mobile) already covers states 2/3.
    return <ChatComposer {...props} />
  }

  // Mobile focused form (README §3 "Focused form"): the transport collapses
  // into the composer's footer as a sibling arrangement, never a CSS morph
  // of the resting row (U-H3). The armed gate and the collapse cannot both
  // be showing — a field taking focus re-locks the gate (H7,
  // use-chat-textarea.ts's own cancelArm() call) before this branch would
  // ever need to choose between them.
  if (isMobile && fieldFocused) {
    return (
      <div className="overflow-hidden rounded-[1.25rem] bg-[var(--dock-fill)]">
        <ChatComposer
          {...props}
          onFocusedChange={setFieldFocused}
          collapsedPlayer={
            <CollapsedPlayer
              title={track!.title}
              isPlaying={isPlaying}
              currentTime={currentTime}
              elementDuration={elementDuration}
              onTogglePlay={() => void toggleMedia()}
              onClose={() => closeMedia()}
            />
          }
          embedded
        />
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-[1.25rem] bg-[var(--dock-fill)]">
      <PlayerRow
        title={track!.title}
        isPlaying={isPlaying}
        currentTime={currentTime}
        elementDuration={elementDuration}
        manifestDuration={track!.manifestDuration}
        armed={armed}
        isMobile={isMobile}
        onCancel={() => cancelArm()}
        onCommit={() => props.onVoiceToggle(true)}
        onTogglePlay={() => void toggleMedia()}
        onClose={() => closeMedia()}
      />
      {/* Desktop dims the transport while armed (README §4: "the player it
          will close dims to opacity: 0.45") — the commit/cancel pair itself
          lives in the composer's own cluster below, in the voice button's
          slot (ChatComposer's `gate` prop), not in this row. */}
      <div className={cn(armed && !isMobile && 'opacity-45')}>
        <ChatComposer
          {...props}
          onFocusedChange={setFieldFocused}
          gate={armed && !isMobile ? { onCommit: () => props.onVoiceToggle(true), onCancel: () => cancelArm() } : undefined}
          embedded
        />
      </div>
    </div>
  )
}

// ── The collapsed form (README §3 "Focused form") ───────────────────────
//
// Progress ring wrapping the play button — losing the bar would lose
// position with it, so the ring carries it. `--p` follows the same
// CSS-custom-property pattern transport-atoms.tsx's Scrubber uses for its
// own dynamic width (house rule: style={{}} only for custom properties).

function CollapsedPlayer({
  title, isPlaying, currentTime, elementDuration, onTogglePlay, onClose,
}: {
  title: string
  isPlaying: boolean
  currentTime: number
  elementDuration: number | null
  onTogglePlay: () => void
  onClose: () => void
}) {
  const durationKnown = elementDuration !== null && Number.isFinite(elementDuration) && elementDuration > 0
  const pct = durationKnown ? Math.min(100, Math.max(0, (currentTime / (elementDuration as number)) * 100)) : 0

  return (
    <div className="flex min-w-0 flex-1 items-center gap-[9px]">
      <div
        className="relative grid size-9 shrink-0 place-items-center rounded-full bg-[conic-gradient(var(--foreground)_0_var(--p),color-mix(in_oklch,var(--muted-foreground)_25%,transparent)_var(--p)_100%)] before:absolute before:inset-[2.5px] before:rounded-full before:bg-[var(--dock-fill)]"
        style={{ '--p': `${pct}%` } as React.CSSProperties}
      >
        <button
          type="button"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={onTogglePlay}
          className="relative flex size-[26px] items-center justify-center rounded-full bg-foreground text-background"
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-3">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-3 translate-x-[1px]">
              <path d="M6 4.5v15l13-7.5z" />
            </svg>
          )}
        </button>
      </div>
      <span className="min-w-0 flex-1 truncate text-xs font-normal">{title}</span>
      <button
        type="button"
        aria-label="Close"
        title="Stop"
        onClick={onClose}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
      {/* 1px x 22px divider — README §3: "so the transport's dismiss does
          not read as part of the voice cluster beside it." */}
      <div aria-hidden="true" className="ml-1.5 h-[22px] w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_14%,transparent)]" />
    </div>
  )
}

// ── The player row + gate ───────────────────────────────────────────────

interface PlayerRowProps {
  title: string
  isPlaying: boolean
  currentTime: number
  elementDuration: number | null
  manifestDuration: number | null
  armed: boolean
  isMobile: boolean
  /** Mobile's armed warning row only — desktop's commit/cancel pair lives in
   * ChatComposer's own cluster (its `gate` prop), not this row. */
  onCancel: () => void
  onCommit: () => void
  onTogglePlay: () => void
  onClose: () => void
}

function PlayerRow({
  title, isPlaying, currentTime, elementDuration, manifestDuration,
  armed, isMobile, onCancel, onCommit, onTogglePlay, onClose,
}: PlayerRowProps) {
  // Mobile armed: the player region's live content is replaced entirely by
  // the warning row (README §4 "Armed"). Desktop armed: this row just tints
  // and dims (its parent's opacity-45) — the labeled commit/cancel pair
  // itself renders in ChatComposer's own cluster below (README §4, "in
  // place in the composer cluster"), in the slot the plain voice-on button
  // otherwise occupies.
  if (armed && isMobile) {
    return (
      <div className="flex items-center gap-2 bg-[color-mix(in_oklch,var(--warning)_12%,transparent)] px-3 pt-2.5 pb-3">
        <p className="min-w-0 flex-1 text-[12.5px] leading-[1.35] text-[var(--warning-subtle-fg)]">
          Voice needs the audio. This closes what's playing.
        </p>
        <button
          type="button"
          onClick={onCommit}
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-[color-mix(in_oklch,var(--warning)_50%,transparent)] bg-[var(--warning-subtle)] px-3.5 text-[13px] font-medium text-[var(--warning-subtle-fg)]"
        >
          <AudioLines className="size-4" />
          Start voice
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-10 shrink-0 px-1.5 text-[13px] text-muted-foreground"
        >
          Keep
        </button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'border-b border-[color-mix(in_oklch,var(--foreground)_9%,transparent)]',
        // README §3 player region (mobile) 8px 10px 4px 12px; §6 transport
        // row (desktop) 8px 14px 8px 8px.
        isMobile ? 'pt-2 pr-2.5 pb-1 pl-3' : 'py-2 pr-3.5 pl-2',
        armed && 'bg-[color-mix(in_oklch,var(--warning)_12%,transparent)]',
      )}
    >
      {isMobile ? (
        <>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{title}</span>
            <TimeOnly currentTime={currentTime} manifestDuration={manifestDuration} elementDuration={elementDuration} />
            <CloseButton onClose={onClose} size="sm" />
          </div>
          <div className="flex items-center gap-2.5 pt-0.5">
            <RewindButton size="sm" />
            <PlayPauseButton isPlaying={isPlaying} onToggle={onTogglePlay} size="sm32" />
            <ForwardButton size="sm" disabled={elementDuration === null} />
            <div className="min-w-0 flex-1">
              <Scrubber title={title} currentTime={currentTime} elementDuration={elementDuration} />
            </div>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <RewindButton size="sm" />
          <PlayPauseButton isPlaying={isPlaying} onToggle={onTogglePlay} size="sm32" />
          <ForwardButton size="sm" disabled={elementDuration === null} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <TrackTitleTime
              title={title}
              currentTime={currentTime}
              manifestDuration={manifestDuration}
              elementDuration={elementDuration}
            />
            <Scrubber title={title} currentTime={currentTime} elementDuration={elementDuration} />
          </div>
          <CloseButton onClose={onClose} />
        </div>
      )}
    </div>
  )
}

function TimeOnly({
  currentTime, manifestDuration, elementDuration,
}: { currentTime: number; manifestDuration: number | null; elementDuration: number | null }) {
  const displayTotal = manifestDuration ?? elementDuration
  const totalKnown = displayTotal !== null && Number.isFinite(displayTotal) && displayTotal > 0
  return (
    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
      {formatDuration(currentTime)} / {totalKnown ? formatDuration(displayTotal) : '—'}
    </span>
  )
}
