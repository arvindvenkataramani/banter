# Streaming transcription in the voice loop

Why the voice loop can transcribe over a socket as the person speaks, and how that sits beside batch transcription without a second loop. The transport's mechanics are in [`../components/stt.md`](../components/stt.md); how the words become a turn is in [`voice-floor.md`](voice-floor.md).

## Why streaming

Not latency, and not accuracy — streaming costs accuracy. `parakeet-unified-0.6b-streaming` transcribes at 0.051 WER against the batch model's 0.033, measured on podcast speech that is not the voice or room of the person using the system.

It is for **visible system state**. Banter can run on modest hardware over a remote link, and a batch turn is a silent gap: the user speaks, nothing happens, and text appears. Nothing in that gap distinguishes a working system from a wedged one. Streaming makes the gap legible, because text arriving is evidence that capture, socket, server and model are all alive at once.

That goal sets the contract the rest of this record answers to: **the interface always reflects what the system is actually doing.** A transcript that stalls silently, a socket that dies unannounced, or a display that quietly repairs itself all violate it — not because information is lost, but because the readout stops being true.

The accuracy cost is accepted, unmeasured against this user's own speech. Benchmark WER on read podcast audio does not predict what 1.5× the errors feels like in conversation, and the way to find out is to use it.

Streaming-trained ASR is also improving quickly, and the socket, the turn handling and the display built here outlast any particular model. Adding one is a catalogue entry.

## One loop, with a transport seam

Both transports run through the same `MicLoop`. Nothing that decides when an utterance ends — VAD, silence counting, smart-turn, the commit curve, the confidence gate — reads a transcript; text appears only after the decision. Turn detection is transport-agnostic in fact, and a second loop would be a second copy of the one piece of this system that is genuinely difficult to get right.

What differs is confined to four moments, which is the whole of the seam (`human/stt-transport.ts`):

| Moment | Batch | Streaming |
|---|---|---|
| per frame | nothing | encode and send |
| hand-off | `encodeWav`, POST, await | `Finalize`, await the final |
| discard | nothing to clear | `Finalize`, drop the answer |
| mute | nothing to send | stream `pauseFlushMs` of silence, then stop sending |

**The transcript does not belong to the loop.** Partials go from the transport through `HumanVoice` to the transcript store. `MicLoop` never sees one. This is what keeps a single loop honest rather than merely shared: if turn detection held a transcript, the two transports would share a loop that means different things in each.

**A discard costs something on streaming.** In batch, every decision not to transcribe is free, because the audio never left the device. On streaming it is already in the server's session context, and `Finalize` is the only thing that clears it, so a discard is a `Finalize` whose answer is thrown away.

**Audio streams continuously, on its own schedule.** Every captured frame is sent, while VAD independently decides boundaries. The encoders carry state across frames, so a frame dropped because VAD was busy would be a hole in the audio, where for VAD it is only one missed verdict.

**A mute is a transport concern.** With a socket open, a muted room would otherwise stream to the server and keep its idle timer alive. The pause's silence flush exists because a streaming model produces text for audio only as more audio arrives behind it; without it the last words before a mute would appear only at unmute.

### Cost

Streaming is lighter in the browser, not heavier. It adds no ONNX inference: per frame it costs one `AudioEncoder.encode` — WebCodecs, native, off the main thread — and one `send`, both trivial beside the Silero inference already running on every frame. What it removes is `encodeWav` over the whole utterance at hand-off, on the main thread, inside the latency path: a thirty-second utterance is 480,000 samples converted at exactly the moment the user is waiting.

The cost it adds is the server's. Audio streams continuously, so inference runs through silence on the shard host.

## Connection

The socket outlives an utterance and must outlive `MicLoop`. It holds the server's one resident model while open, keeps it through any silence, gives it up when a newer connection takes the session over, and can drop mid-utterance. It is owned above the loop and replaced when it drops.

**A dropped socket is replaced.** When the socket closes while voice is on, the loop builds a new transport and swaps it into `HumanVoice`, which applies whatever mute is in force. The service is still running, and a new connection takes the session over from one that dropped silently, so the server never refuses the reconnect. The first attempt goes at once and each one after waits `delayMs` longer than the last. A socket that stays up for `stableMs` resets the count; one that drops sooner counts as a failure, so a fault that recurs just after the server accepts the session ends voice instead of reconnecting forever. The numbers live under `voice.stt.reconnect`.

What the old socket held and had not finalized is lost with it. Every utterance awaiting a final ends `rejected: 'failed'`. Speech under way at the swap began on the old socket, so its final covers only what came after; that utterance ends `abandoned` and its surviving words go to the composer, since sending them would give the agent half a sentence. One notice per outage says words were lost. Replay would need the audio kept on the client, and a transcript arriving after the person saw it go missing would have the display rewriting its own history.

Two closes end voice instead. An error saying a newer connection took the session over means another client wants the model, and reconnecting would close theirs in turn. And once `attempts` connections in a row have failed, voice turns off by the path that plays the `ended` tone, with an error that stays until dismissed: a missed notice leaves the interface looking healthy while nothing is listening. A reconnect carries the model and tier it was opened with, so a service that loads on request and unloaded the model while idle loads it again; one that loads only explicitly fails every attempt and ends voice.

A quiet client keeps its session; the server reclaims one only after thirty minutes with nothing received. A page the browser stops running — a locked phone, a Safari window behind another app — sends nothing while stopped and finds its socket open when it resumes, unless the browser dropped it, and then the reconnect takes over.

The transcript's visible end is trimmed to the last settled word boundary. Rendering a partial mid-word token as a whole word claims recognition the server never reported.

## Failure

A socket fails on connect, mid-utterance, and at `Finalize`, and each loses a different amount. The last is the worst: the audio was all sent, the transcript exists on the server, and the connection dies before it returns — everything said, nothing received.

They are reported distinctly rather than flattened. The user's next action differs — repeat the turn, or carry on — and a single message cannot say which. Flattening every cause into "the service is unavailable" states the one thing that is often false.

## Open

**How often the socket actually drops.** Unknown, and the thing that decides whether recovery deserves more design. Ordinary use answers it; nothing else does.

**What a discarding `Finalize` costs.** Around sixty milliseconds of transcription, and a round trip for every burst the loop rejects. Whether that is worth avoiding, given `Finalize` is the only reset the protocol offers, is unmeasured.

**Time to first word is the model's, not the pipeline's.** Measured against fluidserver directly, `parakeet-unified-0.6b-streaming` emits its first word 1.4–2.1 s after the audio starts. No turn-taking setting touches it — those govern when an utterance ends. It bounds what streaming can feel like, and the lever is which model is loaded.

**Verbal corrections.** Speaking a correction and having a small model apply it to the transcript before it sends. A direction the editable transcript makes possible; not designed.
