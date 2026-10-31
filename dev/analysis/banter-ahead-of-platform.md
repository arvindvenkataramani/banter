# Where Banter is ahead of platform

Changes in Banter (`~/Code/banter`) that platform (`~/Code/airavatha/sutradhara/platform`) does not have, for platform to assess and take or decline. Each item names the Banter files to read and, where one exists, platform's counterpart.

Found by a file-by-file comparison on 2026-10-31 (Banter `5075d1f`, platform `bcead8b`). The full register of differences is [dev/design/platform-divergence.md](../design/platform-divergence.md).

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

### Registry validation and patching

All in `control/shared/src/registry.ts`.

- **The `--port` mismatch warning only checks process runners** (lines 253–261). It reads the flag with `/(?:^|\s)--port[=\s]+(\d+)/`, so `--port 8000` and `--port=8000` both match. Platform runs the check on any `runner.main` and matches only `--port[= ]`.
- **`updateService` derives the endpoint the way the loader does** (lines 398–406). It derives one only when the patch leaves a port, the runner isn't `managed`, and a hostname exists. Platform re-derives without the `managed` check, so a patch to a managed service can write an endpoint the next load replaces.
- **Error messages include the bad value**, for example `network.scheme must be "http" or "https", got "ftp"` (lines 289, 313, 390).
- **Tests:** `control/test/endpoint-derivation.test.ts`, plus four patch tests in `control/shared/test/registry.test.ts`. They cover `listenAddress` agreeing with the loader, scheme re-derivation agreeing with reload, an invalid scheme being rejected, and a managed runner getting no derived endpoint. Some of these expect http endpoints and would need platform's https default.
- **Interval tests:** `control/test/registry-reload.test.ts` has two tests for the `intervals-changed` warning. Platform's `b017383` added the warning without tests.

### Shard paths in one testable file

- **Banter:** `control/control-shard/src/paths.ts`.
  - `shardRoot` (line 30) prefers lowercase `~/services` and falls back to `~/Services` only when that alone exists. The two are different directories on a case-sensitive disk.
  - `resolveShardPaths` (line 83) returns the registry path, event-log path, port and idle interval from the environment and home directory. Startup decisions can be tested without starting a server.
  - `positiveInt` (line 62) throws, naming the setting, when a value isn't a positive integer.
- **Platform:** the same decisions sit inline in `control/control-shard/src/index.ts`, with `~/Services/platform/...` defaults (line 23).
- **Note:** Banter also keeps the shard registry outside the deployed tree, so a deploy can't overwrite it. Platform keeps it in `data/registry.json`. That is an open decision, separate from the file itself.

### Shard bind address

- **Banter:** `control/control-shard/src/index.ts` binds to `BANTER_SHARD_HOST`, defaulting to `localhost`.
- **Platform:** hardcodes `localhost`.

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

### Dev mode

- **Banter:** `scripts/control-dev.sh`.
  - Line 85 points dev at the live registry as well as the live config. In platform, dev reads the repo's registry with the deployed config, so dev and production can disagree about which services exist.
  - Lines 13–14 make `VITE_PORT` and `BANTER_DEV_CONTROL_PORT` overridable.
  - Lines 36–42 skip the stale-listener cleanup when `lsof` is missing.
  - Line 91 checks that Vite is up with `curl`, not `ss`, which macOS lacks.

### Installing the control plane

- **Banter:** `scripts/control-install-services.sh`.
  - Lines 48–51 render `ops/systemd/banter.service.template` with `__PROD__` and `__UNIT__`, so a non-default install location gets a correct unit.
  - Line 100 calls `install_service_artifacts` against `localhost` and the port read from the registry, not a fixed Tailscale URL.
  - Line 85 skips `systemctl daemon-reload` where there is no systemd, as on macOS.
- `scripts/shard-install-services.sh` likewise targets the shard's own `localhost` port.

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
