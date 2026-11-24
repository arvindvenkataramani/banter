import FluidAudio
import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging

@main
struct FluidServerSTT {
    static func main() async throws {
        // Resolved before the logger, since the logger's os_log subsystem is
        // the bundle identifier.
        let identity = AppIdentity.resolve(
            info: Bundle.main.infoDictionary, executableName: "fluid-stt")
        let logger = bootstrapLogging(label: "fluid-stt", subsystem: identity.bundleIdentifier)
        let args: ServerArgs
        do {
            args = try ServerArgs.parse(defaultPort: 8767)
        } catch {
            logger.critical("\(error)")
            throw error
        }

        // The temp subdirectory is this server's own, wiped on every start so
        // a crash never leaves a previous run's upload behind.
        let locations = AppLocations(identifier: identity.bundleIdentifier)
        do {
            try locations.prepareTemporaryDirectory()
        } catch {
            logger.critical("\(error)")
            throw error
        }

        // The roster is what this server offers. It is handed one rather than
        // deciding: which models exist is a fact about the installation, and a
        // server that enumerated would advertise whatever the code could build
        // regardless of what was fetched.
        //
        // A missing or invalid roster stops startup. Serving nothing would be
        // indistinguishable from a healthy server whose models have all gone,
        // and that ambiguity is the whole defect this replaces.
        let roster: Roster
        let provisions: Provisions
        do {
            guard let path = args.registryPath, let provider = args.providerId else {
                throw RosterError.missing
            }
            roster = try Roster.load(registry: path, provider: provider)
            logger.info(
                "roster \(path.path) [\(provider)]: \(roster.models.map(\.id).joined(separator: ", "))"
            )
            // An entry claiming more than this build serves stops startup.
            provisions = try Provisions.load(registry: path, provider: provider)
            logger.info("provides: \(provisions.declared.map(\.api).joined(separator: ", "))")
        } catch {
            logger.critical("\(error)")
            throw error
        }

        // No model is resident at startup: the first request that needs one
        // loads it, so nothing pays thirteen seconds for weights nobody wants.
        let resident = ResidentModel(roster: roster, logger: logger)
        let ctx = AppContext(
            resident: resident, logger: logger, identity: identity,
            temporaryDirectory: locations.temporary, provisions: provisions)

        if roster.idleUnloadRejected != nil {
            logger.warning(
                "roster idleUnloadMs is not a positive integer of milliseconds; using \(Roster.defaultIdleUnload)")
        }
        let idle = roster.idleUnload
        // Checked a few times per interval, between once a second and once a minute.
        let tick = max(min(idle / 4, .seconds(60)), .seconds(1))
        Task.detached {
            while !Task.isCancelled {
                try? await Task.sleep(for: tick)
                _ = await resident.unloadIfIdle(after: idle)
            }
        }

        logger.info(
            "starting HTTP server on \(args.host):\(args.port); no model loaded, idle unload after \(idle)")

        let app = Application(
            router: buildRouter(ctx: ctx),
            server: .http1WebSocketUpgrade(webSocketRouter: buildStreamRouter(ctx: ctx)),
            configuration: .init(
                address: .hostname(args.host, port: args.port),
                serverName: "fluid-stt"
            ),
            logger: logger
        )

        try await app.runService()
    }
}

struct AppContext: Sendable {
    let resident: ResidentModel
    let logger: Logger
    let identity: AppIdentity
    /// Where this server's own temp files go — the upload in
    /// `handleTranscribe`, not FluidAudio's model cache.
    let temporaryDirectory: URL
    /// What this server's registry entry declares it provides; routes read their defaults here.
    var provisions: Provisions = .none
}
