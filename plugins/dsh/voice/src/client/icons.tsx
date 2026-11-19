// Line icons for the controls dsh's own icon set does not have. They draw in
// currentColor so the button's colour carries the state.

import type { ReactNode } from 'react'

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Voice on: five bars of a waveform, distinct from dsh's own dictation microphone. */
export function WaveformIcon() {
  return (
    <Svg>
      <path d="M2.5 6.6v2.8M5.2 4.4v7.2M8 2.4v11.2M10.8 5v6M13.5 6.8v2.4" />
    </Svg>
  )
}

export function MicIcon() {
  return (
    <Svg>
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
      <path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2.2" />
    </Svg>
  )
}

export function MicSlashIcon() {
  return (
    <Svg>
      <path d="M6 5.2V3.8a2 2 0 0 1 4 0v4.4M3.6 7.6a4.4 4.4 0 0 0 7.1 3.5M12.4 7.6c0 .5-.1 1-.3 1.4M8 12v2.2" />
      <path d="M2.2 2.2l11.6 11.6" />
    </Svg>
  )
}

export function SpeakerIcon() {
  return (
    <Svg>
      <path d="M2.4 6.2h2.2l3.2-2.6v8.8L4.6 9.8H2.4z" />
      <path d="M10.4 5.8a3.2 3.2 0 0 1 0 4.4M12 4a5.6 5.6 0 0 1 0 8" />
    </Svg>
  )
}

export function SpeakerSlashIcon() {
  return (
    <Svg>
      <path d="M2.4 6.2h2.2l3.2-2.6v8.8L4.6 9.8H2.4z" />
      <path d="M10.6 6.4l3 3M13.6 6.4l-3 3" />
    </Svg>
  )
}

export function LinkBreakIcon() {
  return (
    <Svg>
      <path d="M6.6 9.4l-1.2 1.2a2.2 2.2 0 0 1-3.1-3.1l1.7-1.7a2.2 2.2 0 0 1 3 0M9.4 6.6l1.2-1.2a2.2 2.2 0 0 1 3.1 3.1L12 10.2a2.2 2.2 0 0 1-3 0" />
      <path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4" />
    </Svg>
  )
}

export function CloseIcon() {
  return (
    <Svg>
      <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
    </Svg>
  )
}

/** A ring with a turning arc, animated in the SVG itself since the bundle carries no stylesheet. */
export function SpinnerIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="5.6" opacity="0.25" />
      <path d="M13.6 8a5.6 5.6 0 0 0-5.6-5.6">
        <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
      </path>
    </Svg>
  )
}
