# config.json

Platform configuration for the control plane. Edit `config.json` directly — this file documents what each field does.

---

## `voice`

**`takeover`** — what a voice session does when a voice server it wants — TTS or STT — is held by another session. `ask` (default) ends voice with a dialog offering to take it over; `always` takes over without asking, on every connection the session makes.

## `voice.stt`

Speech-to-text pipeline configuration.

**`serviceId`** — registry ID of the STT service (Parakeet). Used to start the service and resolve its endpoint.

**`maxRecordingMs`** — max duration (ms) an utterance may run before it is force-flushed to transcription, whatever turn detection says. A safety net against a wedged detector, not a turn-taking setting. Default: 300000 (5 min).

**`settleOnStopMs`** — how long voice-off waits for an utterance still being heard or held paused to finish transcribing before closing the transport regardless. Default: 1500.

**`pauseFlushMs`** — how long a paused utterance keeps streaming silence in the microphone's place. A streaming model produces text for audio it holds only as further audio arrives behind it, so without this the last words said before a mute would not appear until unmute. Default: 1500.

### `voice.stt.reveal`

Pacing bounds for the streaming partial's word-by-word reveal — how fast the words the person is saying appear in the composer as they arrive.

**`minIntervalMs`** — fastest interval between revealed words. Default: 55.

**`maxIntervalMs`** — slowest interval between revealed words. Default: 200.

### `voice.stt.reconnect`

What a voice session does when its streaming socket drops: it reconnects rather than ending voice. Words the dropped socket had not finalized are lost. The first attempt goes at once.

**`attempts`** — failed connections in a row after which voice ends. `0` ends voice on the first drop. Default: 3.

**`delayMs`** — how much longer each attempt after the first waits than the one before it. Default: 1000.

**`stableMs`** — how long a socket must stay up before its drop starts a fresh count. One that drops sooner counts as a failure, so a fault that recurs just after the server accepts the session still ends voice. Default: 10000.

### `voice.stt.turnTaking`

All turn-taking parameters live here. Controls both when a pause is detected and how long the system waits before committing the turn to Parakeet. The wait is adaptive — shorter when the smart-turn model is confident the speaker is done, longer when it's not.

**`pauseThresholdMs`** — how long (ms) of silence triggers a pause. This is the first stage of the two-stage commit gate. The mic never stops — pause is a purely logical state. Default: 500.

**`commitMinDelayMs`** — minimum wait time (ms) after a pause. Used when smart-turn confidence is at or above `smartTurnThreshold`. Default: 250.

**`commitMaxDelayMs`** — maximum wait time (ms) after a pause. Used when smart-turn confidence is at or below `smartTurnLowCutoff`. Default: 2000.

**`smartTurnThreshold`** — confidence level (0–1) above which the system uses `commitMinDelayMs`. Scores at or above this are treated as "clearly done." Default: 0.7.

**`smartTurnLowCutoff`** — confidence level (0–1) below which the system uses `commitMaxDelayMs` with no interpolation. Scores below this are treated as "clearly not done." Default: 0.15.

### `voice.stt.turnTaking.curve`

Shape of the interpolation between `commitMaxDelayMs` and `commitMinDelayMs` for confidence scores in the middle band (`smartTurnLowCutoff` to `smartTurnThreshold`).

**`type: "power"`** — power curve. One parameter:
- `exponent` — controls where in the band the delay drops. `1` = linear. `2` (quadratic) = patient through most of the band, sharp drop near the threshold. Higher values = more patient for longer, steeper drop at the end.

**`type: "sigmoid"`** — S-curve. Two parameters:
- `center` — where in the band (0–1) the curve is steepest, i.e. where the delay drops fastest. `0.5` = midpoint of the band.
- `steepness` — how sharp the transition is. Higher values approach a step function. Lower values approach linear.

---

## `voice.tts`

What voice mode has selected and how it is set. Nothing here declares what exists: models, voices, what each model calls them and each model's voice-loop settings are the roster's, declared in each node's `registry.json` and assembled by the control plane, and provider names are the registry's. `GET /api/voice` builds voice mode's choices from those two. See `voice-config.ts` for the full type definition.

**`selection`** — `serviceId`, `model` and `voice` by roster id: `model` names a roster model, `voice` a roster voice or one of the model's preset voices. The dashboard sends the TTS server each one's runtime key in their place. `speed` is between 0.5 and 2.0.

**`modelPrefs`** — per-model chunking overrides, keyed by `serviceId` and then roster model id.

**`options.minChunkWords`** — minimum number of words to accumulate before sending a chunk to the TTS service. Prevents very short phrases from triggering TTS with insufficient context for natural prosody.
