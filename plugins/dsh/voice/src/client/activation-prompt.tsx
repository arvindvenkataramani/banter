// Shown when the person enables the bundle: asks for the microphone and
// checks the configured speech services through the relay.

import { useEffect, useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { checkService } from './services.ts'
import type { VoiceRuntime } from './runtime.ts'

export interface ActivationPromptProps {
  runtime: VoiceRuntime
  origin: string
  onDismiss(): void
  onOpenDetails(): void
}

type MicState = { phase: 'idle' | 'asking' | 'granted' } | { phase: 'denied'; reason: string }
interface ServiceLine { id: string; healthy: boolean; detail: string }

export function ActivationPrompt({ runtime, origin, onDismiss, onOpenDetails }: ActivationPromptProps) {
  const [mic, setMic] = useState<MicState>({ phase: 'idle' })
  const [services, setServices] = useState<ServiceLine[] | null>(null)

  useEffect(() => {
    const { sttServiceId, ttsServiceId } = runtime.settings()
    const ids = [...new Set([sttServiceId, ttsServiceId].filter(id => id !== ''))]
    let current = true
    void Promise.all(ids.map(async id => ({ id, ...await checkService({ origin, fetch: (...args) => fetch(...args) }, id) })))
      .then(lines => { if (current) setServices(lines) })
    return () => { current = false }
  }, [runtime, origin])

  const askForMicrophone = (): void => {
    setMic({ phase: 'asking' })
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      stream => {
        for (const track of stream.getTracks()) track.stop()
        setMic({ phase: 'granted' })
      },
      (err: unknown) => { setMic({ phase: 'denied', reason: err instanceof Error ? err.message : 'refused' }) },
    )
  }

  return (
    <Modal
      open
      title="Set up voice"
      closeLabel="Close"
      onClose={onDismiss}
      footer={(
        <>
          <Button variant="ghost" onClick={onDismiss}>Later</Button>
          <Button variant="primary" data-modal-autofocus onClick={onOpenDetails}>Open settings</Button>
        </>
      )}
    >
      <p>Voice needs your microphone and the speech services set in this plugin&apos;s settings.</p>
      <p>
        <Button variant="outline" disabled={mic.phase === 'asking' || mic.phase === 'granted'} onClick={askForMicrophone}>Allow microphone</Button>
        {' '}
        {mic.phase === 'granted' && 'Microphone allowed.'}
        {mic.phase === 'denied' && `Microphone not allowed: ${mic.reason}`}
      </p>
      {services === null && <p>Checking the speech services…</p>}
      {services?.length === 0 && <p>No speech services are set yet.</p>}
      {services?.map(line => <p key={line.id}>{line.id}: {line.detail}</p>)}
    </Modal>
  )
}
