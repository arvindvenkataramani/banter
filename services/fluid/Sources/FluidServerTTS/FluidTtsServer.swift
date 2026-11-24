import FluidAudio
import FluidServerKit
import Foundation
import Hummingbird
import Logging

@main
struct FluidServerTTS {
    static func main() async throws {
        // Resolved before the logger, since the logger's os_log subsystem is
        // the bundle identifier.
        let identity = AppIdentity.resolve(
            info: Bundle.main.infoDictionary, executableName: "fluid-tts")
        let logger = bootstrapLogging(label: "fluid-tts", subsystem: identity.bundleIdentifier)
        let args: ServerArgs
        do {
            args = try ServerArgs.parse(defaultPort: 8769)
        } catch {
            logger.critical("\(error)")
            throw error
        }

        // The temp subdirectory is this server's own, wiped on every start so
        // a crash never leaves a previous run's reference-audio trim behind.
        let locations = AppLocations(identifier: identity.bundleIdentifier)
        do {
            try locations.prepareTemporaryDirectory()
        } catch {
            logger.critical("\(error)")
            throw error
        }

        // The roster is what this server offers, handed in rather than decided.
        // A missing or invalid one stops startup: serving nothing would be
        // indistinguishable from a healthy server whose models have all gone.
        let roster: TtsRoster
        let provisions: Provisions
        do {
            guard let path = args.registryPath, let provider = args.providerId else {
                throw TtsRosterError.missing
            }
            roster = try TtsRoster.load(registry: path, provider: provider)
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

        // No model resident at startup, as on the STT side: which one to hold
        // is the caller's choice and a guess costs seconds of loading.
        let resident = ResidentTtsModel(
            modelsDirectory: args.modelsDirectory, temporaryDirectory: locations.temporary,
            logger: logger)
        let ctx = TtsAppContext(
            resident: resident, roster: roster, logger: logger, identity: identity,
            provisions: provisions)

        let modelsPath = args.modelsDirectory?.path ?? "FluidAudio default"
        logger.info(
            "starting TTS server on \(args.host):\(args.port); no model loaded; models at \(modelsPath)"
        )

        // One port serves both transports: the benchmark and any file consumer
        // use the HTTP route, the voice loop upgrades to the socket. A second
        // port would be a second thing to register and expose for no gain.
        let app = Application(
            router: buildRouter(ctx: ctx),
            server: .http1WebSocketUpgrade(webSocketRouter: buildStreamRouter(ctx: ctx)),
            configuration: .init(
                address: .hostname(args.host, port: args.port),
                serverName: "fluid-tts"
            ),
            logger: logger
        )
        try await app.runService()
    }
}

struct TtsAppContext: Sendable {
    let resident: ResidentTtsModel
    /// What this server offers. Every route that names a model resolves it
    /// through here, so an id outside the roster is unknown however well the
    /// code could serve it.
    let roster: TtsRoster
    let logger: Logger
    let identity: AppIdentity
    /// What this server's registry entry declares it provides; routes read their defaults here.
    var provisions: Provisions = .none
}
