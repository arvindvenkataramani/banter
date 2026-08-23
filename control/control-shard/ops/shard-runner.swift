// shard-runner: supervisor process for the control shard.
// Manages tailscale serve for the shard's port (which now also serves the dashboard).
// Compiled and signed by shard-deploy.sh — do not run directly.
//
// Sequence:
//   1. Remove tailscale serve for the shard port (clears any stale binding)
//   2. Spawn the shard (bun run src/index.ts)
//   3. If it crashes, restart it
//   4. On SIGTERM/SIGINT: tear down tailscale serve, kill child, exit
//
// This binary is the sole ProgramArguments target in com.banter.control-shard.plist.
// It shows up in Activity Monitor / Login Items as "shard-runner".

import Foundation

// ── Registry ─────────────────────────────────────────────────────────────────

// Lowercase `services`, matching the shard's own resolution in src/paths.ts and
// the control plane's root. On a case-sensitive filesystem `~/Services` is a
// different directory. Outside the deployed tree deliberately — the deploy
// removes and rebuilds that tree, and the live registry is not tracked.
let registryPath = ProcessInfo.processInfo.environment["BANTER_SHARD_REGISTRY_PATH"]
    ?? "\(NSHomeDirectory())/services/shard/registry.json"

struct Registry: Decodable {
    let services: [Service]
    struct Service: Decodable {
        let id: String
        let network: Network
        struct Network: Decodable {
            let port: Int
            let tailscaleServe: Bool?
        }
    }
}

func loadRegistry() -> Registry {
    let url = URL(fileURLWithPath: registryPath)
    guard let data = try? Data(contentsOf: url) else {
        fatalError("[shard-runner] Cannot read registry at \(registryPath)")
    }
    guard let registry = try? JSONDecoder().decode(Registry.self, from: data) else {
        fatalError("[shard-runner] Cannot parse registry at \(registryPath)")
    }
    return registry
}

let registry = loadRegistry()

func servicePort(_ id: String) -> String {
    guard let svc = registry.services.first(where: { $0.id == id }) else {
        fatalError("[shard-runner] Service '\(id)' not found in registry")
    }
    return String(svc.network.port)
}

// ── Configuration ─────────────────────────────────────────────────────────────

let shardPort   = servicePort("control-shard")
let bunPath     = ProcessInfo.processInfo.environment["BUN_PATH"]       ?? "\(NSHomeDirectory())/.bun/bin/bun"
let platformDir = ProcessInfo.processInfo.environment["PLATFORM_DIR"]   ?? "\(NSHomeDirectory())/services/banter"

let shardDir    = "\(platformDir)/control/control-shard"
let dashDist    = "\(platformDir)/dashboard/dist"

// ── Helpers ───────────────────────────────────────────────────────────────────

@discardableResult
func run(_ args: [String]) -> Int32 {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: args[0])
    proc.arguments = Array(args.dropFirst())
    try? proc.run()
    proc.waitUntilExit()
    return proc.terminationStatus
}

func teardownServe() {
    run(["/usr/local/bin/tailscale", "serve", "--bg", "--https=\(shardPort)", "off"])
}

func setupServe() {
    run(["/usr/local/bin/tailscale", "serve", "--bg", "--https=\(shardPort)", "localhost:\(shardPort)"])
}

func makeProcess(executable: String, arguments: [String], directory: String, env: [String: String] = [:]) -> Process {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: executable)
    proc.arguments = arguments
    proc.currentDirectoryURL = URL(fileURLWithPath: directory)
    var environment = ProcessInfo.processInfo.environment
    for (key, value) in env { environment[key] = value }
    proc.environment = environment
    return proc
}

// ── State ─────────────────────────────────────────────────────────────────────

var shardProc: Process?
var shuttingDown = false

func spawnShard() {
    let proc = makeProcess(
        executable: bunPath,
        arguments: ["run", "src/index.ts"],
        directory: shardDir,
        env: ["DASHBOARD_DIST": dashDist]
    )
    proc.terminationHandler = { p in
        guard !shuttingDown else { return }
        print("[shard-runner] shard exited (\(p.terminationStatus)), restarting in 2s...")
        Thread.sleep(forTimeInterval: 2)
        spawnShard()
    }
    try! proc.run()
    shardProc = proc
    print("[shard-runner] shard started (pid \(proc.processIdentifier))")
}

func shutdown() {
    shuttingDown = true
    print("[shard-runner] Shutting down...")
    shardProc?.terminate()
    shardProc?.waitUntilExit()
    teardownServe()
    print("[shard-runner] Done.")
    exit(0)
}

// ── Signal handling ───────────────────────────────────────────────────────────

let sigSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigSrc.setEventHandler { shutdown() }
sigSrc.resume()

let intSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSrc.setEventHandler { shutdown() }
intSrc.resume()

signal(SIGTERM, SIG_IGN)
signal(SIGINT,  SIG_IGN)

// ── Startup ───────────────────────────────────────────────────────────────────

print("[shard-runner] Clearing tailscale serve on port \(shardPort)...")
teardownServe()

print("[shard-runner] Starting shard...")
spawnShard()

print("[shard-runner] Setting up tailscale serve on port \(shardPort)...")
setupServe()

dispatchMain()
