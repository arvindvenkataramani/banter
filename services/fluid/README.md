# services/fluid

`fluid-stt` and `fluid-tts`, the two Swift speech servers this repo builds and ships as the default in `registry.example.json`. See [`STT.md`](STT.md) for what the STT server does and how it's run; the TTS server shares the same package, kit, and roster-driven startup.

## Prerequisites

- **Apple Silicon.** `scripts/fluid-build.sh` refuses to build on anything else (`uname -m` must report `arm64`).
- **macOS 15 or later** — the package's platform floor (`Package.swift`), needed for the CoreML `MLState` buffers some TTS backends keep their decoder cache in.
- **A Swift 6 toolchain.** Install with `xcode-select --install` if `swift --version` doesn't report Swift 6 — this comes with Xcode 16.
- **libopus**, via Homebrew: `brew install opus`.

## Building

```bash
scripts/fluid-build.sh
```

Checks the above and fails fast, naming what's missing and how to install it, before running `swift build -c release --package-path services/fluid`. Output lands at `services/fluid/.build/release/fluid-stt` and `fluid-tts`.

FluidAudio is pinned to a fork, `arvindvenkataramani/FluidAudio`, not upstream — carrying three patches for Pocket-TTS that upstream doesn't have yet. `swift build` fetches it automatically per the `Package.swift` dependency pin; nothing extra to install. See [`patches/README.md`](patches/README.md) for what the patches fix and why the pin matters — a pin bump that drops them brings the defects back silently.

Installing the built binaries into a deployed tree is a separate step — `scripts/control-install-services.sh` (single machine) or `scripts/shard-install-services.sh` (a shard), both reading the `fluid-stt`/`fluid-tts` entries' `ops.install` from the registry.
