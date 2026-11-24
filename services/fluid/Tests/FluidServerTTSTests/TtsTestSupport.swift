import FluidServerKit
import Foundation
import Logging
import XCTest

@testable import FluidServerTTS

/// What the stand-in driver was asked, and the gate that holds its stream open.
final class Script: @unchecked Sendable {
    private let lock = NSLock()
    private var opened = false
    private var asked: [SynthesisRequest] = []
    private var built: [String] = []

    var isOpen: Bool { lock.withLock { opened } }
    func open() { lock.withLock { opened = true } }
    func waitUntilOpen() async {
        while !isOpen { try? await Task.sleep(for: .milliseconds(5)) }
    }

    func record(_ request: SynthesisRequest) { lock.withLock { asked.append(request) } }
    var requests: [SynthesisRequest] { lock.withLock { asked } }

    func recordBuild(_ key: String) { lock.withLock { built.append(key) } }
    /// The runtime keys the driver factory was called with, in order.
    var builds: [String] { lock.withLock { built } }
}

/// A streaming driver with no CoreML behind it. A stream yields half a second
/// of audio at once, then waits for the script's gate and yields half a second
/// more, so a test can tell audio sent while the model was still working from
/// audio sent after it finished.
actor GatedDriver: TtsStreamingDriver {
    static let id = "gated"
    static let supportsCloning = false
    static let sampleRate = 24000
    /// Samples in each half. At 24 kHz this is the 0.5 s the server buffers to
    /// by default, so the first half is emitted as soon as it is yielded.
    static let halfSamples = 12000

    private let script: Script

    init(modelsDirectory: URL?) async throws { script = Script() }
    init(script: Script) { self.script = script }

    func load() async throws {}

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        script.record(request)
        return SynthesisResult(
            samples: Array(repeating: 0.1, count: 2 * Self.halfSamples), sampleRate: Self.sampleRate)
    }

    func stream(_ request: SynthesisRequest) async throws
        -> (stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
    {
        script.record(request)
        let script = self.script
        let stream = AsyncThrowingStream<[Float], Error> { continuation in
            Task {
                continuation.yield(Array(repeating: 0.1, count: Self.halfSamples))
                await script.waitUntilOpen()
                continuation.yield(Array(repeating: 0.2, count: Self.halfSamples))
                continuation.finish()
            }
        }
        return (stream, Self.sampleRate)
    }
}

/// A running `fluid-tts` router over a stand-in driver. The roster offers
/// `pocket` (runtime key `pocket-tts`) and `kokoro-82m` (runtime key
/// `kokoro-ane`), and whatever voices the test supplies.
struct TtsHarness {
    let live: LiveServer
    let resident: ResidentTtsModel
    let script: Script
}

func startTtsServer(script: Script = Script(), voices: String = "[]") async throws -> TtsHarness {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("tts-harness-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("registry.json")
    try Data(
        """
        {"version": 4, "services": [{"id": "fluid-tts"}], "roster": {
          "ttsModels": [{"id": "pocket", "name": "Pocket"}, {"id": "kokoro-82m", "name": "Kokoro"}],
          "providers": {"fluid-tts": {"resolvesVoices": true, "serves": [
            {"model": "pocket", "key": "pocket-tts"}, {"model": "kokoro-82m", "key": "kokoro-ane"}]}},
          "voices": \(voices)}}
        """.utf8
    ).write(to: file)
    let roster = try TtsRoster.load(registry: file, provider: "fluid-tts")
    let resident = ResidentTtsModel(
        modelsDirectory: nil, temporaryDirectory: FileManager.default.temporaryDirectory,
        logger: Logger(label: "test"), waitDeadline: .seconds(5),
        makeDriver: { key, _, _ in
            script.recordBuild(key)
            return GatedDriver(script: script)
        })
    let ctx = TtsAppContext(
        resident: resident, roster: roster, logger: Logger(label: "test"),
        identity: AppIdentity(
            bundleIdentifier: "test.fluid-tts", shortVersion: "0.0.0", buildVersion: "test"))
    let live = try await LiveServer.start(
        router: buildRouter(ctx: ctx), webSockets: buildStreamRouter(ctx: ctx))
    return TtsHarness(live: live, resident: resident, script: script)
}

func synthesisRequest(text: String) -> SynthesisRequest {
    SynthesisRequest(
        text: text, voice: nil, refAudio: nil, refText: nil, language: nil, speed: nil,
        temperature: nil, seed: nil, cfgWeight: nil, repetitionPenalty: nil, minP: nil,
        topP: nil, topK: nil, emotion: nil, deEss: nil, maxTokensPerChunk: nil, alpha: nil,
        beta: nil, noiseScale: nil, totalSteps: nil, silenceDuration: nil)
}
