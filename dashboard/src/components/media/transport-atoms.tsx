import { useCallback, useRef } from 'react'
import { X } from 'lucide-react'
// The per-icon subpath, not the '@phosphor-icons/react' barrel: the barrel
// re-exports the whole icon set (hundreds of components) from one module,
// which every test file importing anything from this file pays to
// transform on each vi.resetModules() cycle — ~2.6s per test in this repo's
// suite, enough to blow past frozen tests' default timeouts. The subpath
// import is ~8ms. U-H19 pins the component and its weight, not this path.
import { ArticleNyTimes } from '@phosphor-icons/react/dist/csr/ArticleNyTimes'
import { cn } from '@/lib/utils'
import { StepRing } from '../step-ring'
import { seekBy, seekTo } from '@/lib/media-engine'
import { formatDuration } from '@/features/media/format'
import { useContentConfig } from '@/lib/use-content-config'

// Connected atoms for the playback transport — the sharing unit (run design
// §Component structure, U-H2). Each wires to the media engine's store once
// and owns its own visual identity; size varies by context (the mobile
// player card vs. the pill), never behaviour. None of these read a media
// items list (U-H6) — everything comes from the engine's own track.
//
// Values throughout are the design bundle's
// (dashboard/design-handoff/Sutradhara Platform-media player.zip → dock-and-chat-pill.html),
// recreated with Tailwind arbitrary values against the app's own tokens
// rather than the handoff's --chip-* names, which don't exist here.

type Size = 'sm' | 'md'

// ── Rewind 15 / Forward 30 ──────────────────────────────────────────────────

interface StepButtonProps {
  size: Size
  disabled?: boolean
}

export function RewindButton({ size }: StepButtonProps) {
  return (
    <button
      type="button"
      aria-label="Rewind 15 seconds"
      title="Rewind 15 seconds"
      onClick={() => seekBy(-15)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-transparent text-foreground transition-colors hover:bg-accent',
        size === 'md' ? 'size-11' : 'size-8',
      )}
    >
      <StepRing seconds={15} direction="back" size={size === 'md' ? 27 : 24} />
    </button>
  )
}

/** H17: disabled while duration is unknown is a control-level guard, not an
 * engine one — media-engine.ts's seekBy stays unguarded so rewind-15 and the
 * Media Session seek handlers keep working with duration unknown. */
export function ForwardButton({ size, disabled }: StepButtonProps) {
  return (
    <button
      type="button"
      aria-label="Skip forward 30 seconds"
      title="Skip forward 30 seconds"
      disabled={disabled}
      onClick={() => seekBy(30)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-transparent text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40',
        size === 'md' ? 'size-11' : 'size-8',
      )}
    >
      <StepRing seconds={30} direction="forward" size={size === 'md' ? 27 : 24} />
    </button>
  )
}

// ── Play / pause ─────────────────────────────────────────────────────────

interface PlayPauseProps {
  isPlaying: boolean
  onToggle: () => void
  size: 'sm32' | 'sm26' | 'md48'
}

const PLAY_SIZE: Record<PlayPauseProps['size'], { box: string; icon: string }> = {
  sm26: { box: 'size-6.5', icon: 'size-3' },
  sm32: { box: 'size-8', icon: 'size-3.5' },
  md48: { box: 'size-12', icon: 'size-5' },
}

export function PlayPauseButton({ isPlaying, onToggle, size }: PlayPauseProps) {
  const { box, icon } = PLAY_SIZE[size]
  return (
    <button
      type="button"
      aria-label={isPlaying ? 'Pause' : 'Play'}
      onClick={onToggle}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-foreground text-background',
        box,
      )}
    >
      {isPlaying ? (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={icon}>
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn(icon, 'translate-x-[1px]')}>
          <path d="M6 4.5v15l13-7.5z" />
        </svg>
      )}
    </button>
  )
}

// ── Close ────────────────────────────────────────────────────────────────

export function CloseButton({ onClose, size = 'md' }: { onClose: () => void; size?: Size }) {
  return (
    <button
      type="button"
      aria-label="Close"
      title="Stop"
      onClick={onClose}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        size === 'md' ? 'size-9' : 'size-6',
      )}
    >
      <X className={size === 'md' ? 'size-3.5' : 'size-3'} />
    </button>
  )
}

// ── Source text ──────────────────────────────────────────────────────────
//
// H23: present only for an item that has a sidecar, and only on the Media
// page — this component is mounted only by Media's own arrangement, so "only
// on Media" is enforced by placement, not by a prop here. Opens the sidecar
// in the vault via the same obsidian://open scheme vault-links.ts uses for
// project notes — sourceText is a media-folder-relative path, not a project
// slug, so it's built directly here rather than through vault-links.ts's
// project-specific helpers.

export function SourceTextButton({ sourceText, size = 'md' }: { sourceText: string; size?: Size }) {
  const { links } = useContentConfig()
  const href = `obsidian://open?vault=${encodeURIComponent(links.vaultName)}&file=${encodeURIComponent(sourceText.replace(/\.md$/, ''))}`
  return (
    <a
      href={href}
      role="button"
      aria-label="Open source text"
      title="Open source text"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-transparent text-[color-mix(in_oklch,var(--foreground)_72%,transparent)] transition-colors hover:bg-accent hover:text-foreground',
        size === 'md' ? 'size-12' : 'size-9',
      )}
    >
      {/* 48px slot with a 20px glyph in the mobile card, 36px with 18px in
          the pill (README §2 left slot, §5; glyphs/README.md §3). */}
      <ArticleNyTimes weight="regular" className={size === 'md' ? 'size-5' : 'size-[18px]'} />
    </a>
  )
}

/** 1px x 24px divider before the close control, separating the conditional
 * source-text control so dismissing playback stays the outermost control. */
export function TransportDivider() {
  return (
    <div
      aria-hidden="true"
      className="h-6 w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
    />
  )
}

// ── Title + time ─────────────────────────────────────────────────────────

export function TrackTitleTime({
  title,
  currentTime,
  manifestDuration,
  elementDuration,
  size = 'md',
}: {
  title: string
  currentTime: number
  /** B20: manifest duration is preferred for display; the element's own
   * duration fills in once known if the manifest never had one. */
  manifestDuration: number | null
  elementDuration: number | null
  size?: Size
}) {
  const displayTotal = manifestDuration ?? elementDuration
  const totalKnown = displayTotal !== null && Number.isFinite(displayTotal) && displayTotal > 0
  const totalLabel = totalKnown ? formatDuration(displayTotal) : '—'
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <span className={cn('truncate font-medium', size === 'md' ? 'text-xs' : 'text-[12.5px]')}>{title}</span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {formatDuration(currentTime)} /{' '}
        {/* A standalone <span> only when the total comes from the live
            element (manifest duration null): that's the one case where no
            other node on the page already renders this exact string, so a
            query needs a distinct node to find it. With a non-null manifest
            duration the row already shows the same formatted value
            elsewhere (the library row), and wrapping the placeholder "—" in
            its own node here would collide with another null-duration row's
            own "—" whenever both are on the page — so this stays combined
            text in every other case. */}
        {manifestDuration === null && totalKnown ? <span>{totalLabel}</span> : totalLabel}
      </span>
    </div>
  )
}

// ── Scrubber ─────────────────────────────────────────────────────────────

export function Scrubber({
  title,
  currentTime,
  elementDuration,
}: {
  title: string
  currentTime: number
  /** Always the live element's duration for the slider (H20/H21) — never
   * the manifest's. */
  elementDuration: number | null
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const durationKnown = elementDuration !== null && Number.isFinite(elementDuration) && elementDuration > 0

  const seekToClientX = useCallback(
    (clientX: number) => {
      if (!durationKnown || !trackRef.current) return
      const rect = trackRef.current.getBoundingClientRect()
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
      const clamped = Math.min(1, Math.max(0, ratio))
      seekTo(clamped * (elementDuration as number))
    },
    [durationKnown, elementDuration],
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!durationKnown) return
    const total = elementDuration as number
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      seekBy(5)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      seekBy(-5)
    } else if (e.key === 'Home') {
      e.preventDefault()
      seekTo(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      seekTo(total)
    }
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={`${title} progress`}
      aria-valuemin={0}
      aria-valuemax={durationKnown ? (elementDuration as number) : undefined}
      aria-valuenow={durationKnown ? currentTime : undefined}
      aria-disabled={!durationKnown}
      className={cn('relative -my-1.5 w-full py-3', durationKnown ? 'cursor-pointer' : 'cursor-not-allowed')}
      onClick={(e) => seekToClientX(e.clientX)}
      onKeyDown={handleKeyDown}
    >
      <div className="h-[2px] w-full overflow-hidden rounded-full bg-muted-foreground/20">
        <div
          className="h-full w-[var(--p)] rounded-full bg-foreground"
          style={{
            '--p': `${durationKnown ? Math.min(100, Math.max(0, (currentTime / (elementDuration as number)) * 100)) : 0}%`,
          } as React.CSSProperties}
        />
      </div>
    </div>
  )
}
