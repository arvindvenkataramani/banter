# The tone crackle, and what it turned out to be

The voice tones crackled on the phone and not on the Mac, and production did not do it. The cause was **when the microphone's audio graph opens**, not how it is wired or what consumes it. Fixed; [`../pages/voice-interface.md`](../pages/voice-interface.md) states the resulting rule, and this record is why it holds.

## The fault

Opening a capture session makes iOS switch its audio session to a play-and-record route. Anything already sounding on the audio element crackles through the switch. Closing the session switches back, and does it again.

Phase 2 moved the microphone's `AudioContext` into `acquire()`, which runs in the voice-on tap. That put the route switch underneath both opening tones. At voice-off the release ran inside the ended tone's `.then()`, which put the closing switch underneath that tone. Three tones, three switches, each landing on a sound.

Production never did this: `MicCapture.start()` built the context after the tones had settled, and the host stopped the stream's tracks synchronously at voice-off, before the ended tone played. The ordering was right by accident, and the devices moving is what broke it.

## The evidence

Six configurations on the device, one variable at a time. Every clean row either has no capture session open during the tones, or no acoustic path for the switch to disturb.

**Read the clean rows with care.** The speech crackle on the same device was later found to be intermittent — some sessions never crackle, and a fresh page load rerolls it — and nobody knew that while these rows were being taken. Each is one or two runs judged by ear. A "crackle" row is solid; a "clean" row may have been a clean session. The fix below was confirmed the same way, and its reasoning is what carries it rather than the count of runs behind it.

| configuration | capture session open during tones | tones |
|---|---|---|
| as phase 2 shipped it | yes | crackle |
| processor off `ctx.destination` | yes | crackle |
| frame callback skipped (`copy-only`) | yes | crackle |
| `echoCancellation: false`, confirmed granted | yes | crackle |
| headphones | yes, but no speaker-to-mic path | clean |
| no audio graph built at all | no | clean |
| production | no — built after the tones | clean |
| **graph moved to first attach (the fix)** | **no** | **clean** |

What each row rules out:

- **Not the `ctx.destination` connection.** Terminating the processor in a `MediaStreamAudioDestinationNode` instead left the crackle untouched.
- **Not consumer load.** `copy-only` runs the per-frame copy and calls no consumer — no VAD, no STT — and still crackles. Every crackling tone also played with zero consumers attached: the opening tones play before `frameSource.attach`, the ended tone after `detach`.
- **Not echo cancellation.** Asked off and confirmed off by the track's own settings (`ec=false`), still crackles. AEC is a passenger on the route switch, not the driver.
- **Not the tones.** Speech crackles too, on this branch and on production alike.

The direct observation, from the timeline with `ctx.onstatechange` instrumented: the `AudioContext` reached `running` one millisecond before the attempted tone's bytes were appended and 80ms before it played. After the fix, `running` appears after `started settled` and the closing `closed` appears before the ended tone's `play`.

## The fix

**`voice-engine/src/devices.ts`** — `acquire()` keeps only what the iOS gesture requires: the element's play and `getUserMedia`. The `AudioContext`, source node and processor move into `openMicGraph()`, called from `frameSource.attach()`. Nothing captures, and no route changes, until something is listening.

**`voice-engine/src/system/voice-system.ts`** — voice off releases the devices synchronously, before the ended tone. The player's release still waits for the tone, since the tone plays on the player's element.

`acquire()`'s idempotence guard is now `stream` alone rather than `stream && micContext`, because the context legitimately does not exist between acquire and attach.

## Open

**Speech crackles whenever the microphone is open, and is a separate and unsolved problem.** It is **intermittent**: some sessions with the microphone open never crackle, a fresh page load rerolls the outcome, and a clean session can still develop crackle part-way through. Because of that, a list of ruled-out causes built from single runs is weaker than it reads: a "still crackles" result stands, a "clean" one may have been a clean session. Headphones remain the one repeatedly-confirmed finding. `probes/browser-audio/` shows that the playback path is irrelevant: a plain element, an element on `ManagedMediaSource`, and decoded samples through an `AudioContext` all crackle alike. An investigation needs one thing first: a way to judge crackle without a person listening.

**`micStream()` between acquire and attach** returns a stream with no audio graph behind it. Nothing reads it in that window, unverified exhaustively.

Voice off guards the rest of its teardown on the session id it belongs to, not on the mode, so voice turned back on inside the release window is not cut into by the old session's release.

## The instrument

There was no way to see inside the phone — no console on the device, and the fault did not reproduce on a Mac — so the fix came from an in-page timeline of audio-context, element and tone events.

The timeline is what settled it: `ctx state → running` landing one millisecond before a tone's bytes were appended. Not reasoning about the audio stack, which produced three wrong mechanisms before the timeline produced the right one.
