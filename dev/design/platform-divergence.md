# Platform divergence

Where Banter differs from platform (`~/Code/airavatha/sutradhara/platform`), why, and what should happen to each difference. Read this before porting anything from platform, and update it when a port lands or a decision is made. It describes the current state; the history is in git.

Compared against platform `0b16270`. Start the next audit from there.

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

- `scripts/deploy-preserve-config.sh` names `.integrations.openclaw.lastSessionByAgent`. The live-config port replaces it with a harness-neutral `state.json`, leaving only the one-time repair rule `moveRuntimeState` in `live-config/rules.ts`.
- "Voice chat platform for OpenClaw" in `dashboard/index.html`, `manifest.webmanifest` and `scripts/generate-api-docs.ts`.

[agent-backend-abstraction.md](agent-backend-abstraction.md) covers what a second backend costs.

## Banter is ahead

Banter changes that platform lacks. They stay.

- **Scripts:**
  - the systemd unit rendered from a template, so an install at a non-default location gets a correct unit
  - `.build` pruned from the logs scan
  - `fluid-smoke.sh`'s roster, `/listen` and idle-unload checks, with `fluid-smoke-listen.ts`
- **Dashboard lint fixes:** the `eslint.config.js` rules, `gateway-context.tsx` deriving the connection with `useMemo`, the `use-session-manager.ts` effect dependencies, `use-wake-lock.ts`'s targeted exemption, `services/page.tsx` depending on `[load]`, and `service-history.tsx` deriving its loading state.
- **`CONTRIBUTING.md`:** the testing table and the human-review list.
- **Open-source files with no platform counterpart:** `LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `.nvmrc`, `install.sh`, `render-plist.sh`, `dashboard/scripts/fetch-models.ts` and the `setup` script, the example registries and config, `services/README.md`, `services/fluid/README.md` and `DEVELOPING.md`.
- **Harness-agnostic docs:** `docs/gateway/dsh/` and `docs/gateway/opencode/`.

## Banter is behind: port from platform

In porting order. Platform commits are named so each port can be diffed.

### 1. Small ports

None of these depend on live config.

- **Idle loop stop waits for a pass in progress** (`a21c262`). Applies cleanly; skip `media-job.test.ts`.
- **Chat rebuilds streamed replies from the gateway's increments** (`5109503`).
  - **What it brings:** `ChatTextAssembler`, the model a fallback ran on, context usage refreshed after the run, and the composer's `name`/`aria-label`/`autocomplete`.
  - **Merging:** applies with a three-way merge, except one hunk in `session-manager.ts` whose context names `persistLastAgent`.
  - **Gateway versions:** the assembler handles both delta forms, increments in `deltaText` and the older cumulative `message`, so it holds for any gateway version.
  - **Docs:** the protocol notes go into `docs/gateway/openclaw/openclaw-gateway-protocol.md`.
- **Platform's form of shared script and error handling** (`fd9920e`, `ac32bcb`):
  - `fetchShardRoster` (`shard-client.ts:313`) gets the error snippet, with platform's test.
  - Registry messages use `JSON.stringify` at every site, including `defaults.network.scheme`.
  - Platform's `/api/config/reload` and `/api/voice/selection` definitions, which match Banter's handlers where Banter's don't. Banter's reload definition documents `{ok, version}`, and its voice selection lacks `modelPrefs`, `vad`, `turnTaking`, `takeover` and `saveMicSamples`. Regenerate the API reference afterwards.
  - Scripts:
    - `SHARD_LABEL` defined once in `deploy-env.sh`.
    - `platform_stage_dir` without an optional name.
    - `fluid-build.sh`'s `sw_vers` fallback and Xcode hint.
    - `fluid-smoke.sh`'s `remove_own`, platform-skip and `/var/tmp` safeguards.
    - The control install failing loudly when the registry is missing.
- **Ports written once, in `network.port`** (`f49f429`).
  - The registry refuses a port in `runner.main` and a `PORT` in `ops.env.variables`, and gives any service with a port an endpoint.
  - The example registries use `{port}`, and `service-control.sh` passes `PORT`.
  - Check Banter-only `endpoint-derivation.test.ts` against platform's tests.
- **Dependency ranges.** The `package.json` files take platform's caret ranges in place of exact pins. Run the full test suites, since the lockfile may resolve differently.
- **NeuTTS-Air.** `server.py` passes `max_context=2048`, which upstream `neutts` accepts only with platform's `neutts-max-context.patch`. Port the patch and the README, plus `services/tts/kokoro/README.md`.

### 2. Live config

Platform commits: `de44bd6`, `bdeef42`, `b4d13ea`. This is a pass of its own, taken as platform has it.

- **What it is:**
  - Each node keeps `config.json`, `registry.json`, `shipped/` and `state/state.json` at the top of its deployment folder. A deploy replaces only the code folders it names (`control/`, `dashboard/`, `shared/`, `ops/`, `scripts/`), so it never touches them.
  - Every load syncs each file to a Zod schema, with defaults and repair rules.
  - A config that fails its schema stops startup; Banter's `index.ts:22` swallows the failure today.
  - Saves change one field on disk.
  - Runtime state (`lastAgent`, `lastSessionByAgent`) lives in `state.json`, not `config.json`.
  - A deploy three-way merges the last-shipped, live and repo copies, and stops on a conflict.
- **Files:**
  - `live-config/{sync,merge,rules,deploy}.ts`, `deploy-config.ts`, `sync-templates.ts`, the pre-commit sync, and their tests.
  - `paths.ts`, `paths.test.ts` and `deploy-env.test.ts`.
  - `platform_detect_node`, `{port}` and `{registry}` in `runner.main`, and the probe's shared token loader (`2a893cf`).
  - Whether `history.ts`'s git-backed history comes over is a separate choice.
- **What it replaces in Banter:**
  - `deploy-preserve-config.sh`, its compare-and-prompt, and `--reset-config`.
  - `shard-registry.sh` and `shardRoot`; the shard registry moves from `~/services/shard/registry.json` to the top of the shard's folder.
- **Banter's form:**
  - The merge's repo side is Banter's example files, so an untouched placeholder never conflicts.
  - First-deploy seeding reads Banter's old locations, `control/control-plane/data/` and `~/services/shard/`.
  - `deploy.conf` stays in the checkout's `scripts/`, because it names the deployment folder, and the deploy copies it into `$PROD/scripts/`. Without that copy, a deploy deletes `$PROD/scripts`, recopies it from a git stage that lacks the untracked file, and the scripts systemd runs fall back to defaults. Platform's `~/.config/platform/deploy.conf` stays out.
- **Stripped:** the schema's `mediaGeneration`, `vault` and `content` blocks, media slot and voice fields, `extraOrigins` (`schemas.ts:262`, `registry.ts:124`) and `defaultScheme`'s https default. Hunk-merge `registry.ts`; never overwrite it.
- **Renamed:** `PLATFORM_*` becomes `BANTER_*`, and Banter's folders stay lowercase (`~/services`, not `~/Services`).
- **One commit for the API rename.** `PATCH /api/gateway/defaultAgent` becomes `lastAgent`, and these change together:
  - `gateway-config.ts`
  - `routes.ts`
  - `session-manager.ts`
  - `use-session-manager.ts`, keeping Banter's hoisted effect dependencies
  - the example config and `docs/configuration.md`
  - the regenerated API reference
- **Human review:** the deploy and config scripts, and the probe's reading of `.env.secrets` and its narrower gateway scopes, are on CONTRIBUTING's human-review list.
- **Dependencies:** none new. Zod `4.3.6` is already pinned.

### 3. Docs

Banter takes platform's docs layout, which is where the code's citations point. Twelve Banter files cite `components/voice-turn-taking.md`, and others cite `voice-system.md`, `model-roster.md`, `service-install.md` and `control-shard.md`. Banter has none of these.

- **Port:**
  - `components/voice-turn-taking.md`, `components/stt.md` and `components/tts.md`.
  - `design/`: `voice-system.md`, `turn-taking.md`, `voice-floor.md`, `voice-loop-streaming-stt.md`, `voice-speech-output.md`, `voice-tone-crackle.md`, `fluid-server-streaming-and-structure.md`, `fluidserver-model-lifecycle.md`, `lifecycle-executor.md`, `config-reload.md`, `service-install.md` and `live-config.md`.
  - `services/fluid/STT.md` and `openclaw/tool-call-handling.md`.
  - Move `dev/design/model-roster.md`, `fluid-server-app-identity.md` and `fluid-stt-on-demand-load.md` to `docs/design/`, taking platform's text.
- **Strip and port:**
  - `pages/voice-interface.md`, without Home and media.
  - `components/dashboard.md`, `dashboard-views.md` and `components/index.md`.
  - `OPERATIONS.md`, without the Pi, NAS and personal machines.
  - `control-shard.md`, replacing `docs/architecture/control-shard.md`.
- **Refresh against platform:**
  - `control-plane-api.md`, `registry.md` and `service-lifecycle.md`.
  - The OpenClaw protocol notes.
  - `gateway-tool-and-message-events.md`, which has diverged: Banter's is 496 lines, platform's 285.
- **Replace:** `docs/architecture/voice-pipeline.md` describes `useVoiceLoop`, `useMicLoop`, `LlmStore` and an arbiter, none of which exist, and `README.md:345` cites the arbiter. The voice docs above replace it.

### Lint

`turn-manager.ts` has two `prefer-const` errors and `media-engine.ts` an unused exemption. Both files match platform's, so the fix would start in Banter.

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
- **The PyTorch Kokoro and NeuTTS-Air adapters stay**, as the Linux speech options. Platform has retired them.
- **`probes/browser-audio` stays**, documented for anyone debugging speaker crackle while the microphone is open.
- **UI icons follow platform** (Phosphor).
- **Dependencies are pinned only where a specific version is required**, with the reason beside the pin. Everything else takes platform's ranges, and `bun.lock` keeps installs reproducible. The FluidAudio fork pin is required, since Banter's patches depend on it.
- **OpenClaw tools stay** (see above).
