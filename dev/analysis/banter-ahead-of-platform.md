# Where Banter is ahead of platform

Changes in Banter (`~/Code/banter`) that platform (`~/Code/airavatha/sutradhara/platform`) does not have, for platform to assess and take or decline. Each item names the Banter files to read and, where one exists, platform's counterpart. Paths are relative to each repo's root.

Rechecked against platform `dev` at `ac32bcb` on 2026-10-31. The full register of differences is [dev/design/platform-divergence.md](../design/platform-divergence.md).

Most of these exist because Banter has to run on setups platform doesn't: one Mac running both nodes, Linux, an install somewhere other than the default, and users who aren't Arvind.

## Already taken

Platform took these in `fd9920e` and `ac32bcb`. Where platform's form differs, Banter is moving to platform's form. They are not offered again.

- Shard error snippets. Platform also covers the roster read, which Banter is taking back.
- `Shard.endpoint` required.
- Registry messages naming the bad value.
- The API reference definitions for the five undocumented endpoints.
- `dashboard/src/test-setup.ts` for Node 26.
- The `shard-dev.sh` restore trap.
- `deploy.conf`. Platform reads it from `~/.config/platform/`; Banter keeps it in the checkout and copies it into the deployed folder.
- Node detection from the registry.
- The testable `paths.ts`.
- The fluid build preflight.
- A fluid smoke test.
- Dev-mode port overrides and `lsof`/`curl` fallbacks.
- The install scripts targeting localhost and guarding `systemctl`.

`shard-registry.sh` is no longer offered. Platform defines the shard registry's path once in `deploy-env.sh`, which solves the same problem. Banter is moving its shard registry into the deployed folder; platform keeps its own in a live directory beside it.

## Scripts

### Per-name staging

- **Banter:** `platform_stage_dir` in `scripts/deploy-env.sh` takes an optional name, and `scripts/shard-deploy.sh` stages under `<unit>-shard`, so a control plane and a shard deployed from one Mac don't share a staging tree.
- **Platform:** `platform_stage_dir` (`deploy-env.sh:92-97`) takes no name.

### Systemd unit from a template

- **Banter:** `scripts/control-install-services.sh` renders `ops/systemd/banter.service.template` with `__PROD__` and `__UNIT__`, so an install at a non-default location gets a correct unit.
- **Platform:** copies `ops/systemd/$PLATFORM_UNIT.service` from the repo (`control-install-services.sh:49-55`). Only `platform.service` exists, and it hard-codes `%h/services/platform`. `deploy-env.sh` requires a non-default unit name for a non-default `PLATFORM_PROD`, so that install fails with "no unit to run from" unless someone hand-writes a unit file.

### `.build` pruned from the logs scan

- **Banter:** `control-install-services.sh` prunes `.build` from its `find`, so Swift build trees aren't scanned.
- **Platform:** `control-install-services.sh:100-106` has no prune.

### Fluid smoke test: wider checks

- **Banter:** `scripts/fluid-smoke.sh` also checks the roster default, Deepgram `/listen` (socket refusal, pause, `CloseStream`) and a short idle unload, using `scripts/fluid-smoke-listen.ts`.
- **Platform:** `fluid-smoke.sh` tests STT identity, `/healthz`, one transcription and unload.

## Dashboard lint

Platform's dashboard lint run (`npx eslint src`) reports 26 errors. These Banter changes clear them:

- **`dashboard/eslint.config.js`:** unused variables may start with `_` (11 of the errors), and `react-refresh/only-export-components` is off for `src/components/ui/**`, where shadcn files export helpers beside components (5 of the errors, in `badge`, `button`, `tabs` and `toggle`, plus `gateway-context.tsx`).
- **`dashboard/src/lib/gateway-context.tsx`** derives the connection with `useMemo`, not state set in an effect. Platform's `:48` and `:57` are flagged. Platform would need to move its `setGatewayConnection` call (prompts) into an effect.
- **`dashboard/src/lib/use-session-manager.ts`:** the effect depends on unpacked fields such as `hasConfig`, not `config?.x` expressions. Platform's `:92` is flagged.
- **`dashboard/src/lib/use-wake-lock.ts`** has a targeted exemption for one intended state update in an effect. Platform's `:53` is flagged.
- **`dashboard/src/features/services/page.tsx`** depends on `[load]`, not `[]`. Platform's `:48` is flagged.
- **`dashboard/src/features/services/service-history.tsx`** derives its loading state from the result, not `setLoading(true)` in the effect.

## Process

- **`CONTRIBUTING.md`:**
  - "Testing" is a table of which command covers which area. A change those commands cover can be committed on a green run.
  - "Changes that need human review" lists what no test clears: live state, exposure and access, downloads and credentials, what only a person can judge, results that don't add up, and changes a revert can't undo.
- Platform's `CONTRIBUTING.md` covers roles and branching only. If platform takes these sections, the human-review list should include the rule that UI and features tested in platform need no re-test when ported to Banter.

## Not included

Banter's open-source-only files (`LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `install.sh`, `render-plist.sh`), its generic naming, and its harness docs for dsh and opencode have no use in platform. Exact dependency pins are an open decision in the register, not a recommendation.
