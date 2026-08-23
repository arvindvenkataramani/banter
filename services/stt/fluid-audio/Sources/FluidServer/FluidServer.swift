import FluidAudio
import Foundation
import Hummingbird
import Logging

@main
struct FluidServer {
    static func main() async throws {
        let args = parseArgs()

        LoggingSystem.bootstrap { label in
            var handler = StreamLogHandler.standardOutput(label: label)
            handler.logLevel = .info
            return handler
        }
        let logger = Logger(label: "fluidserver")

        logger.info("loading model version \(args.modelVersion)")
        let asrVersion = try modelVersionFromString(args.modelVersion)
        let models = try await AsrModels.downloadAndLoad(version: asrVersion)

        let tdtConfig = TdtConfig(blankId: asrVersion.blankId)
        let asrConfig = ASRConfig(
            tdtConfig: tdtConfig,
            encoderHiddenSize: asrVersion.encoderHiddenSize
        )
        let asrManager = AsrManager(config: asrConfig)
        try await asrManager.loadModels(models)

        let decoderLayerCount = await asrManager.decoderLayerCount
        let queue = TranscriptionQueue(
            asrManager: asrManager,
            decoderLayerCount: decoderLayerCount
        )

        let ctx = AppContext(
            queue: queue,
            modelVersion: args.modelVersion,
            logger: logger
        )

        logger.info("model ready; starting HTTP server on \(args.host):\(args.port)")

        let router = buildRouter(ctx: ctx)
        let app = Application(
            router: router,
            configuration: .init(
                address: .hostname(args.host, port: args.port),
                serverName: "fluidserver"
            ),
            logger: logger
        )

        try await app.runService()
    }
}

struct AppContext: Sendable {
    let queue: TranscriptionQueue
    let modelVersion: String
    let logger: Logger
}

struct ParsedArgs {
    var modelVersion: String = "v2"
    var port: Int = 8767
    var host: String = "127.0.0.1"
}

func parseArgs() -> ParsedArgs {
    var args = ParsedArgs()
    let argv = CommandLine.arguments
    var i = 1
    while i < argv.count {
        switch argv[i] {
        case "--model-version":
            if i + 1 < argv.count { args.modelVersion = argv[i + 1]; i += 1 }
        case "--port":
            if i + 1 < argv.count, let p = Int(argv[i + 1]) { args.port = p; i += 1 }
        case "--host":
            if i + 1 < argv.count { args.host = argv[i + 1]; i += 1 }
        default:
            break
        }
        i += 1
    }
    return args
}

func modelVersionFromString(_ s: String) throws -> AsrModelVersion {
    switch s.lowercased() {
    case "v2", "2": return .v2
    case "v3", "3": return .v3
    case "tdt-ctc-110m", "110m": return .tdtCtc110m
    default:
        throw FluidServerError.badModelVersion(s)
    }
}

enum FluidServerError: Error, CustomStringConvertible {
    case badModelVersion(String)
    var description: String {
        switch self {
        case .badModelVersion(let s): return "unknown model version: \(s)"
        }
    }
}
