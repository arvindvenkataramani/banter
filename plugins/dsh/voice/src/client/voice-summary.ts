// The settings page's summary of Banter's voice settings: one row per setting, as
// GET /api/voice serves them. A stored selection Banter cannot call carries the
// selection check's message on its row (docs/reference/design/service-apis.md, "Selections").

import { loadVoiceSelection, type VoiceConfig } from '@platform/voice-engine/voice-config'
import { resolveChunkingFor } from '@platform/voice-engine/agent/chunking-setting'

export interface SummaryRow {
  label: string
  value: string
  /** Why the stored selection on this row cannot be used. */
  problem?: string
}

const MODE_NAMES: Record<string, string> = { 'two-chunk': '2-chunk', paragraph: 'Paragraph', sentence: 'Sentence', greedy: 'Greedy' }

export function voiceSummary(config: VoiceConfig): SummaryRow[] {
  const sel = config.tts.selection
  const provider = config.tts.providers.find(p => p.serviceId === sel?.serviceId)
  const model = config.tts.models.find(m => m.id === sel?.model)
  const voice = config.tts.voices.find(v => v.id === sel?.voice)
  const stt = config.stt?.options?.find(o => o.serviceId === config.stt?.serviceId)
  const resolved = loadVoiceSelection(config)
  const chunking = resolved ? resolveChunkingFor(config, resolved) : null
  return [
    {
      label: 'Transcription',
      value: config.stt?.serviceId
        ? [stt?.name ?? config.stt.serviceId, config.stt.model, config.stt.preferStreaming === true ? 'streaming' : 'batch'].filter(Boolean).join(' · ')
        : 'None chosen',
      ...(config.stt?.selectionError !== undefined && { problem: config.stt.selectionError }),
    },
    {
      label: 'Voice',
      value: sel ? [provider?.name ?? sel.serviceId, model?.name ?? sel.model, voice?.name ?? sel.voice].join(' · ') : 'None chosen',
      ...(sel?.selectionError !== undefined && { problem: sel.selectionError }),
    },
    { label: 'Speed', value: `${(sel?.speed ?? 1).toFixed(1)}x` },
    { label: 'Chunking', value: chunking ? (MODE_NAMES[chunking.strategy] ?? chunking.strategy) : '—' },
    { label: 'Take-over', value: config.takeover === 'always' ? 'Always take over' : 'Ask first' },
  ]
}
