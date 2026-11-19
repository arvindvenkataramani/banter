# Scripts

Tools for developing Banter. The install, deploy and run scripts are in [../ops/](../ops/README.md). Every script here carries a header comment explaining what it does; this is the index of which one to reach for.

Nothing here is required to run Banter as an installed service.

## Development

| Script | What it does |
|---|---|
| `control-dev.sh` | Control plane on `$BANTER_DEV_CONTROL_PORT` (4201) and Vite with HMR on `$VITE_PORT` (5173), against the deployed folder's live `config.json` and `registry.json`, so new code is tried on real settings. Invoked by `bun run control-dev`. |
| `shard-dev.sh` | The shard alone, API-only, with `--watch`. Stops the production agent while it runs and restores it on exit. |
| `generate-api-docs.ts` | Regenerates [../docs/reference/api.md](../docs/reference/api.md) from the route definitions under `control/`. Invoked by `bun run docs`, and by the `pre-commit` hook on any commit that touches `control/`. |
| `branch-status.sh` | Reports whether the checkout is on the project's main line. Exit 0 on the main line, 1 off it, 2 when it cannot tell. Used by the deploy scripts in [../ops/](../ops/README.md) to decide whether to confirm before installing unreviewed work. |
| `git-hooks/` | The hooks every clone should run. `ops/install.sh` enables them in a git checkout; otherwise run `git config core.hooksPath scripts/git-hooks`. |

## Fluid speech servers (Apple Silicon)

The Swift servers in `services/fluid` are built and checked by scripts of their own. `ops/install.sh` and `ops/control-deploy.sh` do not build them. Their registry entries are in `services/fluid/registry.fluid.example.json`; see [services/fluid/README.md](../services/fluid/README.md#registering-them).

| Script | What it does |
|---|---|
| `fluid-build.sh` | Builds `fluid-stt.app` and `fluid-tts.app` from `services/fluid` after checking Apple Silicon, macOS 15 or later, a Swift 6 toolchain and `libopus`. Builds only; `ops/control-install-services.sh` or `ops/shard-install-services.sh` installs the result per each entry's `ops.install`. |
| `fluid-smoke.sh` | Checks `fluid-stt` as built, installed and running, against a throwaway deploy in a scratch directory under a throwaway bundle identifier, so it never touches a running server. Its registry comes from `services/fluid/registry.fluid.example.json`. `fluid-smoke-listen.ts` is its `/listen` check. |

