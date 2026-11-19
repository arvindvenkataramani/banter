// The voice control in dsh's composer tool row.

import { Button, IconMicrophoneOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

export function VoiceButton() {
  return (
    <Button aria-label="Voice on" title="Voice on" data-dsh-voice="on" size="sm">
      <IconMicrophoneOutlineRegular size={16} />
    </Button>
  )
}
