import FluidServerKit
import Foundation
import Logging
import XCTest

@testable import FluidServerTTS

/// Records what a session sent, so queueing and cancellation can be checked
/// without a live socket.
final class RecordingSink: SocketSink, @unchecked Sendable {
    private let lock = NSLock()
    private var _text: [String] = []
    private var _binary: [Data] = []
    private var _closed: String?

    var text: [String] { lock.withLock { _text } }
    var binary: [Data] { lock.withLock { _binary } }
    var closed: String? { lock.withLock { _closed } }

    /// The `type` of each JSON frame, in order — what a client would switch on.
    var frameTypes: [String] {
        text.compactMap { line in
            guard let data = line.data(using: .utf8),
                let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }
            return object["type"] as? String
        }
    }

    func sendText(_ text: String) async throws {
        lock.withLock { _text.append(text) }
    }

    func sendBinary(_ data: Data) async throws {
        lock.withLock { _binary.append(data) }
    }

    func close(reason: String) async {
        lock.withLock { _closed = reason }
    }
}

/// A driver that yields a fixed number of frames, pausing between them so a
/// test can cancel mid-utterance.
actor SlowStreamingDriver: TtsStreamingDriver {
    static let id = "slow"
    static let supportsCloning = false
    static let sampleRate = 100

    private let frameCount: Int
    private let gapMilliseconds: UInt64
    private(set) var framesYielded = 0

    init(modelsDirectory: URL?) async throws {
        self.frameCount = 20
        self.gapMilliseconds = 20
    }

    func load() async throws {}

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        SynthesisResult(samples: Array(repeating: 0.1, count: 100), sampleRate: Self.sampleRate)
    }

    private func countFrame() { framesYielded += 1 }

    func stream(_ request: SynthesisRequest) async throws
        -> (stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
    {
        let count = frameCount
        let gap = gapMilliseconds
        let stream = AsyncThrowingStream<[Float], Error> { continuation in
            Task {
                for _ in 0..<count {
                    if Task.isCancelled { break }
                    continuation.yield(Array(repeating: 0.1, count: 50))
                    await self.countFrame()
                    try? await Task.sleep(for: .milliseconds(gap))
                }
                continuation.finish()
            }
        }
        return (stream, Self.sampleRate)
    }
}

private func makeQueue(sink: RecordingSink) async throws -> (SynthesisQueue, ResidentTtsModel) {
    let resident = ResidentTtsModel(
        modelsDirectory: nil,
        logger: Logger(label: "test"),
        waitDeadline: .seconds(5),
        makeDriver: { _, _ in try await SlowStreamingDriver(modelsDirectory: nil) })
    try await resident.load("slow")
    // The queue never consults the roster; it is reached through a model the
    // driver factory already holds.
    let ctx = TtsAppContext(
        resident: resident, roster: TtsRoster(models: []), logger: Logger(label: "test"))
    return (SynthesisQueue(ctx: ctx, format: .wav, sink: sink), resident)
}

final class SynthesisQueueTests: XCTestCase {
    func testOneSpanProducesAStartAudioAndAnEnd() async throws {
        let sink = RecordingSink()
        let (queue, _) = try await makeQueue(sink: sink)
        await queue.enqueue(text: "hello", voice: nil, refAudio: nil)
        await queue.drain()

        XCTAssertEqual(sink.frameTypes.first, "utterance.start")
        XCTAssertEqual(sink.frameTypes.last, "utterance.end")
        XCTAssertFalse(sink.binary.isEmpty, "no audio reached the client")
    }

    /// Spans synthesise one at a time and in the order they arrived: a client
    /// sends text as it is generated, and reordering it would reorder speech.
    func testSpansAreSpokenInTheOrderTheyArrived() async throws {
        let sink = RecordingSink()
        let (queue, _) = try await makeQueue(sink: sink)
        for word in ["one", "two", "three"] {
            await queue.enqueue(text: word, voice: nil, refAudio: nil)
        }
        await queue.drain()

        let starts = sink.frameTypes.filter { $0 == "utterance.start" }
        let ends = sink.frameTypes.filter { $0 == "utterance.end" }
        XCTAssertEqual(starts.count, 3)
        XCTAssertEqual(ends.count, 3)
        // Never two utterances open at once: one model, one at a time.
        var open = 0
        for type in sink.frameTypes {
            if type == "utterance.start" {
                open += 1
                XCTAssertEqual(open, 1, "a second utterance began before the first ended")
            }
            if type == "utterance.end" { open -= 1 }
        }
    }

    /// Barge-in: one message stops generation and drops everything queued.
    func testCancelStopsTheCurrentSpanAndDropsTheQueue() async throws {
        let sink = RecordingSink()
        let (queue, _) = try await makeQueue(sink: sink)
        for word in ["first", "second", "third"] {
            await queue.enqueue(text: word, voice: nil, refAudio: nil)
        }
        // Let the first utterance get under way.
        try await Task.sleep(for: .milliseconds(80))
        await queue.cancelAll()

        XCTAssertTrue(sink.frameTypes.contains("cancelled"))
        let started = sink.frameTypes.filter { $0 == "utterance.start" }.count
        XCTAssertEqual(started, 1, "a queued span ran after the cancel")

        // And the queue is usable afterwards rather than wedged: barge-in is
        // followed by the next thing to say.
        await queue.enqueue(text: "after", voice: nil, refAudio: nil)
        await queue.drain()
        XCTAssertEqual(
            sink.frameTypes.filter { $0 == "utterance.start" }.count, 2,
            "the queue did not accept work after a cancel")
    }

    func testCancelWithNothingRunningIsHarmless() async throws {
        let sink = RecordingSink()
        let (queue, _) = try await makeQueue(sink: sink)
        await queue.cancelAll()
        XCTAssertTrue(sink.frameTypes.contains("cancelled"))
    }

    /// A runaway client is refused rather than growing the queue without limit.
    func testTheQueueRefusesBeyondItsDepthCap() async throws {
        let sink = RecordingSink()
        let (queue, _) = try await makeQueue(sink: sink)
        for i in 0..<40 {
            await queue.enqueue(text: "span \(i)", voice: nil, refAudio: nil)
        }
        XCTAssertTrue(
            sink.frameTypes.contains("error"),
            "a client past the cap was not told")
        await queue.cancelAll()
    }

    /// The slot has to come back, or the next connection finds the server busy
    /// with work that has already finished.
    func testTheResidentSlotIsFreeAfterTheQueueDrains() async throws {
        let sink = RecordingSink()
        let (queue, resident) = try await makeQueue(sink: sink)
        await queue.enqueue(text: "hello", voice: nil, refAudio: nil)
        await queue.drain()

        let held = await resident.hasLiveStream
        XCTAssertFalse(held, "the slot was still held after the queue drained")
    }

    func testTheResidentSlotIsFreeAfterACancel() async throws {
        let sink = RecordingSink()
        let (queue, resident) = try await makeQueue(sink: sink)
        await queue.enqueue(text: "hello", voice: nil, refAudio: nil)
        try await Task.sleep(for: .milliseconds(80))
        await queue.cancelAll()

        let held = await resident.hasLiveStream
        XCTAssertFalse(held, "cancelling left the slot held")
    }

    /// Shutdown runs on every path out of a connection, including one where the
    /// peer vanished mid-utterance.
    func testShutdownReleasesEverythingMidUtterance() async throws {
        let sink = RecordingSink()
        let (queue, resident) = try await makeQueue(sink: sink)
        await queue.enqueue(text: "hello", voice: nil, refAudio: nil)
        await queue.enqueue(text: "world", voice: nil, refAudio: nil)
        try await Task.sleep(for: .milliseconds(80))
        await queue.shutdown()

        let held = await resident.hasLiveStream
        XCTAssertFalse(held, "a dropped connection left the model held")
    }
}
