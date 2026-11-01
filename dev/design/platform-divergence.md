# Platform divergence

Where Banter differs from platform (`~/Code/airavatha/sutradhara/platform`), why, and what should happen to each difference. Read this before porting anything from platform. Update it when a port lands or a decision below is made.

Last audited: 2026-10-31, against platform `dev` at `ac32bcb` (merged to `main` as `cd91d71`) and Banter `c5b01dc`, then rechecked on 2026-11-01 against `0b16270`, which adds `b4d13ea`, `2bab179` and `0b16270`, this time including `docs/`. Of 392 files present in both repos (excluding `dev/`), 157 differ: 61 are files touched by platform's nine commits since `6703915`, and the other 96 all fall into a bucket below, apart from the gaps listed under [Banter is behind](#banter-is-behind-port-from-platform). An earlier audit the same day, against `6703915`, found the ports in the table below, and they have all landed.

**Porting rubric (Arvind, 2026-10-31).** Keep adaptation to a minimum and do things the way platform does wherever possible, even when that changes how Banter works. When a difference doesn't fit a bucket cleanly, ask whether platform's form serves Banter's goals: an open-source install by other people, on Linux, on one Mac running both nodes, over plain http on a LAN. Keep Banter's form only where platform's would break one of those goals, and name the goal.

## The rule

Banter matches platform except where a difference exists for one of two reasons:

1. **Banter leaves out a platform feature.** Banter is platform's chat, voice and services system and nothing else. Home, media, workspace, prompts, the vault and Obsidian, journaling and rituals, the trace panel, and the chat controls that live on other pages stay out.
2. **Banter is meant to become harness-agnostic.** Shared code should not assume one agent harness or gateway. Harness-specific tools, such as the OpenClaw plugin and probe, stay (see [OpenClaw support stays](#openclaw-support-stays)).

Everything else converges on platform. Arvind tests UI and features in platform before they are ported, so a clean port of shared chat and voice code needs no human test here. Review is for the Banter-specific delta: code adapted rather than copied, Banter's own surroundings the code relies on (theme tokens, config), flows platform never runs, and the live-state and exposure items in [CONTRIBUTING.md](../../CONTRIBUTING.md).

This supersedes the migration plan's "Banter's UI stays as it is". The services page and other shared UI converge too.

Some differences are not settled by the rule. They are listed under [Open decisions](#open-decisions), with the position Banter takes until they are decided.

## How to audit

List the tracked files in both repos (excluding `dev/` and `docs/`), and sort them into three lists: in both, only in platform, only in Banter. Compare the files in both hunk by hunk. `git log -3 -- <file>` in both repos tells whether platform moved after the last port (Banter is behind) or Banter changed something platform lacks (Banter is ahead). Check every finding against the code before recording it: audits by agents have reported deploys that could not happen and tests as lost that platform had rewritten.

## Keep: features Banter leaves out

These hunks are removals and stay removed.

- **Media:** the media page and player, media generation and jobs (`media-job.ts`, `media-routes.ts`, `media-store.ts`, `slot-declarations.ts`, `/api/jobs`, the job sweep, `JobBusyTracker`, `ResultStore`), media slots and voices in `config.json`, `media.*` event types, the media tab in settings, `audio-coordinator.ts`, and the media tests and fixtures.
- **Home:** the home page and surfaces (`home-routes.ts`, `home-surfaces/`), `BottomBand`, `chat-control-cluster.tsx`, `marginalia.tsx`, time-of-day, weather, areas, recency, the home CSS and its tokens (area, TOD, `--sp-*`, `--float-*`), the Caveat font, `shared/pick.ts`, and `cancelArm()` in `App.tsx`.
- **Vault and workspace:** `config.vault`, `VaultPaths`, `/api/content`, `workspace.ts`, `workspace-routes.ts`, `frontmatter.ts`, the Obsidian links in tool cards and the nav bar. The probe's vault-read scenario is rewritten as `read-dir`, not removed.
- **Prompts and trace:** `lib/prompts/`, `lmstudio.ts`, the `@prompts` alias, `setGatewayConnection`, `trace-panel.tsx`.
- **Platform-only services and machines:** piper, embedding, searxng, openclaw-mcp, tts-mlx-audio, lm-studio, zotero-mcp, pdf-ocr; `services/tts/mlx-voxtral-swift`, `omnivoice`, `call-contracts`; the legacy `platform-control` and `platform-dashboard` units; the live `config.json` and `registry.json`.
- **Platform's branch flow:** the dev/main prompts in `deploy-source.sh` and `branch-status.sh`, the pre-commit refusal to commit on main, the Pi deploy hand-off in `post-merge`, and `session-start.sh`. Banter commits on main.
- **Structure kept for a future player:** `lib/media-voice-mode.ts`, `lib/media-engine.ts` and `components/media/transport-atoms.tsx` stay, unused, so chat files match platform's.

## OpenClaw support stays

Harness-agnostic means Banter can work with other harnesses, not that it drops OpenClaw. The OpenClaw tools are useful and stay, ported from platform like everything else:

- `plugins/voice-mode/`, the OpenClaw voice-mode plugin.
- `control/probe/`, the OpenClaw gateway probe, including `skill-test.ts` (not yet ported; see below).
- `dashboard/src/lib/gateway-types.ts`, OpenClaw's protocol types.

The agnostic work is adding seams so another harness can sit beside OpenClaw. A port should not spread OpenClaw assumptions into shared code that doesn't need them. Two places where shared code names OpenClaw, worth revisiting when a second harness arrives:

- `scripts/deploy-preserve-config.sh` names `.integrations.openclaw.lastSessionByAgent`. The live-config port deletes the script. Its replacement, platform's `state.json`, is harness-neutral (`lastAgent`, `lastSessionByAgent`). The only OpenClaw name left is the one-time repair rule `moveRuntimeState` in `live-config/rules.ts`, which moves the old fields out of `integrations.openclaw`.
- "Voice chat platform for OpenClaw" in `dashboard/index.html`, `manifest.webmanifest` and `scripts/generate-api-docs.ts`.

[agent-backend-abstraction.md](agent-backend-abstraction.md) covers what a second backend costs.

## Banter is ahead: send to platform

Banter changes that platform lacks. They stay, and are offered back in [banter-ahead-of-platform.md](../analysis/banter-ahead-of-platform.md).

Platform took most of the earlier list in `fd9920e` and `ac32bcb`: the shard error snippets, `Shard.endpoint`, the registry messages, the API reference definitions, `test-setup.ts`, the `shard-dev.sh` trap, `deploy.conf`, node detection from the registry, the `paths.ts` shape, the fluid preflight, a fluid smoke test, dev-mode ports, and the install scripts' localhost and macOS guards. Where platform took an item in its own form, Banter takes platform's form (see [Banter is behind](#banter-is-behind-port-from-platform)). Still ahead:

- Scripts: per-name staging directories, so a control plane and a shard deployed from one Mac don't share one; the systemd unit rendered from a template, so an install at a non-default location gets a correct unit; `.build` pruned from the logs scan; `fluid-smoke.sh`'s roster, `/listen` and idle-unload checks, with `fluid-smoke-listen.ts`.
- Dashboard lint fixes: the `eslint.config.js` rules, `gateway-context.tsx` deriving the connection with `useMemo`, the `use-session-manager.ts` effect dependencies, `use-wake-lock.ts`'s targeted exemption, `services/page.tsx` depending on `[load]`, and `service-history.tsx` deriving its loading state. Platform's dashboard lint run reports 26 errors that these clear.
- `CONTRIBUTING.md`: the testing table and the human-review list.
- Open-source files with no platform counterpart: `LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `.nvmrc`, `install.sh`, `render-plist.sh`, `dashboard/scripts/fetch-models.ts` and the `setup` script, the example registries and config, `services/README.md`, `services/fluid/README.md` and `DEVELOPING.md`.
- Harness-agnostic docs: `docs/gateway/dsh/` and `docs/gateway/opencode/`.

## Banter is behind: port from platform

Found by the audit against `ac32bcb`, in porting order. Nothing here is ported yet. Once these steps land, every remaining difference falls into a bucket in this register.

**1. Small, clean ports.** None depend on live config.

- **Idle loop stop waits for a pass in progress** (`a21c262`). Applies cleanly; skip `media-job.test.ts`.
- **Chat rebuilds streamed replies from the gateway's increments** (`5109503`): `ChatTextAssembler`, the model a fallback ran on, context usage refreshed after the run, and the composer's `name`/`aria-label`/`autocomplete`.
  - Applies with a three-way merge, except one hunk in `session-manager.ts` whose context names `persistLastAgent`.
  - The assembler handles both delta forms: increments in `deltaText` (gateway 2026.9.8) and the older cumulative `message`. So it holds for Banter users on other gateway versions.
  - The protocol notes go into `docs/gateway/openclaw/openclaw-gateway-protocol.md`.
- **Platform's form of items it took from Banter** (`fd9920e`, `ac32bcb`):
  - **Roster errors:** `fetchShardRoster` (`shard-client.ts:313`) gets the error snippet, with platform's test.
  - **Registry messages:** use `JSON.stringify` at every site, including `defaults.network.scheme`.
  - **API definitions:** take platform's `/api/config/reload` and `/api/voice/selection` definitions. Banter's are stale against its own handlers: reload documents `{ok, version}`, and voice selection lacks `modelPrefs`, `vad`, `turnTaking`, `takeover` and `saveMicSamples`. Regenerate the API reference.
  - **Scripts:** `SHARD_LABEL` defined once in `deploy-env.sh`; `fluid-build.sh`'s `sw_vers` fallback and Xcode hint; `fluid-smoke.sh`'s `remove_own`, platform-skip and `/var/tmp` safeguards; the control install failing loudly when the registry is missing.
- **Ports written once, in `network.port`** (`f49f429`).
  - Platform's registry now refuses a port in `runner.main` and a `PORT` in `ops.env.variables`, and gives any service with a port an endpoint. Banter only warns.
  - The example registries move to `{port}`, and `service-control.sh` passes `PORT`.
  - Check Banter-only `endpoint-derivation.test.ts` against platform's tests.
- **NeuTTS-Air.** `server.py` passes `max_context=2048`, which upstream `neutts` accepts only with platform's `neutts-max-context.patch`. Banter has neither the patch nor the README, so the Linux adapter fails as shipped. Port both, plus `services/tts/kokoro/README.md`.

**2. Live config (`de44bd6`, `bdeef42`, `b4d13ea`, SEN-139).** This is a pass of its own. Platform's `b4d13ea` moved the live files to the top of the deployment folder, which is where Banter decided they belong (see [Decided](#decided)), so Banter takes the layout as platform has it.

- **What platform built.**
  - Each node keeps `config.json`, `registry.json`, `shipped/` and `state/state.json` at the top of its deployment folder. A deploy replaces only the code folders it names (`control/`, `dashboard/`, `shared/`, `ops/`, `scripts/`), so it never touches them. `*_LIVE_DIR` defaults to the deployment folder.
  - Every load syncs each file to a Zod schema, with defaults and repair rules.
  - Saves change one field on disk.
  - Runtime state (`lastAgent`, `lastSessionByAgent`) leaves `config.json`.
  - A deploy three-way merges the last-shipped, live and repo copies, and stops on a conflict.
- **Taken as platform has it.** None of this depends on where the files sit.
  - `live-config/{sync,merge,rules}.ts` and their tests, with the schemas stripped (below).
  - The startup exit on invalid config: Banter's `index.ts:22` swallows it.
  - Single-field saves, and the `state.json` split with the `lastAgent` rename (below).
  - `{port}` and `{registry}` in `runner.main`.
  - `sync-templates.ts` and the pre-commit sync, run against Banter's example files.
  - The probe's shared token loader (`2a893cf`), pointed at the deployed config, which is where Banter's probe already reads it.
- **Also taken as platform has it**, now that the files sit in the deployment folder:
  - The deploy merge: `live-config/deploy.ts`, `deploy-config.ts` and their tests. The repo side is Banter's example files, so an untouched placeholder never conflicts. The merge replaces `deploy-preserve-config.sh`, its compare-and-prompt and `--reset-config`.
  - `paths.ts`, `paths.test.ts`, `platform_detect_node` and the `*_LIVE_DIR` defaults.
  - The shard registry moves from `~/services/shard/registry.json` to the top of the shard's folder, and `shard-registry.sh` and `shardRoot` go.
  - The first-deploy seeding from the old locations: Banter's old locations are `control/control-plane/data/` and `~/services/shard/`.
  - Whether `history.ts`'s git-backed history comes over is a separate choice, later.
- **One Banter case platform doesn't have: one Mac running both nodes.** `BANTER_PROD` and `BANTER_SHARD_PROD` both default to `~/services/banter` (`deploy-env.sh:34,43`). With live files at the top of the folder, the plane's `registry.json` and the shard's would be the same file, and so would `shipped/registry.json`. Platform's nodes are separate machines, so it never meets this. Recommended fix: the shard defaults to its own folder, `~/services/banter-shard`, which is what platform's per-node folders amount to. This needs Arvind's call, since it also moves the shard's code.
  - **`deploy.conf`.** It can't live inside the deployed folder, because it says where that folder is (`BANTER_PROD`). It stays in the checkout's `scripts/`, and the deploy copies it into `$PROD/scripts/`. That fixes a Banter bug: a deploy deletes `$PROD/scripts` and recopies it from the git stage, which lacks the untracked `deploy.conf`, so the deployed scripts that systemd runs fall back to defaults. Platform's `~/.config/platform/deploy.conf` stays out. `deploy-env.test.ts` comes over for precedence and the default-unit refusal, without its live-directory case.
- **Stripped.**
  - The schema's `mediaGeneration`, `vault` and `content` blocks, and the media slot and voice fields.
  - `extraOrigins` (`schemas.ts:262`, `registry.ts:124`) and `defaultScheme`'s https default. These are Decided; hunk-merge `registry.ts`, never overwrite it.
  - The shard's job log and results in `state/`.
  - The Pi/Mac sections of the docs, and the Mac's `~/Services` capital, since Banter's folders are lowercase.
- **Renamed.** `PLATFORM_*` becomes `BANTER_*`.
- **One commit for the rename.** `PATCH /api/gateway/defaultAgent` becomes `lastAgent`. The plane and dashboard change together:
  - `gateway-config.ts`
  - `routes.ts`
  - `session-manager.ts`
  - `use-session-manager.ts`, keeping Banter's hoisted effect dependencies
  - the example config and `docs/configuration.md`
  - the regenerated API reference
- **Human review.** The deploy and config scripts, and the probe's reading of `.env.secrets` and its narrower gateway scopes, are on CONTRIBUTING's human-review list.
- **Dependencies.** None new: Zod `4.3.6` is already pinned.

**3. Docs.** `docs/` was never audited before. Twelve Banter files cite `components/voice-turn-taking.md` alone, and others cite `voice-system.md`, `model-roster.md`, `service-install.md` and `control-shard.md`; Banter has none of these. Platform keeps its docs at paths its code and tests cite, so Banter takes platform's layout.

- **Port.** Banter's code cites these docs:
  - `components/voice-turn-taking.md`, `components/stt.md` and `components/tts.md`.
  - `design/`: `voice-system.md`, `turn-taking.md`, `voice-floor.md`, `voice-loop-streaming-stt.md`, `voice-speech-output.md`, `voice-tone-crackle.md`, `fluid-server-streaming-and-structure.md`, `fluidserver-model-lifecycle.md`, `lifecycle-executor.md`, `config-reload.md`, `service-install.md` and `live-config.md`.
  - `services/fluid/STT.md`, and platform's `openclaw/tool-call-handling.md`.
  - Move `dev/design/model-roster.md`, `fluid-server-app-identity.md` and `fluid-stt-on-demand-load.md` to `docs/design/`, as platform did (`0b16270`), taking platform's trimmed text: it drops the one-off migration and production-edit steps.
  - Take platform's live-path wording in `control-plane-api.md`, `control-shard.md` and `registry.md` (`2bab179`).
- **Strip and port.**
  - `pages/voice-interface.md`, without Home and media.
  - `components/dashboard.md`, `dashboard-views.md` and `components/index.md`.
  - `OPERATIONS.md`, without the Pi, NAS and personal machines.
  - `control-shard.md`, replacing `docs/architecture/control-shard.md`.
- **Refresh.**
  - `docs/architecture/voice-pipeline.md` describes `useVoiceLoop`, `useMicLoop`, `LlmStore` and an arbiter, none of which exist; `README.md:345` still cites the arbiter. Replace it with the voice docs above.
  - `control-plane-api.md`, against platform's `8b11f21`.
  - The OpenClaw protocol notes, against platform's 2026.8.1 recheck.
  - Reconcile `gateway-tool-and-message-events.md`: Banter's is 496 lines, platform's 285.
- **Stay out.** Media, home, prompts, the vault template, `orchestrator-adoption.md`, and platform's personal docs: `environments`, `infrastructure`, `setup-macbook`, `setup-pi`, `requirements`, `principles`, `roadmap` and `information-architecture`. The sitemap footer stays out with Home.

**Lint.** `turn-manager.ts` (two `prefer-const` errors) and `media-engine.ts` (an unused exemption) are byte-identical to platform, which has the same findings. The fix would start in Banter and be offered back.

### Ported on 2026-10-31

| Platform change | Banter commit |
|---|---|
| Off health state (`c5137cc`) | `4e1ddcb` |
| Registry write-back and registry tests (`2b5b76b`, `f8995ef`) | `a5bbccf` |
| Shard memory check and duplicate routes dropped; control test rewrites (`3890c88`, `eb41eaf`, `210393d`, `8b11f21`, `76a2b87`) | `ce5674a` |
| Relative event-log path (`02dbb1d`) | `3e03a98` |
| Mic samples in the temp directory (`4540ca1`) | `dde08d3` |
| Roster schema and design record | `2724ed5` |
| Probe skill test | `8f5ca6b` |
| Unused `Shard.tailscaleServe` dropped | `cdaf8a2` |
| Services page (`09683de`, `0b0333e`, `47f0217`, `f9fc475`) | `8eb9219` |
| Phosphor icons (`8c9a726`) | `a0fefd8` |
| Per-part config reload (`7377b62`) | `bf8a220` |
| Toast close button | `7beef90` |
| Dashboard test rewrites and chat.md sections (`3a6558a`, `2e77149`, `8003a74`) | `6ecf503` |
| PNG app icons, Banter's own art | `55ee45e` |
| Deploys keep voice choices; bash 3.2 (`dadf3c8`, `b53213c`) | `41f170b` |
| Homebrew tools on managed services' PATH (`8809009`) | `e1a79c3` |
| Staging under `/var/tmp` (`bf3a0c3`) | `4ee7bd4` |
| API reference from a pre-commit hook, not the deploy (`b98d076`) | `33974d0` |
| Installs take only what `ops.install` declares (`1c3f19e`) | `260eb99` |
| Shard deploy and dev API-only, `xcrun swiftc` (`d033d09`) | `45de02f` |
| Preflight sibling-directory fix | `ce45495` |
| `probes/browser-audio` | `3c7e68a` |
| FluidAudio pin and tokenizer path (`2f7ef71`, `d880707`) | c527af9 |

## Banter bugs found in audit

Both fixed on 2026-10-31:

- **The shard install could silently skip** (`11f01b7`). It read a registry a staged deploy doesn't have; `scripts/shard-registry.sh` now resolves the registry the way the shard does, and the install fails clearly when there is none.
- **`BANTER_SHARD_HOST`** was not a stray knob: with Banter's http default, a shard on a second machine reached over a LAN without Tailscale must listen beyond loopback. Its comment and `docs/shard-setup.md` now say so (`cdaf8a2`).

## Open decisions

Each needs Arvind's call. Until then Banter keeps its current position.

1. **Naming.** `BANTER_` env prefixes, `com.banter` bundle and plist IDs, "Banter" in titles and device labels, and generic host and person names in tests, examples and comments (`gpu-machine`, `home-server`, `example`, `alex`). Some platform names remain (`@platform/shared`, the `platform_find_jq` helpers, `PLATFORM_DIR` in `shard-runner.swift`).
2. **Styling.** Banter's neutral palette, `--radius` 0.75rem, 15px chat type, the neutral user bubble, `.chat-ambient-wash`, the glow overlay colours, and the Banter logo and favicon. UI icons follow platform (item 8 above).
3. **Where the control port and shard registry live.** Decided on 2026-11-01 (see [Decided](#decided)). Kept here so the numbering others cite still holds.
4. **Exact dependency pins** in Banter's `package.json` files, against platform's caret ranges.


## Decided

- **Config, registry and state stay inside the deployed folder, on both nodes** (2026-11-01). Banter doesn't want a second set of config files outside the install. Platform's `bdeef42` had put them in a sibling directory; its `b4d13ea` brought them back to the top of the deployment folder, so Banter and platform agree. The shard registry moves into the shard's folder from `~/services/shard/`. `deploy.conf`, which names the folder, stays in the checkout, and a deploy copies it in. The control port is unchanged: scripts read it from the registry's `control` entry, as platform's now do, and `BANTER_CONTROL_PORT` overrides it, as `CONTROL_PORT` does on platform.

- **Banter keeps http as its default scheme, and does not take platform's origin rule** (2026-10-31). Platform defaults to https except on loopback, because it assumes a tailnet, and its SEN-143 work (`5e5fb7d`, `811bb28`, `dbeb9ee`) builds on that: browsers reach Mac services through the shard's `/svc/<id>/` route (`forward.ts`), every route refuses a page that isn't https unless the registry's `extraOrigins` lists it (`origin.ts`), and the speech servers bind loopback with no CORS lists. Banter keeps http so a LAN or plain-IP install works without Tailscale, and documents why https is safer and how Tailscale provides it. `forward.ts`, `origin.ts`, `extraOrigins`, the `/svc/` endpoint rewrite, whisper's loopback bind and the matching test cases stay out.
- **The PyTorch Kokoro and NeuTTS-Air adapters stay, for Linux** (2026-10-31). Platform retired both (`88b59dd`) because Kokoro runs on `fluid-tts` on a Mac; Banter keeps them as the Linux options.
- **`probes/browser-audio` comes over, documented for anyone debugging speaker crackle while the microphone is open** (2026-10-31).
- **UI icons follow platform** (Phosphor, `8c9a726`).
- **OpenClaw tools stay** (see above).
