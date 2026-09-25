import FluidAudio
import FluidServerKit
import Foundation
import Logging

/// The TTS server's view of the one resident model.
///
/// The lifecycle — one model at a time, one operation at a time, a token that
/// releases the work that took the slot — is `ResidentSlot` in the kit, and the
/// reasoning for it lives there. What is here is only what synthesis adds: the
/// driver protocols, and the two ways work reaches a driver.
public actor ResidentTtsModel {
    private let slot: ResidentSlot<any TtsBackendDriver>
    private let modelsDirectory: URL?
    private let driverFactory: @Sendable (String, URL?) async throws -> any TtsBackendDriver

    public init(
        modelsDirectory: URL?,
        logger: Logger,
        waitDeadline: Duration = .seconds(30),
        makeDriver factory: @escaping @Sendable (String, URL?) async throws -> any TtsBackendDriver =
            defaultDriverFactory
    ) {
        self.modelsDirectory = modelsDirectory
        self.driverFactory = factory
        self.slot = ResidentSlot(waitDeadline: waitDeadline, logger: logger)
    }

    public var currentModel: String? {
        get async { await slot.loadedId }
    }

    public var hasLiveStream: Bool {
        get async { await slot.currentWork == .stream }
    }

    /// Loading is explicit and costs seconds; a synthesis request that silently
    /// triggered one would stall a caller with nothing to say why. The one
    /// exception is a request naming the model it wants, which loads it — the
    /// harness drives arms this way and an extra round trip buys nothing.
    public func ensureLoaded(_ id: String) async throws {
        try await load(id)
    }

    public func load(_ id: String) async throws {
        let directory = modelsDirectory
        let factory = driverFactory
        try await slot.load(id: id) {
            let driver = try await factory(id, directory)
            try await driver.load()
            return driver
        }
    }

    public func unload() async throws {
        try await slot.unload()
    }

    public func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        try await slot.withModel(.batch) { driver in
            try await driver.synthesize(request)
        }
    }

    /// Take the slot and start generating.
    ///
    /// The slot is held until `endStream`, which every caller must reach on
    /// every path out — including a client disconnect, where the producer
    /// carries on predicting after the consumer is gone.
    public func beginStream(_ request: SynthesisRequest) async throws -> (
        token: UInt64, stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int
    ) {
        let begun = try await slot.beginWork(.stream)
        guard let streaming = begun.model as? any TtsStreamingDriver else {
            await slot.end(token: begun.token)
            throw TtsError.unsupported("the loaded model cannot stream")
        }
        do {
            let started = try await streaming.stream(request)
            return (begun.token, started.stream, started.sampleRate)
        } catch {
            // Nothing was generated, so the slot goes back rather than waiting
            // for a stream that will never arrive.
            await slot.end(token: begun.token)
            throw error
        }
    }

    public func endStream(token: UInt64) async {
        await slot.end(token: token)
    }
}

/// What the server builds drivers with. Tests substitute a fake here, so the
/// lifecycle can be exercised without loading CoreML weights.
public let defaultDriverFactory:
    @Sendable (String, URL?) async throws -> any TtsBackendDriver = { id, dir in
        try await makeDriver(id, modelsDirectory: dir)
    }

/// The eight backends, by the id a caller names in `model`.
public func makeDriver(_ id: String, modelsDirectory: URL?) async throws -> any TtsBackendDriver {
    switch id {
    case "pocket-tts": return try await PocketTtsDriver(modelsDirectory: modelsDirectory)
    case "kokoro-ane": return try await KokoroAneDriver(modelsDirectory: modelsDirectory)
    case "supertonic3": return try await Supertonic3Driver(modelsDirectory: modelsDirectory)
    case "styletts2": return try await StyleTts2Driver(modelsDirectory: modelsDirectory)
    case "luxtts": return try await LuxTtsDriver(modelsDirectory: modelsDirectory)
    case "neutts-2e": return try await NeuTtsDriver(modelsDirectory: modelsDirectory)
    case "chatterbox": return try await ChatterboxDriver(modelsDirectory: modelsDirectory)
    case "inflect-micro":
        return try await InflectDriver(modelsDirectory: modelsDirectory, variant: .micro)
    case "inflect-nano":
        return try await InflectDriver(modelsDirectory: modelsDirectory, variant: .nano)
    default: throw TtsError.unknownModel(id)
    }
}

/// The keys `makeDriver` can build something for.
///
/// Not a list of what this server offers — that is the roster's, handed in at
/// start. This is the narrower fact that a key resolves to code, which the
/// roster is checked against: a roster naming a key absent from here fails at
/// startup rather than at first load.
public let driverKeys: Set<String> = [
    "pocket-tts", "kokoro-ane", "supertonic3", "styletts2", "luxtts",
    "neutts-2e", "chatterbox", "inflect-micro", "inflect-nano",
]
