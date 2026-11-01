# fluid-stt: models load on demand and unload when idle

The fluid-stt process runs for as long as the shard does. The model it serves is loaded by the first request that needs it and dropped after a configured interval without work. An explicit load through the model-lifecycle endpoint also loads a model.

The case that forces this is Deepgram's `/listen`. A Deepgram client has no notion of loading a model, so with the server starting empty, Anarlog's first request always failed. The shard cannot do the loading either: fluid-stt is registered never to be idle-unloaded, because the shard's idle unload stops the process, and the process is what has to stay up.

## The rule that does not change

A request never replaces a resident model. It loads only into an empty slot. When a different model is resident, a request naming another one is refused with the existing mismatch error; when the resident model cannot serve the request at all (the streaming-only Nemotron, asked for a batch transcription), the existing refusal stands. The dashboard's voice mode loads its model explicitly and relies on nothing switching under it, and the benchmark harness relies on no load landing inside a timed transcription. Both hold because the only thing a request can do to an occupied slot is use it.

One extension sits inside the rule. A model that serves both modes and is resident in one of them gains the other when a request needs it, as an explicit load already does: the weights are shared, so this adds an encoder and evicts nothing. A batch `/listen` arriving while the dashboard holds the unified model in streaming mode therefore adds the batch half, if the slot is free; while a socket holds the session, it is refused busy, as any second operation is.

## Components

### The resident model

**Role.** The one model the server holds, and the rule for when a request may load it.

**Ownership.** Which model is resident, which modes are up, and whether a load is in flight and for what.

**Key logic.** Every transcription and session entry point names what it needs: a model id or nothing, and a mode. If the slot is empty, the resident model loads the named model in the requested mode, or the roster's default when none is named, then serves the request. If the named model is resident without the needed mode, it adds the mode. If another model is resident, a named request is refused; a nameless one uses what is resident, as it does today, gaining the mode where the model has it and refused where it does not.

Two requests can find the slot empty at once. The check for emptiness and the start of the load are one step: the first request to find the slot empty starts the load and records which model it is loading. A second request for the same model waits on that load and is served when it completes, with no second load. A second request for a different model is refused with the mismatch error once the first load lands, never served by unloading the first. Without this, two requests racing on an empty slot would serialize into "load A, then unload A and load B", which is the switch the rule forbids.

Waiting on a load is separate from waiting for a busy slot. A request waiting on a load waits for the load itself, which takes about thirteen seconds for warm weights and longer on the first load from a new path, while CoreML compiles for the Neural Engine. A failed load fails every request waiting on it with the load's error and leaves the slot empty. A request never loads a model whose weights are not on this machine, since loading would fetch them; it is refused with a load failure.

A model that needs a parameter loads on a request only when the request carries the parameter. Nemotron needs a chunk size; the dashboard's stream socket sends the one it loaded with, so voice mode set to Nemotron survives an idle unload. A request naming it without one is refused with the roster's error asking for the parameter, and a request for another tier of the resident model is a mismatch, since another tier is other weights. The server never chooses a variant.

How the model is built is supplied to the resident model rather than fixed inside it, so tests run the whole rule with stand-in models that load instantly or on a signal.

**Relationships.** Called by every route. Reports activity to the idle unloader. Reads the default from the roster.

### Sessions and queueing

A session is the sole occupant of the service. While a socket holds it, every other request is refused at once — a batch transcription, an explicit load that would change the model, an unload, a mode addition, another session — except a takeover, which replaces the session. An explicit load already satisfied succeeds without change, because voice mode starting on another device loads before it takes over. Outside a session, requests queue behind one another for up to two minutes, so two batch posts a moment apart, or one behind a long file, both complete. A request already queued when a session begins is refused.

This rests on one person using one client at a time: voice mode and meeting transcription do not run together. Serving both would need a second session on the model, and with it a second streaming encoder in memory.

Deepgram's API decides mode by transport rather than by a default: `POST /v1/listen` is pre-recorded and the WebSocket is live. So Anarlog's posts are non-session batch requests and its socket is a session, and it never needs to know about either.

### The idle unloader

**Role.** Drops the resident model after the configured interval without work.

**Ownership.** When work last happened.

**Key logic.** Work is what touches the model: a load, a transcription, a session opening, every audio frame and control message on a session, a session closing. Health checks and model listings are not work; the control plane probes health every fifteen minutes, and counting that would mean the model never idles. When the interval passes with no work, the unloader asks the slot to unload. The slot already refuses to unload during live work, so an open session cannot be dropped from under its socket; a refusal is skipped and the next check tries again. Explicitly loaded models are unloaded the same way: the explicit load is a way to pay the load time up front, and does not pin the model.

The interval is the roster's `idleUnloadMs`, beside the default model in the provider's block. Absent or not positive, it is thirty minutes, with a startup warning for the latter, matching the backstop that closes a session whose socket has gone quiet.

**Relationships.** Fed by the resident model; acts on the slot.

### The roster's default model

**Role.** The model a request that names none loads.

**Key logic.** A field in the fluid-stt provider's block of the shard registry, beside the model list the server already reads at startup. The control plane's voice config cannot be the home: the server cannot read it, and it sits on the other machine. The default is validated with the rest of the roster when the server starts: it must name a model in the list, and one that needs no parameter. An invalid default stops startup, as an invalid roster already does. A missing default is allowed; a nameless request into an empty slot is then refused with the existing "no model is loaded" error.

The default is `parakeet-unified-0.6b`. It serves both modes, so one default answers both the WebSocket and the batch `/listen`, and it is the model the voice config already names.

### The routes

Each route says which mode it needs and passes through the model it was given, if any. The WebSocket routes need streaming and the batch routes need batch. `/listen` ignores the client's model name, which is Deepgram's vocabulary, and so names nothing; the dashboard's routes pass the name the client sent.

A WebSocket is accepted before the load begins, and audio arriving during the load waits in the socket. This matters for Anarlog: its client gives the WebSocket handshake five seconds, retries three times, and waits for nothing after the connection opens. Its batch client sets no timeout.

The dashboard's batch client sends its model name, as its streaming client already does. Without it, a batch transcription after an idle unload would load the roster default, not the model the voice config names. Naming the model keeps the two from drifting apart.

## Out of scope

The shard's lifecycle for fluid-stt is unchanged: started with the shard, never idle-unloaded.
