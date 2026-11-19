# The voice floor: who may speak, decided in one place

Why the voice loop's turn-taking is shaped the way it is. What each actor does is in [`docs/components/voice-turn-taking.md`](../components/voice-turn-taking.md).

## One turn manager, and actors that report

One turn manager computes who has the floor. Every actor reports its own state to it and none decides the floor for itself: the microphone loop does not pause the player, the mute control does not resume it, the player does not infer from a chunk arriving that it may speak. Each reports what is true of itself, reads the turn manager's snapshot, and moves itself to match.

The turn manager is a reducer with memory, the shape the conversation state takes in `run-state.ts`: a sequence of reports in, one snapshot out, and the snapshot is the only thing anyone reads. Memory is what separates it from a selector over several stores. A selector answers only questions about the present, and the hard questions in turn-taking are about the past: why the player is silent, what the current utterance interrupted, whether the run in progress was ever voiced. Callers that carry that memory for the turn manager, across an await or in a latch, are where the faults this design removed all lived.

Three rules govern reporting, and they are what make the turn manager's picture trustworthy.

**Anything that persists is reported as a level.** A report says "this is all of me, now", and the next report overrides it. The turn manager stores each actor's last report, so a dropped report is corrected by the next one. An utterance's outcome is a level too: it stays on the last utterance until the next replaces it.

**A report is a function of the actor's ground truth.** The media element's paused flag and what has been appended to it, the recorder's buffer, the gateway's run snapshot. An actor's bookkeeping about those things is what drifts; where an actor keeps a flag a report would also carry, the flag is derived the same way.

**A report is made when the thing happens, never after an await.** Within one actor, JavaScript orders synchronous reports correctly against each other; a report issued after an await describes a world that may have moved.

Actors move themselves by reconciling, not by obeying commands. Each has one function that reads the snapshot and its own state and closes the gap: the player asks "may I be audible, and am I", and pauses, resumes or leaves itself alone. It runs on every snapshot change and on every event of the actor's own, so a chunk arriving during a human turn consults the floor before playing. Reconciliation is idempotent, so a missed notification costs one interval. The mechanics of being audible on iOS, of MediaSource, of a tone on a shared element, stay inside the player: the turn manager decides who may speak and never how.

A store holds state another actor reads or the interface shows; everything else — buffers, queues, timers, browser-API wrappers, per-frame scratch — is mechanism and stays inside the class that owns it. Actors report on meaningful transitions, not on every input: a mic frame never reaches a store, and a log of one turn should run to tens of events, not hundreds. A store that logs everything cannot be read during a bug.

Chunking text for synthesis, joining a turn's transcripts into a message, and the media element's lifecycle are not floor questions. They stay in their actors, which read the snapshot where they need it.

## Three actors, two speakers

The human and the agent take turns; the system — the interface itself — never does. It owns the devices, enters and leaves voice mode and plays tones, but it has no utterance and never holds the floor.

Each speaker has a side that converts in one direction: the human side hears audio and produces text, the agent side receives text and produces audio. Because they convert between the same forms, they report the same utterance shape. The conversation is the text medium outside all three. The human side's words reach it through `session.controls`; the agent side reads it through `session.conversation`. Neither side touches the gateway, and neither imports the other.

The human's words entering the conversation is the moment the floor changes hands, so the turn manager delivers a finished human turn itself rather than through an actor mirroring the chunker. A separate sender would re-derive "this turn is finished" from the snapshot and keep a private record of what it had delivered: the same fact in two places. The asymmetry is real — the human may interrupt the agent and never the reverse — and a structure that made the two sides mirror each other here would be prettier than it is true. The abort of an interrupted run lives in the same place for the same reason: it is the human's act, carried out on the human's channel, and neither side gains a way to stop the other.

Delivery and the abort read the state a reduction produced and report nothing back, so the reduction stays a pure function and replaying a sequence of reports yields the same state.

## Utterances and turns

An utterance is a stretch of speech; a turn is the turn manager's construct over utterances, and no actor reports one.

The human side reports only an utterance it is confident in. The loop gates on duration and speech probability and reports nothing until both are met, so a cough never reaches the turn manager and opens no turn: noise is not arbitrated at the floor because it never arrives there. That is why the first phase is `hearing` and not an onset. An onset is a VAD verdict revised several times a second; a turn cannot be built on one.

A hand-off ends a human utterance, and it cannot be reopened because a streaming transcription cannot be: `Finalize` resets the server, and words before it cannot be asked for again. A mis-detected end is recovered in the turn instead. Speech that follows is a new utterance with its own id, and while the first is still transcribing it joins the same turn, so one message carries both. The id is also what keeps the first utterance's facts from being overwritten, and what distinguishes two rejections in a row from one.

A turn extends past its speech on one side. The agent's turn opens when its run begins, and generation runs before any audio exists: a silent leg before its utterance. The human's turn keeps going after the last utterance ends while the transcript is in flight: a silent leg after. Each speaker's conversion between text and audio is the silent leg.

Turns overlap while one is closing. From the human's turn being sent until the agent's audio begins, the human's turn is closing and the agent's is opening. The floor is the agent's, and the human's turn is still reopenable: speech confirmed then reopens it, the new utterance joins, and the agent's turn ends `preempted`. For the human that is a resumption rather than an interruption. The first message has already reached the gateway; what the model makes expressible is that the second continues it.

A confirmed human utterance ends an open agent turn — `superseded` if it was speaking or closing, `preempted` if it was opening — and the run is aborted at the same moment, so the agent stops generating as well as sounding. The transcript plays no part, and there is no resumption: an utterance that turns out to hold no words leaves the agent stopped. The cost is narrow because the loop reports only speech it is confident in.

## What the turn manager remembers

Beyond each actor's last report, the memory attaches to turns. The last turn each speaker ended is kept, so an outcome outlives the turn that carried it; one per speaker, because every rule needs only the last. What a human turn interrupted — the agent turn's phase, how much audio remained, whether its run was active — is recorded at the moment of interruption, because the annotation is read at send time and the interruption's own abort has ended the run by then. Why the agent is paused is either speech mute or nothing: human speech is not a pause reason, because it ends the agent's turn, and a new agent turn clears the reason so one belonging to a finished turn cannot silence the next. Whether the agent's turn was voiced is fixed when it opens: a turn begun under speech mute discards its audio rather than parking it, and unmuting mid-turn does not voice it.

The annotation gives a run still active at the interruption precedence: it is `interrupted-working` even when the agent was audibly speaking, which is the common case, since synthesis starts before the run ends. `interrupted-speaking` needs a run already over and more than `interruptionMinRemainingS` of audio left. Seconds of buffered audio are a proxy for the agent still speaking, because generated speech carries trailing silence; a better signal would belong to the player's report, and the turn manager would still decide what it means.

## Rules the code keeps

These hold by construction and no test can check them, so a change that breaks one breaks the design:

- The human side and the agent side import nothing from each other, and neither imports `gateway-connection` or calls `session.send` or `session.abort` directly.
- No actor reads another actor's state except through the snapshot.
- No report is issued after an `await` on the path that observed the thing reported.
- `reduce` has no side effects and no reference to a store, element or timer; the reconcile functions are idempotent.
- `voice-engine/src/devices.ts` imports none of the engine's other modules.
- The tap reaches `acquire()` synchronously, through voice on, never through a subscription or an effect, and inside it the element play and `getUserMedia` both start before the first `await`, in that order. iOS Safari grants both only inside the gesture.
- Nothing attaches to the frame source on a path that has not awaited the opening tones, and the mode reports `off` only after the last release of a session, never to cause one.

## The system: devices, mode and tones

The system owns the devices. The audio element and the gesture grant it carries, the microphone stream, its `AudioContext` and the frame source are acquired when voice mode is entered and released when it is left, and the speech actors borrow them. The iOS gesture rules force this: the element is played and the stream requested inside the tap, so ownership sits outside the speech actors whether or not it is named. The recorder stays with the loop, because an utterance buffer is turn state and not device state.

Mode is the system's phase and the turn manager's outermost condition. `starting` covers the stretch from the tap until the microphone is listening, and `ending` from voice-off until the ended tone has played; the floor is `nobody` outside `live` and `muted`. The mic's `AudioContext` is built at the frame source's first attach, after both tones have settled, and that placement is load-bearing: opening a capture session switches the device's audio route, and a tone sounding across the switch crackles — see [`voice-tone-crackle.md`](voice-tone-crackle.md).

A tone is a sound with no speaker, so it is not a floor question and the turn manager never hears of it. Tones play through the player the system owns, on the same element as speech, and the player leaves the element alone while it holds a tone; a tone never reads as the agent speaking.

The system is one object, `VoiceSystem`, which owns the session, its services and connection, the two sides and the player; [`voice-system.md`](voice-system.md) is its design record.

## The transcript

The words live in one transcript, and the composer is a view of it. A turn is about the floor; the transcript is about the words, and it outlives turns that end without sending — a rejected burst, a socket replaced mid-sentence — and voice sessions: voice-off settles speech in progress into the transcript and leaves it there for the send button. Nothing empties it but a send.

A mute pauses the utterance being heard and never ends it, so the turn stays open and the agent stays quiet; unmuting resumes the same utterance. Muting is never a reason to say something. Focusing the composer auto-mutes and then settles the paused utterance, so its words become text the field can edit, and the turn it held does not close while the person edits: nothing is sent by voice from under a focused field. The send button closes it at once.
