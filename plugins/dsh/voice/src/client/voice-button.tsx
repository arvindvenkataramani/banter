// The voice controls in dsh's composer tool row. Banter's composer set, in
// Banter's order; state is carried by colour on the buttons, never by text.

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { loopStateFromSnapshot, playbackStateFromSnapshot } from '@platform/voice-engine/floor-selectors'
import { relinkMutes, toggleSpeechMuted, useMuteStore } from '@platform/voice-engine/human/mute-store'
import { useTurnManagerStore } from '@platform/voice-engine/store/turn-manager-store'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import type { DshSessionSlotProps } from './dsh-types.ts'
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch'
import { LinkBreakIcon } from '@phosphor-icons/react/dist/csr/LinkBreak'
import { MicrophoneIcon } from '@phosphor-icons/react/dist/csr/Microphone'
import { MicrophoneSlashIcon } from '@phosphor-icons/react/dist/csr/MicrophoneSlash'
import { SpeakerHighIcon } from '@phosphor-icons/react/dist/csr/SpeakerHigh'
import { SpeakerSlashIcon } from '@phosphor-icons/react/dist/csr/SpeakerSlash'
import { WaveformIcon } from '@phosphor-icons/react/dist/csr/Waveform'
import { XIcon } from '@phosphor-icons/react/dist/csr/X'
import type { VoiceRuntime } from './runtime.ts'
import { useBoxMirror } from './use-box-mirror.ts'

interface Subscribable<S> {
  subscribe(listener: () => void): () => void
  getState(): S
}

function useStoreValue<S, T>(store: Subscribable<S>, select: (state: S) => T): T {
  return useSyncExternalStore(listener => store.subscribe(listener), () => select(store.getState()))
}

/** Colours from dsh's theme tokens. */
const LISTENING: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)' }
const HEARING: CSSProperties = { color: 'var(--dsw-alias-state-success-primary)', background: 'var(--dsw-alias-state-success-tertiary)' }
const MUTED: CSSProperties = { color: 'var(--dsw-alias-state-warn-label)', background: 'var(--dsw-alias-state-warn-tertiary)' }
const MUTED_TYPING: CSSProperties = { color: 'var(--dsw-alias-state-warn-label)', boxShadow: 'inset 0 0 0 1px var(--dsw-alias-state-warn-primary)' }
const ERROR: CSSProperties = { color: 'var(--dsw-alias-state-error-primary)' }

const ICON_BUTTON: CSSProperties = { width: 28, padding: 0 }

/** Phosphor's regular weight at the size of dsh's outline icons; colour comes from currentColor. */
const ICON = 16

/** The turning ring: animated in the SVG itself, since the bundle carries no stylesheet. */
function Spinner() {
  return (
    <CircleNotchIcon size={ICON}>
      <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
    </CircleNotchIcon>
  )
}

function Control({ name, title, style, onClick, busy, children }: {
  name: string
  title: string
  style?: CSSProperties
  onClick(): void
  busy?: boolean
  children: ReactNode
}) {
  return (
    <Button
      data-dsh-voice={name}
      aria-label={title}
      aria-busy={busy}
      title={title}
      size="sm"
      style={{ ...ICON_BUTTON, ...style }}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

export interface VoiceControlsProps extends DshSessionSlotProps {
  runtime: VoiceRuntime
}

export function VoiceControls({ runtime, sessionId, useInput, inputActions }: VoiceControlsProps) {
  const phase = useStoreValue(useVoiceSystemStore, s => s.phase)
  const reconfiguring = useStoreValue(useVoiceSystemStore, s => s.reconfiguring)
  const lastEnd = useStoreValue(useVoiceSystemStore, s => s.lastEnd)
  const configLoaded = useSyncExternalStore(listener => runtime.feed.subscribe(listener), () => runtime.feed.state().config !== null)
  const micMuted = useStoreValue(useMuteStore, s => s.micMuted)
  const speechMuted = useStoreValue(useMuteStore, s => s.speechMuted)
  const muteLinked = useStoreValue(useMuteStore, s => s.muteLinked)
  const hearing = useStoreValue(useTurnManagerStore, () => loopStateFromSnapshot() === 'hearing')
  const playing = useStoreValue(useTurnManagerStore, () => playbackStateFromSnapshot() === 'playing')
  const ui = useSyncExternalStore(runtime.ui.subscribe, runtime.ui.get)
  const input = useInput(state => state)

  useBoxMirror({ runtime, sessionId, active: phase === 'live' && ui.attachedSessionId === sessionId, input, inputActions })

  if (phase === 'starting' || (phase === 'live' && reconfiguring)) {
    return (
      <Control name="starting" title="Starting voice — press to cancel" busy onClick={() => { runtime.stop() }}>
        <Spinner />
      </Control>
    )
  }

  if (phase === 'live') {
    let mic: CSSProperties = hearing ? HEARING : LISTENING
    if (micMuted) mic = ui.typing ? MUTED_TYPING : MUTED
    return (
      <>
        {!muteLinked && (
          <Control name="relink" title="Mic and speech are set separately — link them" onClick={relinkMutes}>
            <LinkBreakIcon size={ICON} />
          </Control>
        )}
        <Control
          name="speech"
          title={speechMuted ? 'Unmute speech' : 'Mute speech only'}
          style={speechMuted ? MUTED : playing ? HEARING : undefined}
          onClick={toggleSpeechMuted}
        >
          {speechMuted ? <SpeakerSlashIcon size={ICON} /> : <SpeakerHighIcon size={ICON} />}
        </Control>
        <Control
          name="mic"
          title={`${micMuted ? 'Unmute' : 'Mute'} ${muteLinked ? 'everything' : 'the mic'}`}
          style={mic}
          onClick={() => { runtime.toggleMic() }}
        >
          {micMuted ? <MicrophoneSlashIcon size={ICON} /> : <MicrophoneIcon size={ICON} />}
        </Control>
        <Control
          name="off"
          title={ui.notice === null ? 'Turn voice off' : `${ui.notice} — press to turn voice off`}
          style={ui.notice === null ? undefined : ERROR}
          onClick={() => { runtime.stop() }}
        >
          <XIcon size={ICON} />
        </Control>
      </>
    )
  }

  const ended = lastEnd !== null && lastEnd.reason !== 'user' ? lastEnd : null
  const held = ended?.reason === 'held'
  // A start refused because Banter's voice settings never loaded leaves no lastEnd, only the notice.
  const refused = ended === null && !configLoaded && ui.notice !== null ? ui.notice : null
  const title = refused !== null
    ? `${refused}. Press to try again.`
    : ended === null
      ? 'Turn voice on'
      : held
        ? 'Another session is using the transcription server. Press to take it over; that session\'s voice will end.'
        : ended.message || ui.notice || 'Voice ended'
  return (
    <Control name="on" title={title} style={ended === null && refused === null ? undefined : ERROR} onClick={() => { runtime.start(sessionId, held ? { takeover: true } : undefined) }}>
      <WaveformIcon size={ICON} />
    </Control>
  )
}
