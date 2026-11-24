# Voice settings: one source, edited in Banter

Voice settings live in one place, the Banter server's voice config, and are edited in one place, Banter's settings dialog. The dsh plugin reads them from the server and keeps only the settings that belong to dsh or to the browser it runs in.

Companions: [`dsh-voice-plugin.md`](dsh-voice-plugin.md) (the plugin), [`docs/reference/components/voice-interface.md`](../components/voice-interface.md) (what the tuning values do), [`docs/reference/configuration.md`](../configuration.md) (the stored config).

## Principles

- **One source.** The selection, transcription service, chunking, scope, take-over and tuning are the server's `voice` config. Every client reads them from there; nothing keeps a copy that can drift.
- **One editor, with the plugin's settings UX.** Banter's dialog takes the plugin settings page's layout, wording and behaviour: four tabs (Speech, Listening, General, Help), explanations inline on each control, doc links beside the control they explain, editable tuning sliders at the engine's defaults with a Reset per field. It keeps Banter's own components and styling.
- **What a client keeps for itself is what only it can know.** The plugin keeps the Banter server URL and whether voice stays on outside a conversation. Each browser keeps its playback method, because it is stored in that site's browser storage.

## Components

### Banter's settings dialog

**Role.** The editor for every server-side voice setting.

**Ownership.** The dialog's staged draft and its one Save.

**Key logic.** Four tabs, Speech open first, with the plugin page's content:

- *Speech*: Voice (provider, model among the realtime models, voice, in one row; speed), with the line that only realtime models are listed and links to the speech-models and voices-and-models docs; Chunking (mode with descriptions and "asks for this" on the model's own mode, min and max words with descriptions, provenance badges with tooltips, "Applies to" scope with its doc link, the per-model aside, the note line, Reset to model defaults); Playback method, saved in the browser as soon as it changes.
- *Listening*: the transcription provider with its doc links; Speech detection and Turn taking, the seven sliders with the plugin's descriptions and a "What these do" link. A field the config does not set is an enabled slider at the engine's default, labelled "default (value)"; dragging it sets the field; a set field has Reset, which clears it on Save.
- *Listening* also holds *Transcription mode* under the provider: Streaming (words appear as you speak) or Batch (transcribes after you stop; a little more accurate), with the selected STT model shown beside it. The choice is `voice.stt.preferStreaming`, and it only decides for a model that can do both; a model that does one thing, or one the server says nothing about, decides for itself. While voice is on, a line under the choice says which mode is in use and, when the model decided rather than the choice, why: "In use now: batch, because parakeet-tdt-v3 only transcribes in batch."
- *General*: Always take over (shown when the selected services declare sessions) and Save mic samples.
- *Help*: the plugin page's doc links, grouped under small headings, minus the plugin-only entry.

Everything is staged; Save sends one `PATCH /api/voice/selection` with only what changed and applies the result to the running voice loop as it does today; Cancel drops the draft. The dialog opens on load when the page URL carries `?settings`, and the parameter is then removed from the URL so a reload does not reopen it.

**Relationships.** Reads the voice config from the engine's session store; writes through the control plane's voice PATCH; uses the voice settings model for all logic.

### Voice settings model

**Role.** The pure draft behind the dialog: seeded from the voice config, edited by pure functions, diffed into one PATCH body.

**Ownership.** The tuning field table (keys, ranges, units, descriptions, the engine's defaults), the provider → model → voice cascade, the chunking draft over the engine's `model-settings` and `chunking-setting` reducers with provenance and divergences, and the diff.

**Key logic.** It is the plugin's settings model with its output changed: where the plugin produced dsh path ops over its stored copy, this produces the control plane's `VoiceSelectionPatch`. Selection fields are always sent, as today. Chunking global options, touched per-model entries and scope are sent only when changed. A tuning field is sent with its new value when changed, and as `null` when a stored value was reset. An unchanged draft produces no request.

**Relationships.** Used by the dialog only. It lives in the dashboard; the plugin no longer edits these settings.

### Control plane voice PATCH

**Role.** Unchanged except for one rule: in `vad` and `turnTaking`, a field sent as `null` is removed, so the engine's default applies again. Other fields still merge by key, and an emptied section is kept as `{}`. The commit-delay check (min not above max) compares the values that will stand after the patch, a removed field counting as absent.

### Voice engine: the transcription mode in use

**Role.** Makes the mode voice settled on visible. The engine already resolves batch or streaming at voice start from the model's facts and `preferStreaming`; it now publishes that result, and what decided it (the choice, the model, or nothing known), in its system state while voice is on, and clears it when voice ends. Both settings pages read it there. `PATCH /api/voice/selection` accepts `preferStreaming` (a boolean), written to `voice.stt.preferStreaming`.

### Plugin settings page

**Role.** The plugin's page in dsh's plugin manager, holding only the plugin's own settings.

**Key logic.** One page, no tabs, and no Save or Cancel: every setting saves itself. Five sections, in this order.

1. **Banter server.** The *Banter server URL*, with its help line (the address Banter opens at, which the install script prints). It saves when the field loses focus or Enter is pressed, trimmed and without a trailing slash; a value that is not an `http://` or `https://` URL is not saved and shows the problem under the field until it is fixed; Escape puts back the saved value. Only the saved URL is ever tried, because the host fetches the configured URL and never one the page names.
2. **Service status.** One row per check, each with a state in words as well as colour and, when something is wrong, the reason and what to do; rows are announced to screen readers when they change.
   - *Banter*: Connected, or Can't reach Banter with the reason (no URL set, no answer, or the status the server returned).
   - *Transcription service* and *Speech service*: for the services the voice settings in use name, running, or not running ("voice starts it when needed"), or unreachable, read through the control-plane relay without starting anything (the activation prompt's existing check).
   - *Microphone*: allowed, blocked (with how to unblock it in the browser), or not yet asked, with an "Allow microphone" button that asks and releases the microphone at once.
   - *This page*: Banter's page security notice: no microphone on an insecure page; on a page that is not cross-origin isolated, which dsh's is not, the voice models run on one thread.

   A "Test connection" button re-runs every check; it saves a pending URL edit first. The checks also run when the page opens and after the URL saves. A check changes nothing: the engine keeps its config and the relays keep their services.
3. **Voice settings.** What is in use, read-only, as Banter set it: transcription service with its model and mode choice ("Fluid STT · parakeet-unified-0.6b · streaming", and while voice is on the same "In use now" line as Banter's dialog), provider · model · voice, speed, chunking mode, and take-over, with "loaded <time>". *Reload voice settings* fetches the config from Banter and puts it in use, as the automatic refetches do; while voice is on, a changed selection reconfigures it; a failed reload says why and leaves the settings in use as they were. *Open voice settings in Banter*, a link to `<url>/?settings` that opens in a new tab and is marked as external, with a line saying these settings are changed there and apply to every client; disabled until a URL is saved.
4. **In dsh.** *Keep voice on outside a conversation*, a switch that saves when flipped. *Playback method*, this browser's own, saved as soon as it changes. *Mute shortcut*: a line saying the microphone mute has no default key, with a pointer to dsh's keyboard shortcuts settings where it is bound.
5. **Help.** The plugin docs, install and repository links.

A dsh-stored setting saves with its own `mutate` on dsh's config form, fenced by the revision the page last saw. A brief "Saved" appears beside the setting that saved; a refused or failed write shows its reason there, and the field returns to the stored value. When dsh marks the config read-only, the fields are disabled and the page says so; the status checks, the voice settings section and the playback method still work.

### Plugin host: voice config route

**Role.** Gives the page the server's voice config and fixes which speech services the relays serve.

**Key logic.** A plugin route on dsh's origin, behind dsh's connection check like every plugin route, answers with the control plane's `GET /api/voice`, fetched by the host from the configured URL. The host records the selected STT and TTS service ids from each fetch it makes itself; those ids are what the speech relay, the control-plane relay and the exact-path STT upgrade route serve, and the upgrade route is re-registered when the STT id changes. A relay request arriving before any fetch makes the host fetch first. The ids never come from the page. The control-plane relay's allowlist is unchanged: it still forwards only the three service calls. With no URL configured, the route answers 404; with the control plane unreachable or erroring, 502 with a one-line reason the settings page shows (no answer, or the status the server returned), and the recorded ids stay as they were. A second route answers the settings page's connection check from the same fetch but records nothing, so a check never moves the relays away from the services the engine is using.

### Plugin runtime: reading the config

**Role.** Keeps the engine's voice config and selection in step with the server.

**Key logic.** The runtime fetches the config through the host route when it is created, when the page becomes visible or regains focus, when voice starts, and when the settings page's Reload voice settings button is pressed. The connection check does not count: it never changes the config in use. The start fetch is not awaited: the engine requests the microphone inside the click and reads the config only after that, so the start uses whatever config is in the store then. A fetched config replaces the store's; when its selection or STT service differs while voice is live, the system is reconfigured, as now. `debug` is removed from every fetched config, so the engine never posts microphone samples to dsh's origin. A failed fetch keeps the last config. A start with no config ever fetched fails with "Can't reach Banter at <url>" on the voice button; pressing it retries. The activation prompt checks the services named by the fetched config.

### Install step

**Role.** Builds and installs the package and writes the Banter server URL into the profile. It still calls `GET /api/voice` once, only to fail early with a clear message when the URL is wrong; it stores nothing from the answer.

## Decisions where the obvious approach is wrong

- **Not `/api/voice` through the control-plane relay.** Opening the relay to it would let the page name what the relays serve. A dedicated route lets the host learn the selection from its own fetch, and the relay's allowlist stays as narrow as it is.
- **The start does not wait for a fresh config.** Awaiting a fetch before `voiceOn` would move the microphone request out of the click. A selection changed in Banter seconds before pressing voice on is picked up by the reconfigure that follows the start fetch.
- **The relays serve the selected services, not the whole roster.** Switching services is a Banter edit followed by a refetch, which re-records the ids; serving the roster would widen what dsh's origin can reach for no gain.
- **No shared settings component.** Once the plugin no longer edits voice settings, the dialog is the only editor, so the model and UI live in the dashboard.
- **Playback method stays in both.** Browser storage is per site, so Banter's choice never reaches dsh's page.

## Differences from Banter's behaviour (plugin)

| Behaviour | Banter | Plugin | Reason |
|---|---|---|---|
| Save mic samples | Posts samples to Banter's server when on | Ignored | The engine posts to the page's own origin, and dsh's does not accept them |
| Settings change while voice is on | Applied at Save | Applied on the next refetch: focus, visibility, voice start or the Reload button | The plugin learns of a change only by fetching (impossible otherwise: the server sends no change event the plugin can receive) |
