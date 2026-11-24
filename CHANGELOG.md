# Changelog

What changed in each release, for someone updating from the one before. What goes here is in [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

## Unreleased

## 0.2.0

### Action needed

- Each speech service in the registry declares the APIs Banter calls it through, in its [`provides`](docs/reference/components/registry.md#provides) list. A service you registered by hand needs one; a roster provider whose service has no API Banter can call it through stops the registry from loading.
- Install the dsh plugin from this release. The plugin and the server share the shape of `GET /api/voice`, which changed, so a 0.1 plugin cannot use a 0.2 server.

### New

- The fluid servers serve the standard speech APIs: OpenAI transcription, speech and Realtime, Deepgram's listen and speak routes, and the model repository routes for loading models. [The speech server API](docs/reference/speech-server-api.md) lists what each provides.
- A voice selection that Banter cannot call is shown beside its picker in the voice settings, and the STT picker lists a service with no API to transcribe through as disabled. A selection save naming such a service is refused. See [the selection check](docs/reference/design/service-apis.md#selections).
- [Test environment](docs/reference/test-environment.md): running a branch's control plane and fluid servers beside an installation.

### Changed

- The fluid servers load models through `POST /v2/repository/models/{name}/load`; `POST /v1/models/load` is gone.
- The example config streams transcription by default (`voice.stt.preferStreaming: true`).

### Fixed

- The dsh plugin releases everything it holds when it is turned off.
- `POST /v2/repository/index` on the fluid servers answers without a request body.
