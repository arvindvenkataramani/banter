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

### 1. Live config

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
  - The control and shard installs fail loudly when the live registry is missing.
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

### 2. Docs that follow live config

These describe config and deploy, so they are brought up to date once live config lands.

- **Strip and port:** `OPERATIONS.md`, without the Pi, NAS and personal machines.
- **Refresh against platform and the new layout:** `control-plane-api.md`, `registry.md`, `service-lifecycle.md`, `event-log.md`, `control-shard.md`, `shard-setup.md`, `stt-setup.md` and `voices-and-models.md`.
- **`docs/architecture/README.md`** says a tailnet is the only configuration; Banter defaults to http.

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
- **Dependencies are pinned only where a specific version is required**, with the reason recorded here, since `package.json` can't hold comments. Everything else takes a caret range (platform's where it has one), and `bun.lock` keeps installs reproducible. The required pins:
  - `onnxruntime-web` 1.18.0, in the dashboard: 1.19 and later drop single-threaded WASM and the `/experimental` export path that the voice activity detector loads.
  - The FluidAudio fork, at a commit: Banter's patches depend on it.
- **OpenClaw tools stay** (see above).
