// The voice controls in dsh's composer tool row. Banter's composer set, in
// Banter's order; state is carried by colour on the buttons, never by text.

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { loopStateFromSnapshot, playbackStateFromSnapshot } from '@platform/voice-engine/floor-selectors'
import { relinkMutes, toggleSpeechMuted, useMuteStore } from '@platform/voice-engine/human/mute-store'
import { useTurnManagerStore } from '@platform/voice-engine/store/turn-manager-store'
import { useVoiceSystemStore } from '@platform/voice-engine/system/voice-system'
import type { DshSessionSlotProps } from './dsh-types.ts'
import { CloseIcon, LinkBreakIcon, MicIcon, MicSlashIcon, SpeakerIcon, SpeakerSlashIcon, SpinnerIcon } from './icons.tsx'
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
        <SpinnerIcon />
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
            <LinkBreakIcon />
          </Control>
        )}
        <Control
          name="speech"
          title={speechMuted ? 'Unmute speech' : 'Mute speech only'}
          style={speechMuted ? MUTED : playing ? HEARING : undefined}
          onClick={toggleSpeechMuted}
        >
          {speechMuted ? <SpeakerSlashIcon /> : <SpeakerIcon />}
        </Control>
        <Control
          name="mic"
          title={`${micMuted ? 'Unmute' : 'Mute'} ${muteLinked ? 'everything' : 'the mic'}`}
          style={mic}
          onClick={() => { runtime.toggleMic() }}
        >
          {micMuted ? <MicSlashIcon /> : <MicIcon />}
        </Control>
        <Control name="off" title="Turn voice off" onClick={() => { runtime.stop() }}>
          <CloseIcon />
        </Control>
      </>
    )
  }

  const ended = lastEnd !== null && lastEnd.reason !== 'user' ? lastEnd : null
  const held = ended?.reason === 'held'
  const title = ended === null
    ? 'Turn voice on'
    : held
      ? 'Another session is using the transcription server. Press to take it over; that session\'s voice will end.'
      : ended.message || ui.notice || 'Voice ended'
  return (
    <Control name="on" title={title} style={ended === null ? undefined : ERROR} onClick={() => { runtime.start(sessionId, held ? { takeover: true } : undefined) }}>
      <MicIcon />
    </Control>
  )
}
