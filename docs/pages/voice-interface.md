# Voice Interface — UI Structure and Implementation State

*Implementation: `dashboard/src/lib/voice/`, `dashboard/src/features/chat/`*

The voice interface is the primary interaction mode for Banter. Voice can only be **started** on the Chat page (`/chat`) — as the default input mode on mobile, an optional mode on desktop — and the whole pipeline survives navigating to the other page. There is no voice control off Chat and no standalone voice page.

---

## Architecture Overview

Voice has three actors, the ones the voice floor names ([`../design/voice-floor.md`](../design/voice-floor.md)): the human side turns the microphone into text (`dashboard/src/lib/voice/human/`), the agent side turns the agent's text into speech requests (`dashboard/src/lib/voice/agent/`), and the system owns everything a voice session holds (`dashboard/src/lib/voice/system/`). The turn manager decides who has the floor; every actor reports to it and follows its snapshot.

**`VoiceSystem`** (`system/voice-system.ts`, one instance built in `system/index.ts`) owns a voice session: its phase (starting, live, ending, or off with no session), a session id every step after an await checks against, the TTS and STT services and the heartbeat that holds them, the human and agent sides, the transcription connection and its reconnects, and the player. Voice on and voice off are its only entry points, and nothing else reports the voice mode to the turn manager. The design is [`../design/voice-system.md`](../design/voice-system.md).

**The player** (`system/playback-engine.ts`) writes to the page's one audio element: the agent's speech and the system's tones both play through it. VoiceSystem creates it and alone initialises, resets and releases it; the agent side and the tone queue receive only the calls they play with. Voice-off resets it — source detached, fetches aborted, held queue dropped — and keeps the element, because iOS Safari permits a later programmatic play only on an element a user gesture already played.

Voice-off also *releases* the player: reset, plus the `load()` that makes the element stop being a playback target. Clearing the source alone leaves WebKit holding the element as live media, which puts a Now Playing control on the iOS lock screen for a session that has ended. The release runs after the ended tone, because the tone plays on this same element, and only if the session is still current — voice turned back on inside the tone's second would otherwise have its new source detached. The gesture grant survives `load()`. The *devices* are released separately and earlier — see the capture rule below.

**No capture session opens or closes while a sound is playing.** Opening a microphone makes iOS switch its audio session to a play-and-record route, and anything already sounding on the element crackles across that switch; closing it switches back. So `acquire()` (`dashboard/src/lib/system/devices.ts`) runs in the voice-on tap and does only what the gesture requires — the element's unlock play and `getUserMedia` — while the `AudioContext`, source node and capture node are built later, at the frame source's first `attach()`, once the opening tones have settled. At voice-off the devices are released synchronously, before the ended tone plays, rather than after it. Only the playback engine's own release waits for that tone, since it owns the element the tone plays on. The rule is device-confirmed and the reasoning is in [`../design/voice-tone-crackle.md`](../design/voice-tone-crackle.md).

**Capture runs in an `AudioWorklet`** (`dashboard/src/lib/system/mic-frames-worklet.js`), on the audio rendering thread, posting frames over its port batched to 4096 samples. Its node declares no outputs, so nothing captured reaches the output graph. This matters beyond the deprecation it replaced: the previous `ScriptProcessorNode` had to be connected to `ctx.destination` to run at all, which put the microphone inside the output graph and measurably degraded echo cancellation — the canceller needed several seconds of real speech to converge, and the agent would interrupt itself before then. With the worklet it converges cold.

Three tones mark voice mode (`dashboard/src/lib/voice/system/tones.ts`, mp3 assets under `public/tones/voice/`), played through the player so the page has one media element. They report nothing to the turn manager: a tone has no speaker, and the player leaves the element alone while it holds one. A tone is bytes appended to the speech timeline (`enqueueTone`); the engine records where it ends once its bytes are in and reports it heard when playback passes that point or starves after starting. Tones never overlap speech: the engine refuses a tone while a run is active, and a run beginning cuts one. The attempted tone plays once the microphone is acquired after the tap that turns voice on, so a cold start of several seconds is confirmed early; the tap's gesture unlock of the engine element is what lets iOS Safari play tones later without a gesture. The started tone plays when voice is fully ready; on a warm start, readiness within two seconds of the tap, it is skipped, because the attempted tone is still in the ear and pairs with the ended tone on its own. The ended tone plays on every transition to off. Tones abide by speech mute, skipped rather than deferred: speech mute is non-destructive by design, and a tone held back to the unmute would sound late into an open microphone. A mute that lands mid-tone moves the playhead past the tone's end, so a resume finds nothing. The microphone starts listening only after the attempted tone, and the started tone when one plays, have finished, so no tone is heard as speech; VoiceSystem waits on the tones it played, and a tone that never ends is given up on after three seconds.

**A session outlives the page that started it.** VoiceSystem is a module instance, not a component, so capture, VAD, smart-turn, the turn manager and playback keep running across a route change; only the component drawing the state changes. Voice stops only through voice off: the exit ✕ in the composer, a failed start, a transcription connection lost for good, or another client taking over.

**Session store** (`dashboard/src/lib/voice/voice-session-store.ts`) holds what outlives a session: config, the selection, the gateway session the Chat page publishes, and the service endpoints. VoiceSystem watches it and pushes changes into a live session.

**Config** (`voice-config.ts`) — `fetchVoiceConfig()` loads TTS/STT config from `GET /api/voice` into the session store; saving settings merges into it and calls VoiceSystem's `reconfigure`, which readies a new TTS model without restarting the session.

---

## Voice states

Voice is off, live or muted, and the Chat page's composer is the one surface that shows it:

| State | Composer |
|---|---|
| off | Text input, with the voice toggle |
| live | Voice controls, mic live |
| muted | Voice controls, muted |

Turning voice on is possible only from Chat. Exit ✕ turns it off. Navigating between pages never changes state.

## Chat Page Layout

```
┌─────────────────────────────────────────┐
│  Control bar (agent · model · session)  │
├─────────────────────────────────────────┤
│                                         │
│  Message area (scrollable)              │
│  - Assistant messages: full-width,      │
│    no bubble                            │
│  - User messages: right-aligned bubble  │
│  - Typing indicator                     │
│  - Disconnect banner (when offline)     │
│                                         │
├─────────────────────────────────────────┤
│  Input bar (pinned bottom)              │
│  Mobile: voice dock (default)           │
│  Desktop: text input + voice toggle     │
└─────────────────────────────────────────┘
```

### Voice dock (mobile)

`voice-controls-mobile.tsx` (`VoiceControlsMobile`) — the mobile voice input component. Three states:

**Idle (voice mode):** Pill row with three equal pills — Mic · Speech · Pause. A "Mute All" + "Type" row below.

**Listening (mic active):** Visual indication that mic is capturing. VAD and turn-taking running in the background.

**Speaking (agent talking):** Mic muted. Playback engine active. Visual indication (glow overlay on the chat page).

The `chat-glow-overlay` div on `.chat-page` shows a warm glow (`data-glow-state="hearing"`) while user is speaking, and a cool glow (`data-glow-state="playing"`) while the agent is speaking.

### Desktop input

`chat-composer.tsx` (`ChatComposer`) — text input with a voice toggle button, used on desktop. Same underlying voice loop, but surfaced differently. Text input is primary on desktop; voice is activated by button.

From the voice-on tap until the pipeline is live, that button becomes a spinning "Starting voice…" control carrying `aria-busy`, and pressing it cancels — `onVoiceToggle(false)` unwinds the startup at whatever stage it reached. The composer holds this state on mobile too: `ChatPage` keeps `voiceLoopEnabled` false until services, TTS model, browser models and mic loop are all live, so the swap to `VoiceControlsMobile` happens once rather than mid-startup, and the wait stays at the control the person pressed.

---

## Voice Pipeline Components

### VAD: Silero (`silero-vad.ts`)

Runs Silero VAD ONNX model on 512-sample frames (16kHz, ~32ms each). Returns speech probability per frame. Used to detect when user is speaking vs. silent.

Status: implemented and working.

#### What the settings mean

Under `voice.stt.vad` and `voice.stt.turnTaking` in the control plane's `config.json`, read by `mic-loop.ts`. They are the loop's, not the turn manager's: the turn manager is told what the loop concluded, never what a detector saw. Every row but `curve` and `interruptionMinRemainingS` is tuned from the Listening tab of the Settings dialog.

| Setting | Meaning |
|---|---|
| `vad.minSpeechDurationS` | How long a sound must last to count as speech. Below this it is noise, whatever its probability. |
| `vad.minSpeechProb` | How strong the VAD's per-frame probability must reach for the audio to count as speech. Below this it is noise, however long it lasts. |
| `turnTaking.pauseThresholdMs` | How much silence ends the speaking stretch and starts the commit decision. |
| `turnTaking.commitMinDelayMs` / `commitMaxDelayMs` | The window the commit timer moves within, between a confident turn-end and an uncertain one. |
| `turnTaking.smartTurnThreshold` | The turn-completion probability above which the utterance is treated as finished. |
| `turnTaking.smartTurnLowCutoff` | Below this, SmartTurn's opinion is treated as no signal rather than as a low score. |
| `turnTaking.curve` | How a SmartTurn probability between the cutoffs maps onto the commit delay. |
| `turnTaking.interruptionMinRemainingS` | How much agent audio must remain for a barge-in to count as interrupting speech. The turn manager's, not the loop's — it reaches it as `TurnManagerConfig`. |

The two `vad` settings together are the speech-versus-noise test, and the loop applies them before it tells the turn manager anything: an utterance is reported as `hearing` once both are satisfied. Audio failing either is never reported, so a cough opens no turn.

These values are tuned on a device and nowhere else. No spec pins them — a threshold written into a contract freezes a number that only means something in use.

### Turn detection: SmartTurn (`smart-turn.ts`)

Runs a custom ONNX model on an 8-second sliding audio window. Returns turn-completion probability — whether the user has finished their turn. Higher probability → transcript the current audio and send.

Requires `onnxruntime-web@1.18.0` with the `ort.all` bundle (`onnxruntime-web/experimental`). **Do not upgrade ort.** Versions ≥1.19 dropped single-threaded WASM and require COOP/COEP headers.

Status: implemented and working.

### STT client (`stt-client.ts`)

`transcribeAudio(wavBytes)` — POST to the STT service's endpoint. Returns transcript text.

The endpoint URL comes from voice config and the service registry. Whether the service starts at boot or on first use is that registry entry's `lifecycle`.

`human-voice.ts`'s `cleanTranscript` strips filler words (`uh`/`um`) from the committed transcript before it reaches the rest of the pipeline, once per committed utterance. Disfluency suppression is model-specific — some STT models drop fillers and hesitation repeats on their own and others transcribe them verbatim — so this keeps the dashboard's output consistent regardless of which model is loaded.

It does not strip `<unk>` tokens. `MicCapture` writes each audio chunk exactly once and VAD state resets between utterances, so the mic loop should never hand STT the kind of corrupted or state-leaked audio that produces `<unk>`; if `<unk>` ever appears in a transcript, that's a signal of an audio-pipeline bug to fix at the source, not text to mask.

Status: implemented and working when the registered STT service is running.

### TTS: Streaming backend (`streaming-backend.ts`, `playback-engine.ts`)

TTS requests stream audio chunks from the registered TTS service. The `PlaybackEngine` feeds these into either MSE streaming or a blob queue, depending on browser support.

Text → TTS path:
1. `text-chunker.ts` splits LLM output into speakable chunks at sentence boundaries
2. `text-cleaner.ts` strips markdown for clean TTS input
3. `streaming-backend.ts` POSTs each chunk to the TTS endpoint
4. `PlaybackEngine` queues and plays audio chunks in order

Status: implemented. Which STT and TTS services exist is whatever the registry lists; see [../models.md](../models.md) for adapters you can register.

### Streamed audio seams

A server that encodes each streamed chunk as a complete standalone container file puts one container header per chunk in the response and an audible gap at every chunk boundary. A server must hold one encoder open per response, so the stream is one continuous file. `probes/browser-audio/` is a browser test page for this class of problem: it reports what the browser's MediaSource actually accepts and what arrives off the wire, which the dashboard's own playback path does not show.

Two consequences for the browser side, relevant if the response format changes:

- `playback-engine.ts` picks the `addSourceBuffer` type from the response format (`audio/mpeg` for mp3, `audio/aac` for aac, `audio/wav` for wav). mp3 and ADTS-framed aac tolerate concatenated chunks because their frames are self-syncing; **webm/Opus does not** — each chunk carries an initialization segment, and appending one resets the MSE timeline so only the last chunk plays.
- iOS Safari has no plain `MediaSource`, only `ManagedMediaSource`. Verified on iOS 18.7 / Safari 26.6: it accepts `audio/mpeg`, `audio/webm; codecs="opus"` and `audio/mp4; codecs="mp4a.40.2"`, but **not** `audio/mp4; codecs="opus"`.

### Audio that arrives while the person is talking

The turn manager's snapshot tells the player what to do with each chunk through `newAudio`: `park` while the floor is the human's, `discard` while the agent's turn is unvoiced, superseded or preempted, and `play` otherwise. Parked chunks are held as unresolved promises whose fetches never start. Each actor's part is recorded in [`../components/voice-turn-taking.md`](../components/voice-turn-taking.md).

**Confirmed speech ends the agent's turn.** An utterance the loop is confident of supersedes an agent turn that was speaking or closing, or preempts one still opening, and the turn manager aborts its run at the same moment. Parked audio for that run is dropped and mounted audio cancelled; none of it is released into playback, because it belongs to a response the person has already talked over. The transcript plays no part, and noise never reaches the turn manager, because the loop reports only speech that passes its confidence gate.

The audible consequence, worth knowing because it reads as a regression and is not one: talking over a run that has not begun speaking, letting it finish, then finishing the sentence, gives silence followed by the new response rather than a fragment of the superseded one.

**The annotation is recorded at the interruption.** When speech is confirmed, the turn manager records what the agent's turn was doing — its phase, how much audio remained, whether its run was active — against the human turn. The message's annotation is read from that record at send time, since the abort has ended the run by then.

---

## Mute controls

Three controls: the **mic** (the big button), **speech**, and the **chain**, visible only while the two are unlinked. `store/mute-store.ts` owns all three and the transitions between them.

There is no mute-everything button. "Mute everything" is what muting the mic does *while linked*; linkage is simply whether speech follows the mic.

| From | Press | To | Effect |
|---|---|---|---|
| LINKED | mic | LINKED | speech follows: both := `!mic` |
| LINKED | speech | UNLINKED | speech := `!speech` |
| UNLINKED | mic | UNLINKED † | mic only, speech untouched |
| UNLINKED | speech | UNLINKED † | speech := `!speech` |
| UNLINKED | chain | LINKED | speech := mic — adopts the mic's state |

† → LINKED when the result leaves both live. That is the resting state the machine returns to.

Entering voice mode resets to both live and linked; nothing persists across a mode boundary. Auto-mute while typing mutes the mic without unlinking — transient, not an intent to diverge — and the UI labels it "Muted while typing".

Muting the mic keeps the MediaStream open and gates at the chunk level, so the browser's recording indicator stays lit while muted: mute is a software gate, not a hardware release.

## What muting does to playback

**Playback is paused if and only if speech is muted. The mic never touches playback, in either direction.** The player pauses whenever the turn manager's `mayBeAudible` is false, and the only pause reason it records is `speechMuted`; the player reports facts and reconciles to the snapshot, and nothing else commands it.

*While the agent is speaking*

- **Mute speech** — the voice stops at once. The agent carries on with its turn: muting is choosing not to listen, not telling it to stop.
- **Unmute** — the voice resumes exactly where it stopped. Nothing skipped.
- **Interrupt by speaking** — the agent stops, the turn is abandoned, its remaining audio is gone. This is the only action that loses audio, and it loses it because you asked for something else.

*While muted*

- The agent finishes its turn silently, and that audio waits.
- A turn that **begins** while muted is not voiced at all for its whole duration, even if unmuted midway — audio never starts mid-sentence.

*The mic*

- Muting and unmuting change nothing else. In particular, unmuting does not make the agent react as though you had just spoken.

The accepted consequence: after a long mute the voice runs behind the conversation. Reading ahead in the text and then interrupting is the intended way out, which is why interrupting is the one action that clears the backlog. Muting therefore has to stay non-destructive — otherwise reading ahead costs you the audio, and voice and text compete instead of complementing each other.

## Voice Settings

Voice settings are tabs in the app's one Settings dialog (nav bar gear → Settings), built by `useVoiceSettings` in `dashboard/src/features/settings/voice-settings.tsx`. Tabs:

- Voice: TTS provider + model + voice selector, speed slider, STT provider, streaming method
- Speech: chunk strategy (`two-chunk` (default), `paragraph`, `sentence`, `greedy`) and min/max chunk word counts
- Listening: the five `turnTaking` and two `vad` thresholds from [What the settings mean](#what-the-settings-mean), each with a line saying what the loop does with it. A field the config does not set shows a disabled slider, since the loop's own default applies there.
- Debug: saving mic samples to disk

Everything is staged until the dialog's single Save, which saves only the voice values that changed. When the dialog opens before the chat page has loaded voice config, it fetches the config itself.

All settings read from `GET /api/voice` and write back via `PATCH /api/voice/selection`, which takes the listening thresholds as `vad` and `turnTaking` objects merged field by field into `voice.stt`. Server-authoritative — localStorage is not used for voice selection state.

Status: implemented and working.

### Per-model settings

Some settings differ per TTS model — that is chunking (strategy, min words, max words), though the mechanism is not specific to it. One app-wide radio governs it, stored once: **use the same settings for every model**, or **use per-model settings**, where each model may keep its own and falls back to what it ships, then to yours. A radio rather than a toggle, so each option can carry the line explaining its inheritance.

| Top-level choice | Chain, per field |
|---|---|
| same for every model | global only |
| per-model | override → model defaults → global |

One chain, not one per mode-and-source combination, so global is the backstop everywhere and a partial set never leaves a field unfilled. Any set may be partial: an override holds only the fields you changed, and a model may declare only some.

Stored: the radio choice once, globally; per model, an override set if one exists. Nothing records which set is live. **Overrides are always stored** regardless of the radio, which governs only whether they are consulted — so switching to global and back restores what you had.

**Overridden is inferred, not chosen.** There is no "use my overrides" control: a model is overridden exactly when the radio is on per-model and an override exists, because having one *is* using it. A field is overridden when its value differs from what the chain gives without the override layer — derived by comparison, not tracked with dirty flags. Keeping the state out of the interface is what stops the interface claiming a state that isn't real.

Edits land where the radio says, with no second control to disagree with it. One action, **reset to model defaults**, deletes the override; there is no separate "switch back to defaults", because having no override is using them. Always show the value in force, and show the default it diverges from whenever they differ — a value's source should never be a mystery.

---

## Design reference

The actors and the turn manager they report to are recorded in [`../components/voice-turn-taking.md`](../components/voice-turn-taking.md), and why they are shaped that way in [`../design/voice-floor.md`](../design/voice-floor.md). This page describes the surface.

---

## What this document does NOT cover

- Gateway protocol (WebSocket session lifecycle, RPC details) — see [`../gateway/openclaw/gateway-session-lifecycle.md`](../gateway/openclaw/gateway-session-lifecycle.md)
- Voice settings API shape — see [`../api-reference.md`](../api-reference.md)
- Audio encoding details — see `wav-encoder.ts` inline
