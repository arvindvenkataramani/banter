# Platform divergence

Where Banter differs from platform (`~/Code/airavatha/sutradhara/platform`), why, and what should happen to each difference. Read this before porting anything from platform, and update it when a port lands or a decision is made. It describes the current state; the history is in git.

Compared against platform `c02b137`, plus the voice engine package from platform's unmerged `voice-engine-package` branch (`d755b1b`, `9c279ff`). Start the next audit from `c02b137`, and treat the package as ported from that branch until it reaches platform's main line.

## The rule

Banter matches platform except where a difference exists for one of two reasons:

1. **Banter leaves out a platform feature.** Banter is platform's chat, voice and services system and nothing else. Home, media, workspace, prompts, the vault and Obsidian, journaling and rituals, the trace panel, and the chat controls that live on other pages stay out.
2. **Banter is meant to become harness-agnostic.** Shared code should not assume one agent harness or gateway. Harness-specific tools, such as the OpenClaw plugin and probe, stay (see [OpenClaw support stays](#openclaw-support-stays)).

Everything else converges on platform, with as little adaptation as possible, even where that changes how Banter works. When a difference doesn't fit either reason cleanly, ask whether platform's form serves Banter's goals: an open-source install by other people, on Linux, over plain http on a LAN. Keep Banter's form only where platform's would break one of those goals, and name the goal. A machine runs one node, never both, so no difference is justified by a control plane and a shard sharing a machine.

Banter always keeps its own styling. UI components, layout and behaviour converge, but how Banter looks does not. That covers the palette, type sizes, radii, the user bubble, `.chat-ambient-wash`, the glow overlay colours, and the logo and favicon. When a port brings platform styling with it, keep Banter's values.

UI and features are tested in platform before they are ported, so a clean port of shared chat and voice code needs no human test here. Review is for the Banter-specific delta: code adapted rather than copied, Banter's own surroundings the code relies on (theme tokens, config), flows platform never runs, and the live-state and exposure items in [CONTRIBUTING.md](../../CONTRIBUTING.md).

Differences the rule doesn't settle are recorded under [Decided](#decided). A new one is raised with the maintainer, and Banter keeps its current form until it is decided.

## How to audit

1. List the tracked files in both repos, excluding `dev/`, and sort them into three lists: in both, only in platform, only in Banter.
2. Compare the files in both hunk by hunk.
3. `git log -3 -- <file>` in both repos tells you whether platform moved after the last port (Banter is behind) or Banter changed something platform lacks (Banter is ahead).
4. Check every finding against the code before recording it. Audits by agents have reported deploys that could not happen, and tests as lost that platform had rewritten.
5. Before taking a platform design, read platform's stated reason for it and check that the reason applies to Banter.
6. Take platform's code and schema, never its deployment values. Platform's live `registry.json` and `config.json` describe its own machines: which services run, their lifecycles, hosts and origins. Banter's example registries keep their own values.
7. Docs describe how the software works and how to configure it. They make no claims about which services an install has, registers, runs or has retired. Outside a doc whose subject is one component, a service is named only as an example. When porting a platform doc, strip what it says about platform's running setup.

## Keep: features Banter leaves out

These hunks are removals and stay removed.

- **Media:** the media page and player, media generation and jobs (`media-job.ts`, `media-routes.ts`, `media-store.ts`, `slot-declarations.ts`, `/api/jobs`, the job sweep, `JobBusyTracker`, `ResultStore`), media slots and voices in `config.json`, `media.*` event types, the media tab in settings, `audio-coordinator.ts`, the shard's job log and results, and the media tests and fixtures.
- **Home:** the home page and surfaces (`home-routes.ts`, `home-surfaces/`), `BottomBand`, `chat-control-cluster.tsx`, `marginalia.tsx`, time-of-day, weather, areas, recency, the home CSS and its tokens (area, TOD, `--sp-*`, `--float-*`), the Caveat font, `shared/pick.ts`, `cancelArm()` in `App.tsx`, and the sitemap footer.
- **Vault and workspace:** `config.vault`, `VaultPaths`, `/api/content`, `workspace.ts`, `workspace-routes.ts`, `frontmatter.ts`, the Obsidian links in tool cards and the nav bar. The probe's vault-read scenario is rewritten as `read-dir`, not removed.
- **Prompts and trace:** `lib/prompts/`, `lmstudio.ts`, the `@prompts` alias, `setGatewayConnection`, `trace-panel.tsx`.
- **Platform-only services and machines:** piper, embedding, searxng, openclaw-mcp, tts-mlx-audio, lm-studio, zotero-mcp, pdf-ocr; `services/tts/mlx-voxtral-swift`, `omnivoice`, `call-contracts`; the legacy `platform-control` and `platform-dashboard` units; platform's own `config.json` and `registry.json` values.
- **Platform's branch flow:** the dev/main prompts in `deploy-source.sh` and `branch-status.sh`, the pre-commit refusal to commit on main, the Pi deploy hand-off in `post-merge`, and `session-start.sh`. Banter commits on main.
- **Platform's personal docs:** `environments`, `infrastructure`, `setup-macbook`, `setup-pi`, `requirements`, `principles`, `roadmap`, `information-architecture`, `orchestrator-adoption.md`, the vault template, and the Pi/Mac sections of shared docs.
- **Structure kept for a future player:** `lib/media-voice-mode.ts`, `lib/media-engine.ts` and `components/media/transport-atoms.tsx` stay, unused, so chat files match platform's.

## OpenClaw support stays

Harness-agnostic means Banter can work with other harnesses, not that it drops OpenClaw. These OpenClaw tools stay, ported from platform like everything else:

- `plugins/voice-mode/`, the OpenClaw voice-mode plugin.
- `control/probe/`, the OpenClaw gateway probe.
- `dashboard/src/lib/gateway-types.ts`, OpenClaw's protocol types.

The agnostic work is adding seams so another harness can sit beside OpenClaw. A port should not spread OpenClaw assumptions into shared code that doesn't need them. Shared code that names OpenClaw, worth revisiting when a second harness arrives:

- `moveRuntimeState` in `control/shared/src/live-config/rules.ts` reads `integrations.openclaw.defaultAgent` and `lastSessionByAgent`, to move them into the harness-neutral `state.json`.
- "Voice chat platform for OpenClaw" in `dashboard/index.html`, `manifest.webmanifest` and `scripts/generate-api-docs.ts`.

[agent-backend-abstraction.md](agent-backend-abstraction.md) covers what a second backend costs.

## Banter is ahead

Banter changes that platform lacks. They stay.

- **Scripts:**
  - the systemd unit rendered from a template, so an install at a non-default location gets a correct unit
  - `.build` pruned from the logs scan
  - `fluid-smoke.sh`'s roster, `/listen` and idle-unload checks, with `fluid-smoke-listen.ts`
- **Dashboard lint fixes:** `caughtErrorsIgnorePattern` in `eslint.config.js`, `gateway-context.tsx` deriving the connection with `useMemo`, the `use-session-manager.ts` effect dependencies, `use-wake-lock.ts`'s targeted exemption, `services/page.tsx` depending on `[load]`, and `service-history.tsx` deriving its loading state.
- **`CONTRIBUTING.md`:** the testing table and the human-review list.
- **Open-source files with no platform counterpart:** `LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `.nvmrc`, `install.sh`, `render-plist.sh`, `dashboard/scripts/fetch-models.ts` and the `setup` script, the example registries and config, `services/README.md`, `services/fluid/README.md` and `DEVELOPING.md`.
- **Harness-agnostic docs:** `docs/gateway/dsh/` and `docs/gateway/opencode/`.
- **Page security notice:** the settings dialog warns when the page is not a secure context, so voice can't reach the microphone, and notes when a secure page is not cross-origin isolated, so the voice models run on one thread (`features/settings/page-security-notice.tsx`, `voice-page-support.ts`). Platform is always served over https, so it never shows.
- **Cross-platform example services:** the example registries register Banter's own `services/stt/faster-whisper` and `services/tts/kokoro` adapters; the fluid servers are an Apple Silicon option in `services/fluid/registry.fluid.example.json`. Every Python adapter reads its CORS allowlist from a `*_CORS_ORIGINS` variable and sends no CORS headers without one.

## Ported ahead of platform's main line

The browser voice engine is the workspace package `@platform/voice-engine` at `voice-engine/`, taken from platform's `voice-engine-package` branch, which platform has not merged. [voice-engine-package.md](voice-engine-package.md) records the boundary. The path map:

| Was | Is |
|---|---|
| `dashboard/src/lib/voice/` (all but the four files below) | `voice-engine/src/` |
| `dashboard/src/lib/system/devices.ts`, `mic-frames-worklet.js`, `dashboard/src/managed-media-source.d.ts` | `voice-engine/src/` |
| `dashboard/src/lib/voice/system/index.ts`, `voice-service.ts`, `apply-voice-settings.ts`, `index.ts` | unchanged, in the dashboard |
| `agent/speech-chunker.test.ts`, `human/whisper-features.test.ts`, `voice-service.test.ts` | unchanged, in the dashboard |
| `RunEvent`, `Activity` (`run-state.ts`) | `voice-engine/src/run-event.ts`, re-exported from `run-state.ts` |
| `VoiceAnnotation`, `registerAudioHalter` (`controls.ts`) | `voice-engine/src/session.ts`, `voice-engine/src/audio-halters.ts` |
| `VoiceSelectionPatch`, `VoiceUpdateResult` (`api.ts`) | `voice-engine/src/voice-config.ts`, re-exported from `api.ts` |
| `SttModelKind` (`voice-service.ts`) | `voice-engine/src/human/stt-transport.ts` |

Banter's copy differs from the branch only where Banter's voice code already differed: comment pointers to Banter's docs, and the CORS hint in `stt-client.ts`.

## Banter is behind: port from platform

Against platform `c02b137`, every code change is ported apart from the items below.

### Not taken yet

Live config's git-backed history of the live files (`history.ts`).

### Lint

`react-hooks` 7.1 reports `set-state-in-effect` in `features/services/page.tsx`, `features/services/service-detail.tsx` and `use-session-manager.ts`. Platform carries findings of the same rule in other files. `service-detail.tsx` matches platform's, so its fix belongs in platform; the other two are Banter's own versions.

## Decided

- **Naming follows who sees the name.**
  - **Names a user sees are Banter's:** `BANTER_` env variables, `com.banter` bundle and plist IDs, "Banter" in titles and device labels, and the schema file's `$id` and title.
  - **Example hosts and people are generic** in tests, examples and comments (`gpu-machine`, `home-server`, `example`, `alex`).
  - **Internal names are platform's, and a port never renames them:** the `@platform/*` packages, the `platform_*` shell helpers, `PlatformConfig`, and `PLATFORM_DIR` in `shard-runner.swift`.

- **Config, registry and state live inside each node's deployment folder.** No config files sit outside the install. `deploy.conf`, which names the folder, lives in the checkout and is copied in.
- **The control port** is read from the registry's `control` entry, and `BANTER_CONTROL_PORT` overrides it.
- **http is the default scheme, and platform's origin rule stays out.** Banter has to work on a LAN or a plain IP without Tailscale, and documents why https is safer and how Tailscale provides it. Platform's https default and its origin rule assume a tailnet, so these stay out, with their test cases:
  - `forward.ts`
  - `origin.ts`
  - `extraOrigins`
  - the `/svc/` endpoint rewrite
  - whisper's loopback bind
- **The Kokoro and NeuTTS-Air adapters stay**, as cross-platform speech options. Platform has retired them.
- **Banter installs no Python.** `install.sh` seeds the registry and points at each adapter's README, which tells a user how to install it.
- **`probes/browser-audio` stays**, documented for anyone debugging speaker crackle while the microphone is open.
- **UI icons follow platform** (Phosphor).
- **Dependencies are pinned only where a specific version is required**, with the reason recorded here, since `package.json` can't hold comments. Everything else takes a caret range (platform's where it has one), and `bun.lock` keeps installs reproducible. The required pins:
  - `onnxruntime-web` 1.31.1, in `voice-engine/package.json`: `loadOrt()` imports ORT's prebuilt `ort.wasm.bundle.min.mjs` and `ort-wasm-simd-threaded.wasm` by file name, so an upgrade must keep both files and their unbundled load. Check voice mode in a production build after any upgrade; [turn-taking.md](../../docs/design/turn-taking.md#one-multi-threaded-ort-runtime-never-bundled) has the reasons.
  - The FluidAudio fork, at a commit: Banter's patches depend on it.
- **OpenClaw tools stay** (see above).
