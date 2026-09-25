import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react'
import { useStore } from 'zustand'
import { toast } from 'sonner'
import { ArrowDown } from 'lucide-react'
import { useSessionManager } from '@/lib/use-session-manager'
import { consumePendingChatLaunch } from '@/lib/chat-launch'
import { fetchVoiceConfig, loadVoiceSelection, setSaveMicSamples } from '@/lib/voice'
import { useTurnManagerStore, loopStateFromSnapshot, playbackStateFromSnapshot } from '@/lib/voice'
import { useMuteStore, toggleMuteAll, toggleSpeechMuted, relinkMutes, setMicAutoMuted } from '@/lib/voice/human/mute-store'
import {
  useVoiceSessionStore, publishSession, setVoiceConfig as publishVoiceConfig,
  setVoiceSelection as publishVoiceSelection,
} from '@/lib/voice/voice-session-store'
import { useVoiceSystemStore, voiceSystem } from '@/lib/voice/system'
import { voiceOn, voiceOff, armVoice, commitVoice, isArmed, cancelArm } from '@/lib/media-voice-mode'
import { useMediaEngine } from '@/lib/media-engine'
import { useWakeLock } from '@/lib/use-wake-lock'
import { useIsMobile } from '@/lib/use-is-mobile'
import { overrideTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { MessageList } from './message-list'
import { ComposerDock } from './composer-dock'
import { VoiceControlsMobile, SpokenReadout } from './voice-controls-mobile'
import { ModelPill } from './model-pill'
import { ControlBar } from './control-bar'
import { DisconnectBanner } from './disconnect-banner'
import { CompactionIndicator } from './compaction-indicator'

interface Props {
  filter?: string
  navigate: (path: string, filter?: string) => void
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// the design record: the voice pipeline itself —
// mic capture, VAD, smart-turn, the turn manager, the gateway session — is
// owned by the voice system (lib/voice/system), not by this page. ChatPage
// keeps only what it alone can do (the tap that turns voice on or off,
// through media-voice-mode.ts's gate) and what only it needs to render (the
// composer, the mobile voice-controls block): everything else is read from
// the system's own store and voice-session-store.ts.
export function ChatPage(_props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isMobile = useIsMobile()

  const voiceConfig = useStore(useVoiceSessionStore, (s) => s.voiceConfig)
  const voiceSelection = useStore(useVoiceSessionStore, (s) => s.voiceSelection)
  const phase = useStore(useVoiceSystemStore, (s) => s.phase)
  const reconfiguring = useStore(useVoiceSystemStore, (s) => s.reconfiguring)
  const lastEnd = useStore(useVoiceSystemStore, (s) => s.lastEnd)

  /**
   * The voice controls' real height, so the conversation can be padded clear
   * of it. A ref callback rather than an effect: the element is a different
   * node in the voice-on and voice-off states, and the callback fires on each
   * swap where an effect would need the state it is measuring as a dependency.
   */
  const [voiceControlsHeight, setVoiceControlsHeight] = useState(0)
  const voiceControlsObserver = useRef<ResizeObserver | null>(null)
  const voiceControlsRef = useCallback((el: HTMLDivElement | null) => {
    voiceControlsObserver.current?.disconnect()
    voiceControlsObserver.current = null
    if (!el) {
      setVoiceControlsHeight(0)
      return
    }
    // getBoundingClientRect, not contentRect: the block's padding carries the
    // safe-area inset, which contentRect excludes — measuring without it
    // leaves the last bubble under the buttons by exactly that much.
    const measure = () => setVoiceControlsHeight(el.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    voiceControlsObserver.current = observer
    measure()
  }, [])

  const [unattended, setUnattended] = useState(false)

  // Said once and gone. The lock icon carries the state from then on, so
  // nothing permanent sits over the conversation the screen is being held
  // awake to show.
  const toggleUnattended = useCallback(() => {
    setUnattended((on) => !on)
    toast(unattended ? 'Screen can sleep again' : 'Screen will stay awake')
  }, [unattended])

  useWakeLock(unattended)

  useEffect(() => {
    if (!unattended) return
    const restore = overrideTheme('dark')
    return restore
  }, [unattended])

  // Config fetch publishes into voice-session-store rather than local state
  // — the store outlives this page, so config has to as well (H9).
  useEffect(() => {
    fetchVoiceConfig().then(cfg => {
      if (!cfg) return
      publishVoiceConfig(cfg)
      setSaveMicSamples(cfg.debug?.saveMicSamples ?? false)
      const sel = loadVoiceSelection(cfg)
      publishVoiceSelection(sel)
    })
  }, [])

  // The composer's / mobile controls' voice button. H6's gate has to branch
  // synchronously in this same tap, before any await: getUserMedia only
  // prompts when called inside the gesture's own call stack (H11's own
  // reason voice starts nowhere but Chat), and the *arm* press must not call
  // it at all — an arm press changes no media x voice state (H6), so it must
  // not ask for microphone permission either.
  const handleSpeechToggle = useCallback((enabled: boolean) => {
    if (!enabled) {
      setUnattended(false)
      voiceOff()
      return
    }
    // Refuse before arming: an arm with no config behind it would leave the
    // gate showing a commit that can never succeed (H7).
    if (!voiceConfig || !voiceSelection) {
      toast.error('Voice not configured')
      return
    }
    const loaded = useMediaEngine.getState().track !== null
    if (loaded && !isArmed()) {
      armVoice()
      return
    }
    // The writer runs here, in the tap, before gUM — H3/H6: a commit
    // dismisses media the instant it commits, not once startup resolves.
    // The system does everything past this point — acquiring the devices,
    // starting the services, opening the connection — synchronously up to
    // its own first await, from inside this same gesture.
    if (isArmed()) commitVoice()
    else voiceOn()
  }, [voiceConfig, voiceSelection])

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

  // Publishes this page's activeSession into voice-session-store for the
  // system to read (H9) — never cleared on unmount, only on change. A mere
  // navigation away from Chat must not blank the session the pipeline is
  // running against, and neither must a navigation back: the session
  // manager starts every mount with no session yet, and publishing that
  // null would read to the system as the session being lost, tearing the
  // pipeline down and rebuilding it a moment later. Only a null that
  // follows a real session is a loss.
  const hadSession = useRef(false)
  useEffect(() => {
    if (activeSession) hadSession.current = true
    else if (!hadSession.current) return
    publishSession(activeSession)
  }, [activeSession])

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
  // Sequence on mount: switch to agent:main:main, start a fresh session
  // there, then send the rendered opening message. Voice starts only from
  // the composer's own control — a launch never turns the microphone on.
  const launchRunRef = useRef(false)
  useEffect(() => {
    if (launchRunRef.current) return
    if (connectionState !== 'connected') return
    if (!activeSession) return
    const intent = consumePendingChatLaunch()
    launchRunRef.current = true
    if (!intent) return
    void (async () => {
      try {
        await switchTo('main', 'main')
        await newSession()
        await send(intent.openingMessage)
      } catch (err) {
        console.error('[chat-launch] failed', err)
        toast.error('Failed to start the chat — try again.')
      }
    })()
  }, [connectionState, activeSession, switchTo, newSession, send])

  // On initial messages-load, jump to the bottom unconditionally — without
  // this, gated auto-scroll sees scrollTop=0 and refuses to follow.
  //
  // Then again once the web fonts have swapped in. Text laid out in the
  // fallback face is a different height from the same text in Literata and
  // Geist, so the first jump lands on a bottom the conversation then grows
  // past — which is why a reloaded page has always opened a little short of
  // the end, with a few lines still below the fold. Nothing in the browser
  // re-pins a scroller to its end when content above grows; the position has
  // to be taken again after the growth.
  const didInitialScrollRef = useRef(false)
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return
    if (items.length === 0) return
    const el = scrollRef.current
    if (!el) return

    const toEnd = () => { el.scrollTop = el.scrollHeight }
    toEnd()
    didInitialScrollRef.current = true

    let cancelled = false
    // Whoever scrolls first owns the position: past that point correcting it
    // would be taking the conversation away from where they put it.
    const release = () => { cancelled = true }
    el.addEventListener('wheel', release, { passive: true, once: true })
    el.addEventListener('touchstart', release, { passive: true, once: true })

    void document.fonts?.ready.then(() => {
      if (!cancelled) toEnd()
    })

    return () => {
      el.removeEventListener('wheel', release)
      el.removeEventListener('touchstart', release)
    }
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
  // voiceControlsHeight is in here because the block grows and shrinks under
  // the conversation — voice turning on, a readout appearing as speech
  // starts — and each change moves the floor the last message sits above.
  // Without it the message stays put and the block rises over it.
  useEffect(() => {
    if (!isAtBottom) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [items, runActive, isAtBottom, voiceControlsHeight])

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

  // The pipeline itself (mic loop, turn manager, playback) lives in the
  // system (lib/voice/system) — this page only reads its state back off the
  // stores the system drives, via useStore selectors, so nothing here is a
  // second live pipeline.
  const loopState = useStore(useTurnManagerStore, loopStateFromSnapshot)
  const playbackState = useStore(useTurnManagerStore, playbackStateFromSnapshot)
  const micMuted = useStore(useTurnManagerStore, (s) => s.snapshot.controls.micMuted)
  const speechMuted = useStore(useTurnManagerStore, (s) => s.snapshot.controls.speechMuted)
  // Not on the snapshot: muteLinked is the chrome's own coupling memory
  // (store/mute-store.ts's LINKED/UNLINKED table), never reported to the
  // turn manager. Reading the controls actor's own store for a fact it
  // never promotes to a report is what the untestable pins' chrome
  // exception permits.
  const muteLinked = useStore(useMuteStore, (s) => s.muteLinked)

  // The whole startup: the system's phase covers acquiring the devices,
  // starting the services, loading the models and opening the connection —
  // `starting` until the loop is live. A saved provider change re-readies a
  // service under an already-live session, which is `reconfiguring` rather
  // than a phase change, and it holds the same starting chrome up.
  const voiceStarting = phase === 'starting' || (phase === 'live' && reconfiguring)

  // Voice is fully live, which is what the voice-on chrome keys off: the
  // composer's live cluster, the mobile swap to VoiceControlsMobile, the
  // transcript padding and the spacebar mute shortcut. Holding all of them
  // until startup finishes keeps one surface — the composer, carrying its
  // waiting state — in front of the person for the whole wait on both
  // desktop and mobile.
  const voiceLoopEnabled = phase === 'live' && !reconfiguring
  /** The controls are standing over the conversation rather than sitting in the composer. */
  const clearingControls = voiceLoopEnabled && isMobile

  // Voice turning on puts a tall block over the conversation, on the surface
  // where it stands over it. Unlike the block merely changing height, this
  // scrolls whether or not the user was at the bottom: they have just asked
  // to start talking, and what was last said is the context for it.
  useEffect(() => {
    if (!clearingControls) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [clearingControls])

  // H7: Escape re-locks the gate regardless of focus — unlike the space/
  // slash shortcuts below, this must fire even while the composer's field
  // has focus (arming happens with the field either state, and Escape is
  // the standard "back out of this" key everywhere, editable fields
  // included). A stale armed state must never persist.
  useEffect(() => {
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') cancelArm()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [])

  // Global keyboard shortcuts — only active when the input is not focused.
  // Space toggles mute-all; / focuses the input.
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
        />
        <DisconnectBanner connectionState={connectionState} onRetry={reconnect} />
        <CompactionIndicator phase={compactionPhase} />
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 relative z-[2]">
        {/* Measured rather than guessed: the controls block grows with the
            readout inside it and with the phone's safe-area inset, and a
            constant leaves the last bubble underneath the buttons the moment
            a transcript makes the block taller. */}
        {/* Both adjustments belong to the block that overlays the
            conversation, and that block is mobile-only: desktop keeps its
            controls inside the composer, with nothing standing over the last
            message and so nothing to clear or to give up. */}
        <div
          className={`max-w-4xl mx-auto w-full px-4 md:px-8 ${clearingControls ? '[&>*]:!pb-0' : ''}`}
          style={clearingControls ? { paddingBottom: `${voiceControlsHeight}px` } : undefined}
        >
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
        <div ref={voiceControlsRef} className="md:hidden absolute bottom-0 left-0 right-0 z-[2]">
          {!isAtBottom && (
            <Button
              variant="default"
              size="icon"
              className="dashboard-chrome absolute -top-12 left-1/2 -translate-x-1/2 size-9 rounded-full shadow-float z-10"
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
              phase === 'live' ? toggleUnattended : undefined
            }
            unattended={unattended}
            readout={<SpokenReadout />}
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
            className={`dashboard-chrome absolute -top-12 left-1/2 -translate-x-1/2 size-9 rounded-full shadow-float z-10 ${voiceLoopEnabled ? 'md:flex hidden' : ''}`}
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
          >
            <ArrowDown className="size-4" />
          </Button>
        )}
        <div className={voiceLoopEnabled ? 'md:block hidden' : ''}>
          <ComposerDock
            onSend={handleSend}
            onStop={stop}
            isStreaming={runActive}
            disabled={inputDisabled}
            voiceOn={voiceLoopEnabled}
            voiceStarting={voiceStarting}
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
      <AlertDialog
        open={lastEnd?.reason === 'held'}
        onOpenChange={(open) => { if (!open) voiceSystem.clearLastEnd() }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Voice server in use</AlertDialogTitle>
            <AlertDialogDescription>
              Another session is using the voice server. Take it over? That session's voice will end.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => voiceSystem.clearLastEnd()}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                voiceSystem.clearLastEnd()
                voiceOn({ takeover: true })
              }}
            >
              Take over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
