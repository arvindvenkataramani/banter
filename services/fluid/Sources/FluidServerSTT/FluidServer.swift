import FluidAudio
import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging

@main
struct FluidServerSTT {
    static func main() async throws {
        let logger = bootstrapLogging(label: "fluid-stt")
        let args: ServerArgs
        do {
            args = try ServerArgs.parse(defaultPort: 8767)
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
        do {
            guard let path = args.registryPath, let provider = args.providerId else {
                throw RosterError.missing
            }
            roster = try Roster.load(registry: path, provider: provider)
            logger.info(
                "roster \(path.path) [\(provider)]: \(roster.models.map(\.id).joined(separator: ", "))"
            )
        } catch {
            logger.critical("\(error)")
            throw error
        }

        // No model is resident at startup. Which one to hold is the caller's
        // choice, made through /v1/models/load, and a server that guessed would
        // spend thirteen seconds loading weights nobody asked for.
        let resident = ResidentModel(roster: roster, logger: logger)
        let ctx = AppContext(resident: resident, logger: logger)

        logger.info("starting HTTP server on \(args.host):\(args.port); no model loaded")

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
}
