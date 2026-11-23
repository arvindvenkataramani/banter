import { useState, useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { toast } from 'sonner'
import { fetchVoiceConfig, loadVoiceSelection, unloadTtsModel, setSaveMicSamples } from '@/lib/voice'
import { useVoiceSessionStore, setVoiceConfig, setVoiceSelection } from '@platform/voice-engine/voice-session-store'
import { applySavedVoiceSettings } from '@/lib/voice/apply-voice-settings'
import { updateVoiceSelection } from '@/lib/api'
import type { VoiceUpdateResult } from '@/lib/api'
import { buildPatch, seedDraft, type Draft } from './voice-settings-model'
import { GeneralPanel, HelpPanel, ListeningPanel, SpeechPanel, type Edit } from './voice-settings-panels'

export interface VoiceSettingsTabs {
  /** 'loading' until the voice config is in hand; 'unconfigured' when it
   * names no usable voice. The panels are empty in both. */
  status: 'loading' | 'unconfigured' | 'ready'
  speech: React.ReactNode
  listening: React.ReactNode
  general: React.ReactNode
  help: React.ReactNode
  /** Saves whatever the tabs changed, and does nothing when they changed
   * nothing. Resolves false when the save failed; the failure is toasted. */
  save: () => Promise<boolean>
}


/**
 * Voice mode's settings as tabs for the Settings dialog. Every value is
 * staged: nothing reaches the running voice loop until save(), and the draft
 * is seeded afresh each time the dialog opens, so Cancel is a true undo.
 *
 * Config normally arrives with the chat page; when the dialog opens before
 * that has happened, it is fetched here and published to the same store.
 */
export function useVoiceSettings(open: boolean): VoiceSettingsTabs {
  const voiceConfig = useStore(useVoiceSessionStore, (s) => s.voiceConfig)
  const selection = useStore(useVoiceSessionStore, (s) => s.voiceSelection)
  const endpoint = useStore(useVoiceSessionStore, (s) => s.ttsEndpoint)
  const [draft, setDraft] = useState<Draft | null>(null)

  // One attempt per open, so a failed fetch is retried by reopening.
  const fetching = useRef(false)
  useEffect(() => {
    if (!open) {
      fetching.current = false
      return
    }
    if (voiceConfig || fetching.current) return
    fetching.current = true
    fetchVoiceConfig().then(cfg => {
      if (!cfg) return
      setVoiceConfig(cfg)
      setSaveMicSamples(cfg.debug?.saveMicSamples ?? false)
      setVoiceSelection(loadVoiceSelection(cfg))
    })
  }, [open, voiceConfig])

  // Seeded once per open, as soon as config is in hand. Re-seeding on every
  // config change would throw away edits made while the dialog is open.
  const seeded = useRef(false)
  useEffect(() => {
    if (!open) {
      seeded.current = false
      return
    }
    if (seeded.current || !voiceConfig || !selection) return
    seeded.current = true
    setDraft(seedDraft(voiceConfig, selection))
  }, [open, voiceConfig, selection])

  const status: VoiceSettingsTabs['status'] =
    !voiceConfig ? 'loading' : !selection ? 'unconfigured' : 'ready'

  async function save(): Promise<boolean> {
    if (!draft || !selection || !seeded.current) return true
    const patch = buildPatch(draft)
    if (patch === null) return true

    const loadedModel = selection.request?.model
    if (endpoint && typeof loadedModel === 'string' && selection.model !== draft.ttsModel) {
      unloadTtsModel(endpoint, loadedModel)
    }
    let updated: VoiceUpdateResult
    try {
      updated = await updateVoiceSelection(patch)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`Voice settings not saved: ${message}`)
      return false
    }
    // The PATCH answers with the new selection and the shard's resolution of it.
    const served = updated.tts?.selection ?? { serviceId: draft.ttsServiceId, model: draft.ttsModel, voice: draft.ttsVoice, speed: draft.ttsSpeed }
    const sel = loadVoiceSelection({ ...draft.config, tts: { ...draft.config.tts, selection: served } })!
    setSaveMicSamples(draft.saveMicSamples)
    applySavedVoiceSettings(sel, patch.sttServiceId, updated)
    return true
  }

  if (status !== 'ready' || draft === null) {
    return { status: status === 'ready' ? 'loading' : status, speech: null, listening: null, general: null, help: null, save }
  }

  const edit: Edit = (change) => { setDraft(current => (current === null ? current : change(current))) }

  return {
    status,
    speech: <SpeechPanel draft={draft} edit={edit} />,
    listening: <ListeningPanel draft={draft} edit={edit} />,
    general: <GeneralPanel draft={draft} edit={edit} />,
    help: <HelpPanel />,
    save,
  }
}

