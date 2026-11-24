# fluid-tts streaming socket

The reference for `fluid.tts.stream`: `fluid-tts`'s own WebSocket for streaming synthesis. Text goes in as it is written, in spans of any length, and audio comes back as each span renders. One connection carries a conversation: the server queues spans and synthesises the next while the client plays the current one.

## Protocol

### Connecting

`ws://<host>:<port>/v1/audio/stream?model=<id>&format=<aac|wav|pcm>&session=<id>&takeover=1`

| Parameter | Meaning |
|---|---|
| `model` | Optional. The roster model the client expects to be resident. The socket never loads a model; a connection naming one that is not resident is refused with `model_mismatch`. |
| `format` | `aac` (the default, AAC-LC in ADTS), `wav`, or `pcm` (headerless 16-bit mono at 24 kHz). Anything else is refused with `bad_format`. |
| `session` | The client's own id for who holds the socket. |
| `takeover` | `1` takes the socket over from another session. |

One connection holds the server at a time, decided by `session` and `takeover` exactly as on `fluid-stt`'s streaming socket:

| Holder | Newcomer | Result |
|---|---|---|
| none | any | the newcomer connects |
| id X | id X | the newcomer connects; the old socket is closed with 4010 and no frame |
| id X | id Y, or none | the newcomer is refused with `held` |
| id X | id Y, or none, with `takeover=1` | the newcomer connects; the holder gets `superseded` and is closed |

A connection with no `session` has no identity to reconnect as, so it is only ever a newcomer. The same claim covers `deepgram.speak.live` at `/v1/speak`.

### Client messages

Every client message is a JSON text message with a `type`. Binary messages are ignored, as are text messages that are not valid JSON or name another type.

| Message | Meaning |
|---|---|
| `{"type":"speak","text":…,"voice"?:…,"ref_audio"?:…}` | Queue a span. `voice` names a roster voice, resolved for the resident model as the speech route resolves it; `ref_audio` is a recording on the server's machine to clone from. An empty span is ignored. |
| `{"type":"cancel"}` | Stop the span being synthesised and drop the queue. |
| `{"type":"Finalize"}` | Wait until every queued span has been sent, and stay open. |
| `{"type":"CloseStream"}` | Wait until every queued span has been sent, then close. |
| `{"type":"KeepAlive"}` | Proves the client is there; never answered. |

At most 32 spans wait in the queue. A `speak` past that is answered with a `busy` error and nothing closes.

### Server messages

| Message | Meaning |
|---|---|
| `{"type":"ready","model":…}` | The socket is open. `model` is the resident roster model, or null. |
| `{"type":"utterance.start","utterance":n,"format":…,"sample_rate":…}` | A span's audio begins. `sample_rate` is the rate of the audio delivered: 24000 for `pcm`, the model's own rate for `aac` and `wav`. |
| binary | Audio of the current span, in `format`. One encoded stream per span, sent every half second of rendered audio. |
| `{"type":"utterance.end","utterance":n}` | The span's audio is complete. A cancelled span has no `utterance.end`. |
| `{"type":"cancelled","queued":0}` | Answers `cancel`. |
| `{"type":"error","code":…,"message":…}` | See below. |

`utterance` numbers spans in the order they were queued, so a client can discard audio from a span it has cancelled.

### Errors and close codes

Errors carry the codes `fluid-stt`'s streaming socket uses. A refusal at connect, a takeover, and an idle socket send the error and then close with the matching code. A failure scoped to one span (a voice the model does not offer, a backend failure, a full queue) is an error message and the connection stays open.

| code | close | when |
|---|---|---|
| `held` | 4001 | another session holds the socket and the connection did not ask to take over |
| `superseded` | 4002 | another session took the socket over |
| `idle` | 4003 | nothing received for 60 seconds |
| `model_not_loaded` | 4004 | no model is resident when a span is synthesised |
| `model_mismatch` | 4005 | `model` names a model that is not resident, or one the roster lacks |
| `busy` | 4006 | the queue is full, or the model is busy with other work |
| `bad_format` | 4007 | unknown `format` |
| `failed` | 4009 | synthesis failed for any other reason |
| `replaced` | 4010 | the same session reconnected (close only, no frame) |
