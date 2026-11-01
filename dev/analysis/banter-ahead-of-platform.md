# Where Banter is ahead of platform

Changes in Banter (`~/Code/banter`) that platform (`~/Code/airavatha/sutradhara/platform`) does not have, for platform to assess and take or decline. Each item names the Banter files to read and, where one exists, platform's counterpart.

Found by a file-by-file comparison on 2026-10-31, rechecked against platform `6703915`. The full register of differences is [dev/design/platform-divergence.md](../design/platform-divergence.md).

Most of these come from Banter having to run on setups platform doesn't: a single Mac running both nodes, Linux, an install somewhere other than the default, and users who aren't Arvind. Paths below are relative to each repo's root.

## Control plane and shard

### Shard errors say what went wrong

- **Banter:** `control/control-plane/src/shard-client.ts`
  - `readBodyPrefix` (line 18) reads at most 200 bytes of an error response.
  - `sanitizeForLog` (line 50) strips control characters so a remote body cannot forge log lines.
  - `shardResponseError` (line 57) builds the error from the status and that snippet.
  - When the body matches `HTTPS_TO_HTTP_HINT` (line 13), the error says to set `scheme: https` on the registry entry.
- **Platform:** `control/control-plane/src/shard-client.ts` throws `Shard returned ${res.status}` at lines 19, 34 and 54, which says nothing about the cause.
- **Tests:** `control/test/shard-client-errors.test.ts`.
- **Note:** the https hint matters most where the default scheme is http, which Banter uses and platform doesn't (an open decision in the register). The bounded, sanitised snippet is useful either way.

### Registry error messages

- **Banter:** `control/shared/src/registry.ts` error messages include the bad value, for example `network.scheme must be "http" or "https", got "ftp"` (lines 272, 317, 396). Platform's messages stop at "must be".
- Two earlier claims here are withdrawn after platform's `2b5b76b` and `f8995ef`. Platform now validates the whole file on every patch, so Banter's endpoint re-derivation on patch is unnecessary. The `--port` check behaves the same in both, since only process runners have `main`.

### The API reference documents five more endpoints

- **Banter:** `control/control-plane/src/routes.ts` (lines 396–526) defines OpenAPI routes for `PATCH /api/gateway/defaultAgent`, `PATCH /api/gateway/lastSession`, `PATCH /api/voice/selection`, `POST /api/config/reload` and `POST /api/debug/mic-sample`. Nothing registers them at runtime (the handlers live in `gateway-config.ts`, as on platform), but `scripts/generate-api-docs.ts` registers every exported route, so `docs/api-reference.md` documents those endpoints.
- **Platform:** has the same handlers and no definitions, so its API reference omits them.

### `Shard.endpoint` is required

- **Banter:** `shared/types.ts` line 122 declares `endpoint: string`; the loader always derives it.
- **Platform:** declares it optional, which leaves `control-plane/src/app.ts` (the `/api/shards` handler) and `shard-poller.ts` (lines 54–56) passing `string | undefined` where a string is required: four type errors when Banter tried platform's form.

### Shard paths in one testable file

- **Banter:** `control/control-shard/src/paths.ts`.
  - `shardRoot` (line 30) prefers lowercase `~/services` and falls back to `~/Services` only when that alone exists. The two are different directories on a case-sensitive disk.
  - `resolveShardPaths` (line 83) returns the registry path, event-log path, port and idle interval from the environment and home directory. Startup decisions can be tested without starting a server.
  - `positiveInt` (line 62) throws, naming the setting, when a value isn't a positive integer.
- **Platform:** the same decisions sit inline in `control/control-shard/src/index.ts`, with `~/Services/platform/...` defaults (line 23).
- **Note:** Banter also keeps the shard registry outside the deployed tree, so a deploy can't overwrite it. Platform keeps it in `data/registry.json`. That is an open decision, separate from the file itself.

## Scripts

### `deploy.conf`

- **Banter:** `scripts/deploy-env.sh` (lines 6–19) reads an optional `scripts/deploy.conf`, with the precedence environment, then `deploy.conf`, then defaults. `scripts/deploy.conf.example` documents it. Install location and unit name are set once, not per command.
- The same file refuses a non-default install location paired with the default unit name, which would leave the unit running the wrong tree.

### Finding which node a machine is

- **Banter:** `scripts/service-control.sh` (lines 16–33) looks for a deployed control-plane or shard registry, or uses `BANTER_REGISTRY_PATH` or `BANTER_SHARD_REGISTRY_PATH`.
- **Platform:** `scripts/service-control.sh` line 18 infers the node from `uname`: Linux means the control plane, Darwin means the shard. That is wrong for a Linux shard or a Mac running the control plane.

### Fluid build preflight

- **Banter:** `scripts/fluid-build.sh` (lines 16–53) checks before building:
  - Apple Silicon.
  - macOS 15 or later.
  - A Swift 6 toolchain.
  - Homebrew and libopus.
- Each failure says what is missing and how to install it, so a missing dependency stops the build before it starts, not halfway through.
- **Platform:** has none of these checks.

### Fluid smoke test

- **Banter:** `scripts/fluid-smoke.sh` and `scripts/fluid-smoke-listen.ts` build the fluid servers, deploy them into a scratch folder under a throwaway bundle identifier, check transcription, speech and Deepgram `/listen`, and remove everything on exit. A running server is never touched.
- **Platform:** has no equivalent.

### Dev mode

- **Banter:** `scripts/control-dev.sh`.
  - Line 85 points dev at the live registry as well as the live config. In platform, dev reads the repo's registry with the deployed config, so dev and production can disagree about which services exist.
  - Lines 13–14 make `VITE_PORT` and `BANTER_DEV_CONTROL_PORT` overridable.
  - Lines 36–42 skip the stale-listener cleanup when `lsof` is missing.
  - Line 91 checks that Vite is up with `curl`, not `ss`, which macOS lacks.

### Installing the control plane

- **Banter:** `scripts/control-install-services.sh`.
  - Lines 49–52 render `ops/systemd/banter.service.template` with `__PROD__` and `__UNIT__`, so a non-default install location gets a correct unit.
  - Line 101 calls `install_service_artifacts` against `localhost` and the port read from the registry, not a fixed Tailscale URL.
  - Line 87 runs `systemctl daemon-reload` only where systemd exists, so the script also runs on macOS.
- `scripts/shard-install-services.sh` likewise targets the shard's own `localhost` port.

### Scripts read the registry the shard reads

- **Banter:** `scripts/shard-registry.sh` resolves the shard's live registry the same way `control/control-shard/src/paths.ts` does: `BANTER_SHARD_REGISTRY_PATH`, then `BANTER_SHARD_ROOT`, then `~/services`, falling back to an existing `~/Services`. `shard-install-services.sh` and `service-control.sh` source it, and the install fails with a clear message when no registry is found.
- **Why:** a script reading a different file from the shard is how Banter's shard install came to skip its plist and artifact steps silently. It read the repo's untracked copy, which a stage extracted from git doesn't have.
- **Platform:** keeps the shard registry inside the deployed tree, so its scripts and shard already agree. This item matters to platform only if it moves the registry out of the tree (an open decision on the Banter side).

### Staging and dev cleanup

- **Banter:** `platform_stage_dir` in `scripts/deploy-env.sh` (line 64) takes an optional name, and the shard deploy stages under `<unit>-shard`, so a control plane and a shard deployed from one Mac don't share a staging tree. Platform's helper takes no name.
- **Banter:** `scripts/shard-dev.sh` (line 53) restores the production shard agent from one idempotent trap on EXIT, INT and TERM, so a dev run that fails to start doesn't leave production stopped.

## Dashboard

- **Lint rules:** `dashboard/eslint.config.js`. Line 26 lets unused variables start with `_`. Line 38 turns off `react-refresh/only-export-components` for `src/components/ui/**`, where shadcn files export helpers beside components.
- **`dashboard/src/lib/gateway-context.tsx`** (line 46) derives the connection with `useMemo`, not state set in an effect, which saves a render and satisfies the hooks lint rule.
- **`dashboard/src/lib/use-session-manager.ts`** (lines 87–92): the effect depends on unpacked fields such as `hasConfig`, not `config?.x` expressions, which the hooks lint rule rejects.
- **`dashboard/src/lib/use-wake-lock.ts`** (line 55): a targeted `eslint-disable` for one intended state update in an effect.
- **Tests on Node 26:** `dashboard/src/test-setup.ts`, loaded through `setupFiles` in `dashboard/vitest.config.ts` (line 12), provides an in-memory `localStorage`. It came in Banter's `dba271e`, which fixed the voice-loop suite. Worth checking whether platform's dashboard tests fail the same way on Node 26.

## Process

- **`CONTRIBUTING.md`** (Banter `d0d8331`, 2026-10-28):
  - "Testing" is a table of which command covers which area. A change those commands cover can be committed on a green run.
  - "Changes that need human review" lists what no test clears: live state, exposure and access, downloads and credentials, what only a person can judge, results that don't add up, and changes a revert can't undo.
- Platform's `CONTRIBUTING.md` covers roles and branching, not these. If platform takes them, the human-review list should include the rule that UI and features tested in platform need no re-test when ported to Banter.

## Not included

Open-source-only files (`LICENSE`, `NOTICE`, `SECURITY.md`, `.github/`, `install.sh`, the example registries) and Banter's generic naming have no use in platform. Exact dependency pins in Banter's `package.json` files are an open decision in the register, not a recommendation.
