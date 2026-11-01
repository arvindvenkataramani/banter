# The voice system actor

The voice floor names three actors. The human side and the agent side are objects: each is constructed, reports to the turn manager, and reconciles to its snapshot. The third, the system, "owns the devices, enters and leaves voice mode and plays tones" ([`voice-floor.md`](./voice-floor.md)), and in the code it is `VoiceSystem` (`dashboard/src/lib/voice/system/voice-system.ts`). Everything whose lifetime is one voice session belongs to it. Voice starts from the chat page's tap, which calls `voiceSystem.voiceOn()`; the sequences it runs — acquiring the devices in the tap, starting the services, the stop order — are `VoiceSystem` methods.

## What the system owns

**The phase.** A session is starting, live or ending; no session is off. The phase is the one answer to "what is voice doing", and the interface reads it from `useVoiceSystemStore`.

**The voice mode report.** The turn manager's mode is derived from the phase and the mute store: starting reports `starting`, live reports `live` or `muted`, ending reports `ending`, no session reports `off`. The system reports it on every phase change and every mic mute. Nothing else writes the mode.

**The session id.** A random id made when voice turns on and never reused. Every step of the voice code that resumes after an await asks whether its session is still current by comparing this id, and nothing in the voice code asks any other way. The devices module keeps its own guards against a release arriving mid-acquisition; those protect one asynchronous call inside the device owner and are not session questions.

**The session's services.** Starting the TTS and STT services and loading their models, the mode the STT model was loaded in, and the heartbeat that holds both services while the session lasts. A saved provider change under a running session is a call on the system, which readies the new service and model and re-aims the heartbeat.

**The two sides.** The system constructs the human side and the agent side, attaches them to the gateway session, re-attaches them when the chat page's gateway session changes, pushes new config into them, and stops and detaches them at the end.

**The transcription connection.** Its lifetime and its reconnect policy: replacing a dropped socket, the attempt budget, ending voice when the server displaces it. The transport reports what happened; the system decides.

**The session's tones.** The system records when its session started, holds the promise of each tone it enqueued, and judges a warm start against its own start time. The tone module is a queue that plays tones through the player and resolves each tone's promise when it ends. It reports nothing to the turn manager: a tone has no speaker, and sharing the audio element between tones and speech is the player's own concern, which it settles from the tone it holds.

**The player.** The one player that writes to the page's audio element, which the agent side plays speech through and the tone queue plays tones through. The system holds it and alone initialises, resets and releases it; the agent side and the tone queue each receive only the calls they play with. It is a page-lifetime object, because the element carries the gesture grant, so a session resets it rather than replacing it.

**The last ending.** The reason and message of the last session that ended, for the interface to show.

What outlives a session stays in the session store: config, the selection, the gateway session the chat page publishes, and the service endpoints the other parts read. The devices, the tone queue and the turn manager are called and not owned.

## Collaborators

Diagram: [`voice-system.mermaid`](voice-system.mermaid).

The system is constructed from its collaborators: the devices, the tone queue, the player, the service calls, the loader for the browser's VAD and smart-turn models, the transport factory, the constructors for the human and agent sides, a notifier for messages to the person, a clock, and a source of ids. The page builds one system from the real ones. A test builds one from fakes and drives it with no browser, microphone or server.

The browser models load once per page, the first time the system asks for them. The app asks when it loads, so the first tap rarely waits.

## Voice on

Voice on is called from the tap. It is idempotent while a session is starting or live. Before its first await it finishes clearing a previous session still ending, makes the session id, records the start time, reports `starting`, and calls the devices' acquire, which plays the audio element and calls `getUserMedia` in that order. iOS Safari grants the element and the microphone only inside the gesture; a desktop browser does not enforce this, so a test pins it. An acquire that throws is handled after the first await, as a failed start, so the phase is starting the moment voice on returns.

Then, in one sequence read top to bottom, with the session id checked after every await: the devices resolve; the attempted tone is enqueued; the services start and their models load; the heartbeat starts; the browser models are ready; the gateway session is read from the store, and its absence fails the start; the agent side is built and attached, the human side built; the attempted tone finishes, and the started tone plays unless the start was warm; the transcription connection opens; the loop starts, and the phase becomes live. A start is warm when it reaches that point within two seconds of the tap. A step that finds its session no longer current stops there, and whatever it had acquired is released by the stop that superseded it.

A failure anywhere tells the person why and ends the session with the reason `start-failed`.

## Voice off

Voice off takes a reason: the person stopped, the start failed, the connection was lost, the transcription server is held by another session, or another client took over. It does nothing when no session is running or one is already ending.

It sets the phase to ending, records the reason, and reports `ending`. It resets the mutes and resets the player, which silences it. It detaches the agent side and the gateway session, and begins stopping the listening loop, which settles speech in progress into the transcript and then closes the transcription connection. It stops the heartbeat and clears the session's endpoints. It releases the microphone, and then plays the ended tone. The microphone is released before the tone because closing a capture session switches the audio route, and a tone crossing the switch crackles; a test pins this order.

The loop's settling and the ended tone run at once, neither waiting on the other. When both have finished, if the session is still current, the player is released, the phase becomes off, and the system reports `off`, which resets the turn manager. A voice on during the ended tone performs that clearing itself before starting, so the new session's first report lands on a clean floor.

## The transcription connection

A dropped connection is replaced: the first attempt at once, each later one waiting longer, the count reset once a connection stays up for the stable interval, and voice ended once the budget is spent. What the old socket held and had not finalized is lost, and the person is told once per outage. A connection that another client took over ends voice without reconnecting, since reconnecting would take the model back from the client that just took it.

### Who holds the transcription server

The STT server holds one streaming session at a time, so two clients can want it at once — the same person on the phone and the laptop, or one page reloaded under a new identity. The server decides who holds it by the session id, and the person decides whether to take it from someone else.

A server that follows this rule on its streaming sockets, such as the fluid servers, declares it. Whether a service does is declared, not assumed: a roster provider carries `sessions: true` when its runtime's socket understands session ids, the way it carries `responseFormat`. Taking over is a property of the server, not of transcription specifically — a voice session's TTS provider can hold a slot exactly as its STT service can. VoiceSystem sends a session id and acts on `held` only for an STT service that declares it, since the STT socket is the one it opens and reconnects; any other service, streaming or not, is used exactly as before. On a service that declares sessions, every connection carries the session's id as `session`, and may carry `takeover`. The server gives the slot to a connection when nobody holds it, or when the holder has the same id: that is the session's own reconnect, and the old socket, which the client has already abandoned, is closed. A connection with a different id is refused with `held`, unless it carries `takeover`, in which case the holder is closed with `superseded` and the newcomer gets the slot. A connection without an id has an identity of its own, so it is refused while anyone holds the slot.

The server does not check that a holder is alive before refusing. A holder whose socket died without closing — a phone that locked, a tab iOS reloaded under a new id — costs the next client one refusal and one tap to take over; the server reclaims a quiet session after thirty minutes regardless.

**Every error carries a code.** An error frame has a `code` beside its `message`, and the socket then closes with a matching close code in the 4000 range, so a client acts on the code and never on the wording. The codes name what the client can do something about: `held`, `superseded`, `idle`, `model_not_loaded`, `model_mismatch`, `busy`, `bad_format`, `bad_audio`, `failed`. The protocol reference lists them with their close codes.

**`held` ends voice and asks.** Whether it comes at the start or on a reconnect, voice ends with the reason `held`, and the chat page shows a dialog saying another session is using the voice server, with Take over and Cancel. Take over is a tap, so it turns voice on afresh with `takeover` set on every connection that session makes, and the start is quick because the services and models are still warm. Holding the refused session open behind the dialog instead would keep the microphone held while it waits.

**`superseded` ends voice and says so.** Voice ends with the reason `superseded` and a notice that stays until dismissed. It never reconnects, because reconnecting would take the model back from the client that just took it.

**A preference skips the dialog.** `voice.takeover` in `config.json` is `ask` by default; set to `always`, every connection carries `takeover` and voice is never refused. A "Voice servers" section at the bottom of the Settings dialog's Voice tab sets it, shown only when the selected STT service or the selected TTS provider declares sessions. A `held` refusal from an STT service that does not declare sessions — a fluid-stt whose registry entry has not been updated — cannot be answered with a take-over, so it ends voice with a persistent notice instead of the dialog.

## Rules the code keeps

- Nothing but the system writes the turn manager's mode.
- Within the voice code, every "is this still the current session" question compares the session id.
- Voice on calls acquire before its first await. A test drives voice on and asserts, with no await in between, that the element's play and `getUserMedia` have both been called, in that order.
- Voice off releases the microphone before the ended tone begins. A test asserts the order.
- A transport, a tone or a service reports; only the system ends a session.
- Nothing under `lib/system/` imports from `lib/voice/`.
- No React effect starts or stops voice.
