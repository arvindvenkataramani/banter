# fluid-stt and fluid-tts as identified macOS applications

## What it is

`fluid-stt` and `fluid-tts` are plain Swift Package Manager executables, ad-hoc signed, with no Info.plist. macOS therefore identifies each by its file name, and every per-application location the system derives follows that name. CoreML's runtime cache is the visible case: it lives at `~/Library/Caches/<identity>/com.apple.e5rt.e5bundlecache/`, so each rename of the binaries (`fluidserver`, `fluid-server-stt`, `fluidttsserver`) started a new cache and orphaned the old one.

This change gives each server a bundle identifier and the standard application metadata, and routes every location the server owns through the system's per-application directories, keyed by that identifier. The identity then survives renames, moves and reinstalls, and each location is where a macOS user or tool expects to find it.

## Identity

Each server is an application bundle: `fluid-stt.app/Contents/MacOS/fluid-stt` beside `Contents/Info.plist`, and likewise for `fluid-tts`. Swift Package Manager builds the plain executables unchanged; `scripts/fluid-build.sh` then assembles each bundle around its executable, writes the Info.plist, and signs the bundle ad hoc, so the signature seals the plist. The shard runner launches the executable inside the bundle, and `Bundle.main` resolves the bundle's identifier at run time.

The plist carries `CFBundleIdentifier`, `CFBundleName`, `CFBundleExecutable`, `CFBundleShortVersionString` (the package version), `CFBundleVersion` (the source commit the build came from, which `SOURCE-COMMIT.txt` records today), `CFBundlePackageType` (`APPL`) and `LSMinimumSystemVersion` matching the package's platform floor. `LSBackgroundOnly` is set, since neither server has a user interface. The plists are template files in the package; the build script fills in the version fields when it writes each bundle's Info.plist, before signing.

`GET /healthz` reports the bundle identifier and both version fields beside what it reports now, so the platform can see which build is running without reading the install directory.

## Locations

Every location a server owns derives from its bundle identifier through `FileManager`'s standard directories. A server creates what it needs at startup and fails naming the path if it cannot.

**Caches:** `~/Library/Caches/<bundle id>/`. CoreML writes its runtime cache here without being told, which is the whole of what this directory holds. Nothing the server writes itself belongs here.

**Temporary files:** `<user temp directory>/<bundle id>/`. The batch STT upload and the TTS audio file go into the server's own subdirectory of the user temp directory, which the server empties at startup, so a crash leaves no anonymous files behind.

**Application Support:** `~/Library/Application Support/<bundle id>/`, for state the server owns and must keep across restarts. The servers hold none. Model weights are not server state and do not go here.

**Configuration:** the platform registry, passed with `--registry`, stays the only configuration. It is shared with the shard and owned by the platform, so it cannot move into a per-application location, and a second configuration source beside it would let the two disagree. The servers do not read `UserDefaults`.

**Logs:** stdout continues to reach the shard runner's log files under the install directory. Each server also logs through unified logging with its bundle identifier as the subsystem, so `log stream --predicate 'subsystem == "<bundle id>"'` and Console.app show it alongside the rest of the system.

## Verification

Tests cover what the code decides: that each location derives from the identifier, and that the temp directory is created and emptied at startup. The identity is checked on the built bundle, since it is a build product: `codesign --verify --strict` passes on the bundle, `codesign -dv` reports the bundle identifier and a bound Info.plist, `/healthz` reports the identifier and versions, and after a model load the CoreML cache appears under `~/Library/Caches/<bundle id>/`.

## Identifiers

`com.banter.fluid-stt` and `com.banter.fluid-tts`.

## Packaging

The bundle is the form every macOS mechanism fully recognises, and its Info.plist is an ordinary file written after the build. An Info.plist embedded in a bare executable through a linker flag is invisible to Swift Package Manager's dependency tracking, so a changed plist can go unlinked and a build can ship a stale identity or version; the bundle has no such path.

The shard registry's `fluid-stt` and `fluid-tts` entries install the bundle directory as their artifact (`scripts/install-artifacts.sh` already installs directories) and launch `fluid-stt.app/Contents/MacOS/fluid-stt` from the install directory.
