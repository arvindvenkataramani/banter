# config.json

Platform configuration for the control plane. Edit `config.json` directly — this file documents what each field does.

---

## `voice.stt`

Speech-to-text pipeline configuration.

**`serviceId`** — registry ID of the STT service (Parakeet). Used to start the service and resolve its endpoint.

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

Text-to-speech configuration. See `voice-config.ts` for the full type definition.

**`options.minChunkWords`** — minimum number of words to accumulate before sending a chunk to the TTS service. Prevents very short phrases from triggering TTS with insufficient context for natural prosody.
