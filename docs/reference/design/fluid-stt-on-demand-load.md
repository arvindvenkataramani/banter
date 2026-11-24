# fluid-stt: models load on demand and unload when idle

The model fluid-stt serves is loaded by the first request that needs it and dropped after a configured interval without work. An explicit load through the model repository routes also loads a model.

The case that forces this is Deepgram's `/listen`. A Deepgram client has no notion of loading a model, so with the server starting empty, a Deepgram client's first request would fail. The node's lifecycle cannot do the loading either: its idle unload stops the whole process. A registry serving a Deepgram client therefore gives fluid-stt `loadStrategy: "startup"` and `idleUnload: false`, and the server manages its model itself. The registry entry declares this as `models: { loading: "required", autoLoad: "always", resident: "one" }`: a call that names a model the server does not hold loads it, with no explicit call first, and replaces the model that was resident.

## The rules

**A request loads the model it names.** When nothing is resident it loads the named model in the mode the route needs, or the roster's default when it names none. When another model is resident, or another variant of the resident model (a variant is a different model for this rule), a request naming it replaces the resident one once the work in flight has finished. A request naming nothing uses what is resident, and where the resident model cannot serve the request at all (the streaming-only Nemotron, asked for a batch transcription), the refusal stands.

**A model that serves both modes and is resident in one of them gains the other when a request needs it.** The weights are shared, so this adds an encoder and evicts nothing. A batch `/v1/listen` arriving while the dashboard holds the unified model in streaming mode therefore adds the batch half, if the slot is free; while a socket holds the session, it is refused busy, as any second operation is.

**A session is never displaced by a request.** While a socket holds the session, every request is refused at once, whatever model it names. Nothing displaces a session's model while the session lasts. A takeover is the only way in: it ends the holder's session, and the newcomer's model then loads as any request's would.

**A model with variants loads on a request only when the request names the variant.** The server never chooses one. The fluid stream protocol carries it as `chunkMs`; no vendor API has a field for it, so over those a model with variants is loaded explicitly first, through the repository routes, naming the variant.

**A request never downloads weights.** It loads only weights already on the machine; a model whose weights are absent is refused with a load failure, and an explicit load is what fetches them.

## Explicit load

`fluid-stt` and `fluid-tts` provide `triton.model-repository` with the `resident-slot` extension: `POST /v2/repository/models/{name}/load` with `mode` and `variant` in the request's `parameters`, `POST .../unload`, and `POST /v2/repository/index`. A load of what is already resident, with the same variant and an already-loaded mode, changes nothing, where Triton would reload; this matters because voice mode on a second device loads before it takes over. A load that would change the model while a session holds the server, and an unload, are refused. The name is the serving's key.

Banter loads explicitly when the service's declarations call for it (see [voice-system.md](voice-system.md#model-loading)): before a session whose API does not load the model it names, when the model has variants the API cannot name, or ahead of first use when `voice.preload` is on.

## Components

### The resident model

**Role.** The one model the server holds, and the rule for when a request may load it.

**Ownership.** Which model is resident, which modes are up, and whether a load is in flight and for what.

**Key logic.** Every transcription and session entry point names what it needs: a model, by the serving's key, or nothing, and a mode. If the slot is empty, the resident model loads the named model in the requested mode, or the roster's default when none is named, then serves the request. If the named model is resident without the needed mode, it adds the mode. If another model, or another variant of the named one, is resident, a named request replaces it once work in flight ends; a nameless one uses what is resident, gaining the mode where the model has it and refused where it does not. While a session holds the server, a named request that would change the model is refused at once.

Two requests can find the slot empty at once. The check for emptiness and the start of the load are one step: the first request to find the slot empty starts the load and records which model it is loading. A second request for the same model waits on that load and is served when it completes, with no second load. A second request for a different model waits for the first load and then replaces it in turn, as any request would replace an idle resident model.

Waiting on a load is separate from waiting for a busy slot. A request waiting on a load waits for the load itself, which takes about thirteen seconds for warm weights and longer on the first load from a new path, while CoreML compiles for the Neural Engine. A failed load fails every request waiting on it with the load's error and leaves the slot empty. A request never loads a model whose weights are not on this machine, since loading would fetch them; it is refused with a load failure.

A model that needs a parameter loads on a request only when the request carries the parameter. Nemotron needs a chunk size; the dashboard's stream socket sends the one it was loaded with, so voice mode set to Nemotron survives an idle unload. A request naming it without one is refused with the roster's error asking for the parameter, and a request for another tier of the resident model replaces it, since another tier is other weights. The server never chooses a variant.

How the model is built is supplied to the resident model rather than fixed inside it, so tests run the whole rule with stand-in models that load instantly or on a signal.

**Relationships.** Called by every route. Reports activity to the idle unloader. Reads the default from the roster.

### Sessions and queueing

A session is the sole occupant of the service. While a socket holds it, every other request is refused at once, whatever model it names — a batch transcription, an explicit load that would change the model, an unload, a mode addition, another session — except a takeover, which replaces the session. An explicit load already satisfied succeeds without change, because voice mode starting on another device loads before it takes over. Outside a session, requests queue behind one another for up to two minutes, so two batch posts a moment apart, or one behind a long file, both complete. A request already queued when a session begins is refused.

This rests on one person using one client at a time: voice mode and meeting transcription do not run together. Serving both would need a second session on the model, and with it a second streaming encoder in memory.

Deepgram's API decides mode by transport rather than by a default: `POST /v1/listen` is pre-recorded and the WebSocket is live. So a Deepgram client's posts are non-session batch requests and its socket is a session, and it never needs to know about either.

### The idle unloader

**Role.** Drops the resident model after the configured interval without work.

**Ownership.** When work last happened.

**Key logic.** Work is what touches the model: a load, a transcription, a session opening, every audio frame and control message on a session, a session closing. Health checks and model listings are not work; the control plane probes health every fifteen minutes, and counting that would mean the model never idles. When the interval passes with no work, the unloader asks the slot to unload. The slot already refuses to unload during live work, so an open session cannot be dropped from under its socket; a refusal is skipped and the next check tries again. Explicitly loaded models are unloaded the same way: the explicit load is a way to pay the load time up front, and does not pin the model.

The interval is the roster's `idleUnloadMs`, beside the default model in the provider's block. Absent or not positive, it is thirty minutes, with a startup warning for the latter, matching the backstop that closes a session whose socket has gone quiet.

**Relationships.** Fed by the resident model; acts on the slot.

### The roster's default model

**Role.** The model a request that names none loads.

**Key logic.** A field in the fluid-stt provider's block of the registry that registers it, beside the model list the server already reads at startup. The control plane's voice config cannot be the home: the server cannot read it, and it sits on the other machine. The default is validated with the rest of the roster when the server starts: it must name a model in the list, and one that needs no parameter. An invalid default stops startup, as an invalid roster already does. A missing default is allowed; a nameless request into an empty slot is then refused with the existing "no model is loaded" error.

A default that serves both modes answers both the WebSocket and the batch `/listen`; keeping it the model the voice config names stops the two drifting apart.

### The routes

Each route says which mode it needs and passes through the model it was given, if any. The WebSocket routes need streaming and the batch routes need batch. The listen routes pass the client's `model` through as a serving's key, so Deepgram's own model names are not served and a name that is no serving's key is refused; a client that sends none names nothing. The other routes pass the name the client sent.

A WebSocket is accepted before the load begins, and audio arriving during the load waits in the socket. This matters for a Deepgram client that gives the WebSocket handshake a few seconds and waits for nothing after the connection opens.

The dashboard's batch client sends its model name, as its streaming client already does. Without it, a batch transcription after an idle unload would load the roster default, not the model the voice config names. Naming the model keeps the two from drifting apart.

## Out of scope

How long the process runs is the registry's `lifecycle`, outside this design.
