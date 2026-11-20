# Voice turn-taking

One record per actor in the voice loop. Every actor reports into the turn manager (`voice-engine/src/turn-manager.ts`) and reconciles itself to its snapshot; why it is shaped this way is in [`docs/reference/design/voice-floor.md`](../design/voice-floor.md).

## Human turn — `voice-engine/src/turn-manager.ts`, `voice-engine/src/store/turn-manager-store.ts`

**Owns:** the human turn's phase, outcome, `held`/`sendPending`, and delivering it once sent. **Reports:** nothing. **Reads:** `human`, `annotation`.

| State | Means |
|---|---|
| null | no human turn open |
| speaking | an utterance is live, or turn is held/muted with none transcribed yet |
| closing | nothing live, something transcribed, not held, mic not muted |
| ended | rejected, abandoned, or delivered |

| From | To | On | Guard |
|---|---|---|---|
| null/ended | speaking | human report, phase hearing | new utterance id (`isCandidate`) |
| speaking | speaking | human report | another utterance joins (`upsertHumanUtterance`) |
| speaking | closing | human report, controls unmute, composer | `!anyLive && anyTranscribed && !held && !micMuted` |
| speaking/closing | closing | composer report | `sendPending && !anyLive` (overrides held, micMuted) |
| closing | speaking | human report, phase hearing | `isCandidate` reopens; `agentAtClosing` cleared |
| speaking | ended (abandoned) | human report | `anyAbandoned` on any utterance |
| speaking | ended (rejected) | human report, controls unmute | `!anyLive && !anyTranscribed && !held && !micMuted && !sendPending` |
| closing | ended | agent report, first `audible` | `openedAudible`, any agent turn |
| closing | ended | conversation/player report, agent ends | `endsClosingHuman`: ended agent's `id !== agentAtClosing` |

| When the snapshot says | It does |
|---|---|
| `human.outcome === 'sent'`, not already delivered for this id | `takeTranscript()`; `session.controls.send(text, { annotation })` |

**Invariants:**
- `sendPending` overrides `held` and `micMuted`; neither gates abandoned/rejected.
- a send pressed while an utterance is `transcribing` closes the turn when that commit returns, not at the press.
- `agentAtClosing` records the agent turn's id (or null) only on speaking→closing; cleared on reopen.
- delivery fires once per turn id, on the `sent` transition only, never on a re-read of a closing turn.
- a transcript on an already-`ended` utterance updates only `transcript`, never `phase`/`outcome`.

**Why:**
- delivery is edge-triggered against `prev.human`, because the composer writes `settled` live while a sent turn still sits `closing`, and a level read would resend it.

## Agent turn and floor — `voice-engine/src/turn-manager.ts`, `voice-engine/src/store/turn-manager-store.ts`

**Owns:** the agent turn's phase/outcome, the floor, and aborting a run the human interrupted. **Reports:** nothing. **Reads:** `agent`, `activity`.

| State | Means |
|---|---|
| null | no agent turn open |
| opening | run started, no audio yet |
| speaking | player has reported an utterance live |
| closing | run ended but utterance/player/pending still live |
| ended | completed, superseded, preempted, unvoiced or cancelled |
| floor: human | human turn speaking |
| floor: agent | agent turn opening/speaking/closing |
| floor: nobody | no turn open, or mode starting/ending/off |

| From | To | On | Guard |
|---|---|---|---|
| null | opening | conversation report | `runActive && runId` unseen (`isNewRun`) |
| opening | speaking | conversation/player report | `agentUtteranceFor`/`currentUtterance` live at open |
| opening/speaking | ended (preempted) | human report, phase hearing | agent `phase === 'opening'` (`interruptAgent`) |
| speaking/closing | ended (superseded) | human report, phase hearing | agent `phase !== 'opening'` (`interruptAgent`) |
| opening | ended (preempted) | conversation report opens new run | `human.phase === 'speaking'` at open |
| any open | ended (cancelled) | conversation report | new `runId` while old agent turn open |
| speaking | closing | conversation/player report | `!runActive` and (utterance live, or `supply.run===id`, or `pending>0`) |
| opening/closing | ended (completed) | conversation/player report | `!runActive`, nothing live, `agentVoiced` true |
| opening/closing | ended (unvoiced) | conversation/player report | `!runActive`, `!agentVoiced` |

| When the snapshot says | It does |
|---|---|
| `agent.outcome` in `superseded`/`preempted`, `activity !== 'idle'`, id not yet aborted | `session.controls.abort()`; id added to `aborted` |

**Invariants:**
- `agentVoiced` is fixed at open (`!speechMuted` then); unmuting mid-turn never changes it.
- `newAudio` is `discard` whenever the turn is unvoiced/superseded/preempted, whoever holds the floor.
- `mayBeAudible` requires floor agent, `pauseReason` null, `agentVoiced`, not superseded/preempted.
- abort fires once per agent turn id, tracked in the module-level `aborted` set.
- a player report naming an already-ended agent turn updates only that turn's utterance list, never its `phase`/`outcome`.

**Why:**
- `agentAtClosing`/`endsClosingHuman` compare by id, not liveness, because the interrupted run's `runActive:false` arrives a round trip after the abort and would otherwise close the human turn early.
- `annotation` reads `relations.interruption.working`, never `runActive` directly, because the abort the interruption causes ends the run before the send that reads it.


## MicLoop — `voice-engine/src/human/mic-loop.ts`

**Owns:** whether raw mic audio is an utterance, and that utterance's audio buffer. **Reports:** nothing (calls `MicLoopCallbacks` only; `HumanVoice` turns those into `report({ actor: 'human', utterance })`). **Reads:** nothing (no snapshot access; mute is driven by direct `muteMic()`/`unmuteMic()` calls).

| State | Means |
|---|---|
| `idle` | nothing captured |
| `listening` | raw speech accumulating, not yet confident |
| `hearing` | confirmed utterance open (speech or commit timer running) |
| `paused` | confirmed utterance open, mic muted, capture held |

| From | To | On | Guard |
|---|---|---|---|
| `idle` | `listening` | `handleSpeechFrame` → `cb.onSpeechBegan()` | `currentUtteranceId === null` |
| `listening` | `hearing` | `handleSpeechFrame` → `cb.onSpeechConfirmed(id)` | `confident()` |
| `listening` | `idle` | `handleSilenceFrame` → `cb.onUnconfirmed(durationS, peakProb)` | `silenceSamples >= pauseSamples` |
| `hearing` | `idle` | `fireHandoff` → `cb.onUtteranceEnded(id, audio)` | commit timer, safety flush, or `commitUtterance()` |
| `paused` | `idle` | `fireHandoff` → `cb.onUtteranceEnded(id, audio)` | `commitPaused(id)`, id matches |
| `hearing` | `paused` | `muteMic()` | `currentUtteranceId !== null` and `state === 'hearing'` |
| `listening` | `idle` | `muteMic()` → `cb.onUnconfirmed(durationS, peakProb)` | `state === 'listening'` |
| `paused` | `hearing` | `unmuteMic()` | `state === 'paused'` |
| any | `idle` | `stop()` | — |

**Invariants:** `onSpeechConfirmed` always mints a fresh id — never fires for a resume. Every span `onSpeechBegan` opens closes through exactly one of `onSpeechConfirmed` or `onUnconfirmed`. `onUtteranceEnded` releases `currentUtteranceId` synchronously, before the call returns. VAD verdicts drive state and the silence counter; capture is driven by the frame source, independent of verdict. `onFrame` fires unconditionally per chunk, even while muted or before an utterance opens.

**Why:** No state for "handed off, waiting to see if it resumes" — a hand-off is terminal, so speech after one is always a new utterance through the confidence gate. Pause snapshots audio into `pausedAudio` and clears the buffer, because the mic keeps writing while muted and must not grow unbounded or leak muted-room audio into the transcript.

## HumanVoice — `voice-engine/src/human/human-voice.ts`

**Owns:** the mic loop and STT transport; transcribes utterances and writes the transcript. **Reports:** `{ actor: 'human', utterance: Utterance<'human'> }`. **Reads:** `controls.micMuted`, `composer.focused`.

| State | Means |
|---|---|
| `unconfirmed` | loop's speech is between `onSpeechBegan` and confirm/reject |
| `held` | terminal reports queued while `unconfirmed` |
| `transcribing` | ids with a commit outstanding |
| `cutByReconnect` | confirmed utterances live when transport was swapped |
| `speechCutByReconnect` | unconfirmed speech live when transport was swapped |
| `forceSettled` | ids `stop()` settled early; later resolution must not write again |

| From | To | On | Guard |
|---|---|---|---|
| — | `hearing` report, entry created | `onSpeechConfirmed` | — |
| `hearing` | `transcribing` report | `onUtteranceEnded` | — |
| `transcribing` | `ended` report, outcome `transcribed`/`rejected` | commit resolves | not `unconfirmed`, else queued to `held` |
| held reports | released as `ended` | `onSpeechConfirmed` or `onUnconfirmed` | `hearing` reported first if confirmed |
| — | nothing (no turn) | `onUnconfirmed` | `transport.discard()` called |
| `hearing`/`paused` | `paused` report | `reconcileMute`, mic muted | `micState === 'hearing'` and utterance in progress |
| `paused` | `hearing` report | `reconcileMute`, mic unmuted | `micState === 'paused'` |
| `paused` | `commitPaused` | `reconcileFocusSettle` | `composer.focused` true |

| When the snapshot says | It does |
|---|---|
| `controls.micMuted: true` | `loop.muteMic()`, `transport.setSending(false, pauseFlushMs if pausing)` |
| `controls.micMuted: false` | `loop.unmuteMic()`, `transport.setSending(true)` |
| `composer.focused: true` (mic paused) | `commitPaused(id)` on the loop's current utterance |

**Invariants:**
- A transcript is written exactly once per commit, unconditionally, before the `ended` report.
- An id in `forceSettled` never touches the transcript store again.
- `unconfirmed`/`held`/`transcribing` are read live, never against a captured snapshot.
- A reconnect cuts the in-flight utterance to `abandoned`; `settle` joins `cutPrefix` with the new socket's words, so the composer gets both.
- Only `controls.micMuted` is reconciled here; `speechMuted` is the agent side's concern.

**Why:** the transcript write happens before the `running`/`ended` checks, because a commit `stop()` is racing must not be thrown away.

## Transcript store — `voice-engine/src/store/transcript-store.ts`

**Owns:** the message being composed — settled text plus each unsettled utterance's words, in spoken order. **Reports:** nothing. **Reads:** nothing.

| State | Means |
|---|---|
| settled | text already committed to the message, shown whole |
| pending[] | utterances not yet settled, in the order heard |
| pending[].final | null while live; set once transcription (or a forced settle) returns |
| reveal | pacing state for the entry currently being heard |
| sent | per utterance id, how many leading words a host already sent; absent means none |

| From | To | On | Guard |
|---|---|---|---|
| pending[id] absent | pending[id] created, text/paused set | setPartial(id, text, paused) | id not already in pending |
| pending[id] | pending[id] text/paused updated | setPartial(id, text, paused) | id already in pending |
| pending[id] | pending[id].final set, then drained | settle(id, text) | every leading entry (incl. id) has a final |
| pending[id] (visible text) | settle(id, entry.final ?? entry.text ?? '') | settleVisible(id) | — |
| pending[id] | entry removed, remainder drained | drop(id) | — |
| settled | settled replaced wholesale | editTranscript(text) | composer field focused |
| settled | settled emptied, old value returned | takeTranscript() | a send |
| sent[id] | set to { shown: n, cut } (zero clears) | markWordsSent(id, n) | a host composer sent the first n shown words of utterance id itself |

**Invariants:**
- `drain` moves only a contiguous leading run of finalized entries; one unfinalized entry blocks every entry behind it.
- Entries keep utterance order: `upsertPending` appends new ids at the end, never reorders.
- Only `settled` is emptied by `takeTranscript`; `pending` is untouched by a send.
- A `sent` mark holds `shown`, the number of leading words the host sent as the raw partial showed them, and `cut`, the word count of those words once cleaned of filler words the way a final is. `pendingText` removes `shown` leading words, counted by whitespace, from the utterance's text; `drain` removes `cut` from its final when it moves into `settled`. A number the final reformats can still leave the cut a word off. It is keyed by id, apart from `pending`, so an entry a late final creates anew keeps it. `markWordsSent` discards marks of ids no longer pending, except the one it sets. Nothing marks in the dashboard, so its view and sends are unchanged.
- `pendingDisplay` is each utterance's text as the composer shows it, before marks: its final, its raw text if paused or transcribing, or the paced reveal for the entry being heard.
- `pacedEntry` picks the newest entry with `final === null`; earlier unfinaled entries are mid-transcription and shown whole, not paced.
- The reveal restarts from `emptyReveal()` only when the paced id changes, not on every text change to the same entry.

**Why:** paced entry is the newest live one, because earlier live entries are already handed off to transcription and won't receive more partials to pace.

## VoiceSystem — `voice-engine/src/system/voice-system.ts`

**Owns:** one voice session: its phase, its session id, the services and heartbeat, the human and agent sides, the transcription connection and its reconnects, the player, and the last ending. One instance per page, built in `system/index.ts`. **Reports:** `{ actor: 'mode', mode }` on every phase change and every mic mute while live; nothing else reports the mode. **Reads:** the mute store and the session store, not the snapshot.

| Phase | Mode reported |
|---|---|
| `starting` | `starting` |
| `live` | `live`, or `muted` while the mic is muted |
| `ending` | `ending` |
| `off` | `off`, which resets the turn manager |

**Invariants:**
- A start's session is current while the session id matches and the phase is `starting` or `live`; every step after an await checks it, so a stop halts a start at its next await.
- Voice on reaches `devices.acquire()` before its first await; voice off releases the devices before the ended tone.
- The phase becomes `off` only after both the human side's stop and the ended tone have settled, and only if the session is still current.
- Only VoiceSystem initialises, resets and releases the player; the agent side and the tone queue receive play-only interfaces.
- A transport, a tone or a service reports; only VoiceSystem ends a session.

**Why:** the design record is [`docs/reference/design/voice-system.md`](../design/voice-system.md).

## PlaybackEngine — `voice-engine/src/system/playback-engine.ts`

**Owns:** what audio is mounted on the element for which run, and how it ended; the tone it is playing. **Reports:** `{actor:'agent', utterance, supply}` via `publish()`. **Reads:** `snapshot.agent.outcome`, `snapshot.previous.agent`, `snapshot.newAudio`, `snapshot.mayBeAudible`. While it holds a tone it leaves the element alone whatever `mayBeAudible` says.

| State | Means |
|---|---|
| `run` | Run id synthesis targets; set by `beginRun`, cleared by `endRun` |
| `mountedRun` | Run id whose audio is (or was) last mounted on the element |
| `mountedOutcome` | `'completed'`\|`'cut'`\|null — level held until next run mounts |
| `appendedToSource` | MSE/MMS: something appended to the current source buffer |
| `speechMounted` | Backend-agnostic "audio for a run is mounted" (getter) |
| `elementBusy` | Backend-agnostic "element is audibly running speech now" (getter) |
| `tone` | Tone in flight on the element's own timeline, never overlaps speech |
| `heldChunks` | Chunks enqueued while `newAudio==='park'`, awaiting release or drop |
| `cancelling` | True for the duration of one `cancel()` call, guards reentrancy |

| From | To | On | Guard |
|---|---|---|---|
| idle | run active | `beginRun(runId)` | — (calls `cancel()` first) |
| run active | idle (draining) | `endRun()` | — |
| mounted, no outcome | `mountedOutcome='completed'` | `settleCompletedIfDrained()` | run null, no pending/active/held, not appending, `remaining===0` |
| mounted, no outcome | `mountedOutcome='cut'` | `cancel()` | `wasMounted` (speechMounted before clearing) and `cutRun!==null` |
| held chunk | dispatched | `enqueueChat` finds `heldChunks.length>0`, or reconcile sees `newAudio==='play'` | — |
| held chunk | dropped, resolved | reconcile sees `newAudio==='discard'` | — |
| mounted/held audio | cancelled | `reconcile()` | `snapshot.agent.outcome` in `{superseded,preempted}`, or `previous.agent.outcome==='cancelled'` and `mountedRun` matches it |
| paused element | playing | `reconcile()` → `play()` | `mayBeAudible` and `audio.paused` and `speechMounted` |
| playing element | paused | `reconcile()` → `pauseElement()` | `!mayBeAudible` and `elementBusy` |
| tone paused | tone resumed | `reconcile()` | `tone` set and element paused and tone's slot current |

| When the snapshot says | It does |
|---|---|
| `agent.outcome` is `superseded` or `preempted` | cancels mounted/held audio (once, guarded) |
| `previous.agent.outcome==='cancelled'` and it mounted that run | cancels mounted/held audio |
| `newAudio==='play'` | releases held chunks |
| `newAudio==='discard'` | drops held chunks, resolves them |
| `tone===true` | leaves element alone unless a tone is paused on its own current slot |
| `mayBeAudible===true` | plays if paused and something mounted |
| `mayBeAudible===false` | pauses if `elementBusy` |

**Invariants:** Never plays a tone and speech at once — a run beginning always cancels any tone first. `mountedOutcome` only changes on a fresh run's first mounted chunk or on cancel/settle, never reverts once set. `reconcile()` is idempotent — a repeat call against an unchanged snapshot closes no further gap. `publish()` reads only synchronous engine state — no await between observation and report. Concurrency-limited speaks are granted in enqueue order, never released back to a general pool.

**Why:** Reconciliation reads `speechMounted`, not `appendedToSource`, so blob's mounted audio is cancelled too — a guard naming only the MSE field would leave blob's audio uncancelled while the report said it was there. `elementBusy` excludes a tone's own slot on both backends, or a tone in flight would read as agent speech.

## AgentVoice — `voice-engine/src/agent/agent-voice.ts`

**Owns:** the conversation relay to the floor, and the `ttsSelection`/`ttsEndpoint` a chunk reads at speak time. **Reports:** `{ actor: 'conversation', conversation: ConversationReport }`. **Reads:** nothing.

| State | Means |
|---|---|
| `unsubscribeConversation === null` | detached, or never attached |
| `unsubscribeConversation !== null` | attached, relaying conversation reports |

| From | To | On | Guard |
|---|---|---|---|
| detached | attached | `attach(session)` | — |
| attached | attached | `session.conversation.subscribe` notification | — |
| attached | detached | `detach()` | — |

**Invariants:**
- `attach()` reports once immediately, then again on every conversation notification.
- A chunk whose `enqueueChat` runs with `ttsSelection` or `ttsEndpoint` null is dropped, not queued.
- `chunkConfig` sets `chunker.config`; the run `SpeechChunker` is already chunking keeps the mode it was constructed with.
- The audio halter is registered once, at construction; `detach()` unregisters it and does not re-register on a later `attach()`.
- `detach()` order: chunker detaches, conversation unsubscribes, halter unregisters.

**Why:** halter unregistered at `detach()` so a later session's `stop()` never closes over a stale engine.


## SpeechChunker — `voice-engine/src/agent/speech-chunker.ts`

**Owns:** the mapping from the agent's streamed text to speakable chunks handed to the player. **Reports:** nothing (calls `cb.enqueueChat`/`beginRun`/`endRun` directly). **Reads:** nothing (`session.conversation` events/snapshot, not the turn manager's).

| State | Means |
|---|---|
| `activeRunId === null && lastFinishedRunId === null && !justDiscarded` | idle, no run seen since attach |
| `activeRunId === null && lastFinishedRunId === null && justDiscarded` | idle-discarded; next delta is fast-forwarded |
| `activeRunId !== null` | chunking a run |
| `activeRunId === null && lastFinishedRunId !== null` | finished; that run's own further chat is dropped |

| From | To | On | Guard |
|---|---|---|---|
| idle | chunking | `chat` event, `state==='delta'` | `activeRunId !== e.runId` |
| idle-discarded | chunking | `chat` event, `state==='delta'` | `activeRunId !== e.runId` |
| finished | chunking | `chat` event, `state==='delta'` | `activeRunId !== e.runId`, `e.runId !== lastFinishedRunId` |
| chunking | chunking (new run) | `chat` `delta`, different `runId` | `e.runId !== activeRunId`, `e.runId !== lastFinishedRunId` |
| chunking | finished | `chat` event, non-`delta` | `activeRunId !== null` |
| chunking/finished | idle-discarded | `session.conversation.subscribe` notification | `!snap.known` or (`snap.runId===null && !snap.runActive`) |
| any | idle | `detach()` | — |

**Invariants:**
- `endRun()` fires after `Promise.all(pendingSpeaks)` resolves, aborted speaks included — never on the terminal chat event itself.
- A `delta` for a new `runId` over an active run drops its `pendingSpeaks` and calls no `endRun()` for the old run.
- `chat` with `e.runId === lastFinishedRunId` is dropped in every state.
- `tool` `phase==='start'` calls `chunker?.recommendFlush()`; no state change.
- `detach()` clears `lastFinishedRunId` but not `justDiscarded`.

**Why:**
- `lastFinishedRunId` guards against a re-delivered chat event re-speaking a finished response from the start.
- `justDiscarded` fast-forwards past the first post-discard delta because spoken text can't be told from unspoken after a reset — dropping beats replaying.
- `lifecycle` events never finish a run because the gateway gives no ordering guarantee between the lifecycle and chat streams.

## Composer — `dashboard/src/features/chat/use-chat-textarea.ts`, `dashboard/src/features/chat/voice-controls-mobile.tsx`

**Owns:** whether the field has focus, and the count of turn-manager-routed sends (`composerSends` in `turn-manager-store.ts`). **Reports:** `{ actor: 'composer', sends, focused }`. **Reads:** `snapshot.human.phase`, imperatively at submit only.

| State | Means |
|---|---|
| `focused` (desktop `useState`) | field has DOM focus |
| `fieldOpen` (mobile `useState`) | inline field is mounted and shown |

| From | To | On | Guard |
|---|---|---|---|
| unfocused | focused | `handleFocus` → `reportComposerFocus(true)` | — |
| focused | unfocused | `handleBlur` (incl. Escape) → `reportComposerFocus(false)` | — |
| closed (mobile) | open | `openField` → `reportComposerFocus(true)` | — |
| open (mobile) | closed | `dismissField` → `reportComposerFocus(false)` | — |
| open (mobile) | closed | `submitField` → `reportComposerFocus(false)` | before send path below |
| any | any | `handleChange`/`onChange` → `editTranscript(value)` | not a turn-manager report |

| When the snapshot says | It does |
|---|---|
| `human.phase === 'speaking'` | `reportComposerSend()`, no direct send |
| `human` is `null` or not `speaking` | `takeTranscript().trim()` → `onSend(text)` directly |

**Invariants:** `reportComposerSend()` fires only on the speaking-turn path; the direct-send path never increments `composerSends`. Blur/dismiss reports `focused:false` but releases no hold itself — only a fresh candidate or `sendPending` closing the turn does. Desktop submit does not blur the field; mobile `submitField` calls `reportComposerFocus(false)` before `reportComposerSend()`. Mobile has no `onFocus`/`onBlur` on the textarea — `focused` tracks `fieldOpen`, not DOM focus.

**Why:** The button never calls `onSend` during a speaking turn because the turn may still hold a live utterance; delivery sends the whole turn once it settles. Submit leaves auto-mute in force while the field keeps focus, because nothing but `handleBlur` should unmute under a still-focused field.
