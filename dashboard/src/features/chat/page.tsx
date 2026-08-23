import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Loader2, AudioLines, EyeClosed, ArrowDown } from 'lucide-react'
import { useSessionManager } from '@/lib/use-session-manager'
import { consumePendingChatLaunch } from '@/lib/chat-launch'
import { fetchVoiceConfig, loadSpeechEnabled, saveSpeechEnabled, loadVoiceSelection, loadTtsModel, resolveChunkingFor, useVoiceLoop, ensureServiceReady, setSaveMicSamples, MIC_AUDIO_CONSTRAINTS } from '@/lib/voice'
import type { VoiceConfig, VoiceSelection } from '@/lib/voice'
import { ensureTtsReady } from '@/lib/voice'
import { updateService } from '@/lib/api'
import { useWakeLock } from '@/lib/use-wake-lock'
import { overrideTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import { MessageList } from './message-list'
import { ChatComposer } from './chat-composer'
import { VoiceControlsMobile } from './voice-controls-mobile'
import { ModelPill } from './model-pill'
import { ControlBar } from './control-bar'
import { DisconnectBanner } from './disconnect-banner'
import { CompactionIndicator } from './compaction-indicator'
import { VoiceSettings } from './voice-settings'

interface Props {
  filter?: string
  navigate: (path: string, filter?: string) => void
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

type VoiceStatus = 'off' | 'loading' | 'ready' | 'error'

export function ChatPage(_props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)

  // Voice state
  const [voiceConfig, setVoiceConfig] = useState<VoiceConfig | null>(null)
  const [voiceSelection, setVoiceSelection] = useState<VoiceSelection | null>(null)
  const [speechEnabled, setSpeechEnabled] = useState<boolean>(() => loadSpeechEnabled())
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('off')
  const [ttsEndpoint, setTtsEndpoint] = useState<string | null>(null)
  const [sttEndpoint, setSttEndpoint] = useState<string | null>(null)
  const [unattended, setUnattended] = useState(false)
  // Mic stream acquired synchronously inside the speech-toggle tap so iOS
  // Safari sees the gesture and prompts for permission. Threaded down to
  // MicCapture via useVoiceLoop; auto-start (page reload with voice already
  // enabled) skips this and relies on cached permission via gUM fallback.
  const [micStream, setMicStream] = useState<MediaStream | null>(null)

  useWakeLock(unattended)

  useEffect(() => {
    if (!unattended) return
    const restore = overrideTheme('dark')
    return restore
  }, [unattended])

  const startVoiceServices = useCallback(async (cfg: VoiceConfig, sel: VoiceSelection) => {
    const provider = cfg.tts.providers.find(p => p.serviceId === sel.serviceId)
    if (!provider) throw new Error('TTS provider not found')
    setVoiceStatus('loading')
    const [ttsEp, sttEp] = await Promise.all([
      ensureTtsReady(provider.serviceId),
      cfg.stt?.serviceId ? ensureServiceReady(cfg.stt.serviceId) : Promise.resolve(null),
    ])
    setTtsEndpoint(ttsEp)
    setSttEndpoint(sttEp)
    // Service "up" only means the process is reachable — the model still has to
    // load into VRAM before it can synthesize. Wait on that too, so the loading
    // indicator doesn't clear while the first utterance would still stall.
    await loadTtsModel(ttsEp, sel.model)
    setVoiceStatus('ready')
    updateService(provider.serviceId, { lifecycle: { idleUnload: false } }).catch(() => { })
    if (cfg.stt?.serviceId) updateService(cfg.stt.serviceId, { lifecycle: { idleUnload: false } }).catch(() => { })
  }, [])

  const stopVoiceServices = useCallback((cfg: VoiceConfig | null, sel: VoiceSelection | null) => {
    setVoiceStatus('off')
    setTtsEndpoint(null)
    setSttEndpoint(null)
    if (sel && cfg) {
      const prov = cfg.tts.providers.find(p => p.serviceId === sel.serviceId)
      if (prov) updateService(prov.serviceId, { lifecycle: { idleUnload: true } }).catch(() => { })
      if (cfg.stt?.serviceId) updateService(cfg.stt.serviceId, { lifecycle: { idleUnload: true } }).catch(() => { })
    }
  }, [])

  useEffect(() => {
    fetchVoiceConfig().then(cfg => {
      if (!cfg) return
      setVoiceConfig(cfg)
      setSaveMicSamples(cfg.debug?.saveMicSamples ?? false)
      const sel = loadVoiceSelection(cfg)
      setVoiceSelection(sel)
      const enabled = loadSpeechEnabled(cfg)
      setSpeechEnabled(enabled)
      if (enabled && sel) {
        startVoiceServices(cfg, sel).catch(() => {
          setSpeechEnabled(false)
          saveSpeechEnabled(false)
          setVoiceStatus('off')
        })
      }
    })
  }, [startVoiceServices])

  const handleSpeechToggle = useCallback((enabled: boolean) => {
    if (!enabled) {
      setSpeechEnabled(false)
      saveSpeechEnabled(false)
      setUnattended(false)
      stopVoiceServices(voiceConfig, voiceSelection)
      setMicStream(prev => { prev?.getTracks().forEach(t => t.stop()); return null })
      return
    }
    if (!voiceConfig || !voiceSelection) {
      toast.error('Voice not configured')
      return
    }
    // iOS Safari requires getUserMedia to be invoked synchronously inside the
    // tap handler — any preceding await drops the user-activation context and
    // the permission prompt silently fails. Start the gUM call here, then chain
    // the rest of the startup off the resulting promise.
    const streamPromise = navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS })
    setSpeechEnabled(true)
    saveSpeechEnabled(true)
    streamPromise
      .then(stream => {
        setMicStream(stream)
        return startVoiceServices(voiceConfig, voiceSelection)
      })
      .catch(err => {
        toast.error(`Voice failed to start: ${err instanceof Error ? err.message : String(err)}`)
        setSpeechEnabled(false)
        saveSpeechEnabled(false)
        setVoiceStatus('error')
        setMicStream(prev => { prev?.getTracks().forEach(t => t.stop()); return null })
      })
  }, [voiceConfig, voiceSelection, startVoiceServices, stopVoiceServices])

  const {
    connectionState,
    activeSession,
    agents,
    models,
    currentAgent,
    currentModel,
    contextTokens,
    contextWindow,
    errorMessage,
    compactionPhase,
    items,
    runActive,
    error,
    switchTo,
    sessions,
    currentSessionName,
    selectSession,
    newSession,
    send,
    stop,
    resend,
    patchModel,
    reconnect,
  } = useSessionManager()

  // Shared by all three model selectors — ControlBar, the mobile voice
  // controls, and the composer's mobile ModelPill.
  const handleModelChange = useCallback((id: string) => {
    patchModel(id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(msg)
    })
  }, [patchModel])

  useEffect(() => {
    if (errorMessage) toast.error(errorMessage)
  }, [errorMessage])

  useEffect(() => {
    if (error) toast.error(error)
  }, [error])

  // Chat-launches from another page (e.g. "Talk about this" on home).
  // Sequence on mount:
  //   - switch to agent:main:main, start a fresh session there
  //   - flip voice on (TTS services start in the background — by the time
  //     the agent's reply chunks arrive, voice is ready to play them)
  //   - send the rendered opening message
  // Voice config has to be loaded for handleSpeechToggle to do anything,
  // so we wait on that signal before running.
  const launchRunRef = useRef(false)
  useEffect(() => {
    if (launchRunRef.current) return
    if (connectionState !== 'connected') return
    if (!activeSession) return
    if (!voiceConfig || !voiceSelection) return
    const intent = consumePendingChatLaunch()
    launchRunRef.current = true
    if (!intent) return
    void (async () => {
      try {
        await switchTo('main', 'main')
        await newSession()
        if (!speechEnabled) handleSpeechToggle(true)
        await send(intent.openingMessage)
      } catch (err) {
        console.error('[chat-launch] failed', err)
        toast.error('Failed to start the chat — try again.')
      }
    })()
  }, [connectionState, activeSession, voiceConfig, voiceSelection, speechEnabled, switchTo, newSession, send, handleSpeechToggle])

  // On initial messages-load, jump to the bottom unconditionally — without
  // this, gated auto-scroll sees scrollTop=0 and refuses to follow.
  const didInitialScrollRef = useRef(false)
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return
    if (items.length === 0) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    didInitialScrollRef.current = true
  }, [items])

  // Track whether the user is at the bottom of the message scroll container
  // (within ~100px). Used to gate auto-scroll-on-new-content and toggle the
  // floating "scroll to bottom" button.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setIsAtBottom(distanceFromBottom < 100)
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Auto-scroll to bottom on new content — but only if the user is already
  // near the bottom. If they've scrolled away, leave their position alone.
  // Keyed on items/runActive (what's actually rendered now) — runActive
  // catches the processing placeholder's own appear/disappear, which
  // doesn't otherwise touch items.
  useEffect(() => {
    if (!isAtBottom) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [items, runActive, isAtBottom])

  function scrollToBottom() {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const modelOptions = models.map((m) => ({ id: m.id, label: m.alias || m.name || m.id }))
  const contextUsage = contextTokens != null && contextWindow != null
    ? `${formatTokens(contextTokens)} / ${formatTokens(contextWindow)}`
    : contextTokens != null
      ? `${formatTokens(contextTokens)} ctx`
      : null

  function handleSend(text: string) {
    send(text).catch((err: Error) => {
      toast.error(`Send failed: ${err.message}`)
    })
  }

  const inputDisabled = connectionState !== 'connected'

  // Active model's chunking resolved under the app-wide scope: global only,
  // or override -> model defaults -> global. See resolveChunkingFor /
  // model-settings.ts for the precedence rules.
  const chunking = resolveChunkingFor(voiceConfig, voiceSelection)

  const voiceLoopEnabled = speechEnabled && voiceStatus === 'ready'
  const { loopState, playbackState, isVoiceReady, micReady, micMuted, speechMuted, muteLinked, relinkMutes, toggleSpeechMuted, toggleMuteAll, setMicAutoMuted } = useVoiceLoop({
    enabled: voiceLoopEnabled,
    sttEndpoint,
    voiceConfig,
    session: activeSession,
    ttsEndpoint,
    ttsSelection: voiceSelection,
    chunkStrategy: chunking.strategy,
    minChunkWords: chunking.minWords,
    maxChunkWords: chunking.maxWords,
    ttsConcurrency: chunking.concurrency,
    micStream,
    onSttEndpointChange: setSttEndpoint,
    onError: (msg) => toast.error(msg),
  })

  // Global keyboard shortcuts — only active when the input is not focused.
  // Space toggles mute-all; / focuses the input. Declared after useVoiceLoop so
  // the handler closes over the current voiceLoopEnabled/toggleMuteAll.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      if (!target) return
      // Bail if focus is in any editable element
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === ' ') {
        e.preventDefault()
        if (voiceLoopEnabled) toggleMuteAll()
      } else if (e.key === '/') {
        e.preventDefault()
        const ta = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Type a message…"]')
        ta?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [voiceLoopEnabled, toggleMuteAll])

  const glowState: 'hearing' | 'playing' | 'off' =
    (!micMuted && loopState === 'hearing') ? 'hearing'
      : playbackState === 'playing' ? 'playing'
        : 'off'

  // The displayed status must reflect the *whole* startup, not just service
  // readiness. `voiceStatus` covers service start + TTS model load; the
  // browser-side VAD/SmartTurn models (isVoiceReady) and the mic loop (micReady)
  // load in parallel and aren't done when `voiceStatus` flips to 'ready'. Keep
  // the indicator in 'loading' until every piece is live.
  const voiceLoading =
    voiceStatus === 'loading' ||
    (speechEnabled && voiceStatus === 'ready' && (!isVoiceReady || !micReady))
  const displayStatus: VoiceStatus =
    voiceStatus === 'error' ? 'error'
      : voiceLoading ? 'loading'
        : voiceStatus

  return (
    <div className="flex flex-col flex-1 min-h-0 relative overflow-hidden">
      <div className="chat-ambient-wash" aria-hidden="true" />
      <div className="chat-glow-overlay" data-glow-state={glowState} aria-hidden="true" />
      <div className="shrink-0 max-w-4xl mx-auto w-full px-4 md:px-8 relative z-[2]">
        <ControlBar
          agents={agents.length ? agents.map((a) => a.id) : [currentAgent || 'main']}
          currentAgent={currentAgent || 'main'}
          onAgentChange={(id) => switchTo(id)}
          models={modelOptions}
          currentModel={currentModel}
          onModelChange={handleModelChange}
          contextUsage={contextUsage}
          contextWarning={contextTokens != null && contextWindow != null && contextTokens / contextWindow > 0.8}
          onNewSession={newSession}
          sessions={sessions}
          currentSessionName={currentSessionName}
          onSelectSession={(name) => {
            selectSession(name).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              toast.error(msg)
            })
          }}
          voiceControls={voiceConfig && (
            <>
              <span className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground">
                {displayStatus === 'loading' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {displayStatus === 'ready' && playbackState === 'playing' && <AudioLines className="h-3.5 w-3.5 text-primary" />}
                {displayStatus === 'ready' && playbackState !== 'playing' && <AudioLines className="h-3.5 w-3.5 text-green-500" />}
                {displayStatus === 'error' && <AudioLines className="h-3.5 w-3.5 text-destructive" />}
              </span>
              {voiceSelection && (
                <VoiceSettings
                  voiceConfig={voiceConfig}
                  selection={voiceSelection}
                  endpoint={ttsEndpoint}
                  onSelectionChange={setVoiceSelection}
                  onSave={(sel, newSttServiceId, updatedVoice) => {
                    // Without this merge, Save writes to disk but nothing in
                    // the running page changes until a reload — the PATCH
                    // response is the only place the merged chunking
                    // state (modelPrefs, global options) comes back. providers
                    // and stt.options are kept from the local copy: the PATCH
                    // response is raw config.voice, which lacks the
                    // enrichment GET /api/voice adds (service names, STT
                    // option list).
                    setVoiceConfig(prev => prev ? {
                      ...prev,
                      ...(updatedVoice.enabled !== undefined && { enabled: updatedVoice.enabled }),
                      tts: {
                        ...prev.tts,
                        ...(updatedVoice.tts?.selection && { selection: updatedVoice.tts.selection }),
                        options: updatedVoice.tts?.options ?? prev.tts.options,
                        modelPrefs: updatedVoice.tts?.modelPrefs ?? prev.tts.modelPrefs,
                        settingsScope: updatedVoice.tts?.settingsScope ?? prev.tts.settingsScope,
                      },
                      stt: { ...prev.stt, ...(updatedVoice.stt?.serviceId && { serviceId: updatedVoice.stt.serviceId }) },
                      debug: updatedVoice.debug ?? prev.debug,
                    } : prev)

                    const provider = voiceConfig?.tts.providers.find(p => p.serviceId === sel.serviceId)
                    if (!provider) return
                    if (voiceSelection && voiceSelection.serviceId !== sel.serviceId) {
                      updateService(voiceSelection.serviceId, { lifecycle: { idleUnload: true } }).catch(() => { })
                    }
                    setVoiceStatus('loading')
                    ensureTtsReady(provider.serviceId)
                      .then(ep => {
                        setTtsEndpoint(ep)
                        return loadTtsModel(ep, sel.model)
                      })
                      .then(() => { setVoiceStatus('ready') })
                      .catch(() => { setVoiceStatus('error') })

                    if (newSttServiceId && voiceConfig && newSttServiceId !== voiceConfig.stt?.serviceId) {
                      const oldSttId = voiceConfig.stt?.serviceId
                      if (oldSttId) {
                        updateService(oldSttId, { lifecycle: { idleUnload: true } }).catch(() => { })
                      }
                      ensureServiceReady(newSttServiceId)
                        .then(ep => {
                          setSttEndpoint(ep)
                          updateService(newSttServiceId, { lifecycle: { idleUnload: false } }).catch(() => { })
                        })
                        .catch(() => { })
                    }
                  }}
                />
              )}
            </>
          )}
        />
        <DisconnectBanner connectionState={connectionState} onRetry={reconnect} />
        <CompactionIndicator phase={compactionPhase} />
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 relative z-[2]">
        <div className={`max-w-4xl mx-auto w-full px-4 md:px-8 ${voiceLoopEnabled ? 'pb-[11.5rem] md:pb-0' : ''}`}>
          <MessageList
            items={items}
            runActive={runActive}
            onResend={(itemId) => {
              resend(itemId).catch((err: Error) => {
                toast.error(`Resend failed: ${err.message}`)
              })
            }}
          />
        </div>
      </div>
      {voiceLoopEnabled && (
        <div className="md:hidden absolute bottom-0 left-0 right-0 z-[2]">
          {!isAtBottom && (
            <Button
              variant="default"
              size="icon"
              className="dashboard-chrome absolute -top-12 left-1/2 -translate-x-1/2 size-9 rounded-full shadow-[0_3px_14px_3px_color-mix(in_oklch,var(--foreground)_24%,transparent)] z-10"
              onClick={scrollToBottom}
              aria-label="Scroll to bottom"
              title="Scroll to bottom"
            >
              <ArrowDown className="size-4" />
            </Button>
          )}
          <VoiceControlsMobile
            onSend={handleSend}
            onStop={stop}
            isStreaming={runActive}
            onVoiceToggle={handleSpeechToggle}
            speechMuted={speechMuted}
            toggleSpeechMuted={toggleSpeechMuted}
            micMuted={micMuted}
            toggleMuteAll={toggleMuteAll}
            muteLinked={muteLinked}
            relinkMutes={relinkMutes}
            setMicAutoMuted={setMicAutoMuted}
            models={modelOptions}
            currentModel={currentModel}
            onModelChange={handleModelChange}
            onPreventScreenLock={
              voiceStatus === 'ready' && speechEnabled
                ? () => setUnattended(true)
                : undefined
            }
          />
        </div>
      )}
      <div
        className="shrink-0 max-w-4xl mx-auto w-full px-4 md:px-8 pt-3 md:pt-0 relative z-[2]"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        onWheel={(e) => {
          scrollRef.current?.scrollBy({ top: e.deltaY })
        }}
      >
        {!isAtBottom && (
          <Button
            variant="default"
            size="icon"
            className={`dashboard-chrome absolute -top-12 left-1/2 -translate-x-1/2 size-9 rounded-full shadow-[0_3px_14px_3px_color-mix(in_oklch,var(--foreground)_24%,transparent)] z-10 ${voiceLoopEnabled ? 'md:flex hidden' : ''}`}
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
          >
            <ArrowDown className="size-4" />
          </Button>
        )}
        <div className={voiceLoopEnabled ? 'md:block hidden' : ''}>
          <ChatComposer
            onSend={handleSend}
            onStop={stop}
            isStreaming={runActive}
            disabled={inputDisabled}
            voiceOn={voiceLoopEnabled}
            onVoiceToggle={handleSpeechToggle}
            speechMuted={speechMuted}
            toggleSpeechMuted={toggleSpeechMuted}
            micMuted={micMuted}
            toggleMuteAll={toggleMuteAll}
            muteLinked={muteLinked}
            relinkMutes={relinkMutes}
            setMicAutoMuted={setMicAutoMuted}
            modelPicker={
              <div className="md:hidden">
                <ModelPill
                  models={modelOptions}
                  currentModel={currentModel}
                  onModelChange={handleModelChange}
                />
              </div>
            }
          />
        </div>
      </div>
      {unattended && (
        <button
          type="button"
          onClick={() => setUnattended(false)}
          className="fixed inset-0 z-50 bg-background flex flex-col items-center justify-center gap-3 text-center px-8 text-foreground cursor-pointer"
          aria-label="Exit screen lock prevention"
        >
          <EyeClosed className="h-16 w-16 opacity-40" />
          <span className="text-lg font-medium">Screen lock prevented — tap anywhere to exit</span>
          <span className="max-w-xs text-lg font-normal text-muted-foreground">
            Voice chat stays connected while your screen is kept from sleeping.
          </span>
        </button>
      )}
    </div>
  )
}
