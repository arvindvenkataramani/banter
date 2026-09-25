import Foundation
import Logging
import XCTest

import FluidServerKit
@testable import FluidServerTTS

/// A driver with no CoreML behind it, so the lifecycle can be tested for what
/// it promises rather than for what a model happens to do.
///
/// `gate` holds the stream open until the test releases it, which is how a
/// "live stream" is expressed here: the slot is held for exactly as long as the
/// producer is yielding.
actor FakeStreamingDriver: TtsStreamingDriver {
    static let id = "fake"
    static let supportsCloning = false
    static let sampleRate = 100

    private var gate: CheckedContinuation<Void, Never>?
    private var opened = false
    /// Set when the producer finishes, whether or not anyone was still reading.
    private(set) var producerFinished = false

    init(modelsDirectory: URL?) async throws {}
    func load() async throws {}

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        await waitForGate()
        return SynthesisResult(samples: [0.1, 0.2], sampleRate: Self.sampleRate)
    }

    func stream(_ request: SynthesisRequest) async throws
        -> (stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
    {
        let stream = AsyncThrowingStream<[Float], Error> { continuation in
            Task {
                continuation.yield(Array(repeating: 0.1, count: 10))
                await self.waitForGate()
                continuation.yield(Array(repeating: 0.2, count: 10))
                self.markFinished()
                continuation.finish()
            }
        }
        return (stream, Self.sampleRate)
    }

    private func waitForGate() async {
        if opened { return }
        await withCheckedContinuation { continuation in
            self.gate = continuation
        }
    }

    private func markFinished() { producerFinished = true }

    /// Let the in-flight operation run to completion.
    func release() {
        opened = true
        gate?.resume()
        gate = nil
    }
}

/// Hands back the resident model and a handle on whichever driver it most
/// recently built, so a test can release the parked operation without the
/// actor needing a test-only accessor.
private final class DriverHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var _latest: FakeStreamingDriver?
    var latest: FakeStreamingDriver? {
        get { lock.withLock { _latest } }
        set { lock.withLock { _latest = newValue } }
    }
}

private func makeResident(deadline: Duration = .milliseconds(200)) -> (
    resident: ResidentTtsModel, drivers: DriverHandle
) {
    let handle = DriverHandle()
    let resident = ResidentTtsModel(
        modelsDirectory: nil,
        logger: Logger(label: "test"),
        waitDeadline: deadline,
        makeDriver: { id, _ in
            guard id == "fake" || id == "other" else { throw TtsError.unknownModel(id) }
            let driver = try await FakeStreamingDriver(modelsDirectory: nil)
            handle.latest = driver
            return driver
        })
    return (resident, handle)
}

/// Drive a session to the point where the slot is held and the producer is
/// parked, then hand back the pieces the test needs to release it.
private func startLiveSession(
    on resident: ResidentTtsModel, drivers: DriverHandle, model: String = "fake"
) async throws -> (token: UInt64, driver: FakeStreamingDriver) {
    try await resident.load(model)
    guard let driver = drivers.latest else { throw TtsError.notLoaded }
    let begun = try await resident.beginStream(request(text: "hello"))
    // Consume the first frame so the producer is genuinely mid-stream.
    var iterator = begun.stream.makeAsyncIterator()
    _ = try await iterator.next()
    return (begun.token, driver)
}

private func request(text: String) -> SynthesisRequest {
    SynthesisRequest(
        text: text, voice: nil, refAudio: nil, refText: nil, language: nil, speed: nil,
        temperature: nil, seed: nil, cfgWeight: nil, repetitionPenalty: nil, minP: nil,
        topP: nil, topK: nil, emotion: nil, deEss: nil, maxTokensPerChunk: nil, alpha: nil,
        beta: nil, noiseScale: nil, totalSteps: nil, silenceDuration: nil)
}

/// Busy is the kit's condition now, not the TTS server's: the slot refuses,
/// and which work holds it comes back with the error.
private func assertBusy(
    _ body: () async throws -> Void, _ message: String, file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await body()
        XCTFail(message, file: file, line: line)
    } catch let error as SlotError {
        guard case .busy = error else {
            return XCTFail("\(message) — got \(error)", file: file, line: line)
        }
    } catch {
        XCTFail("\(message) — got \(error)", file: file, line: line)
    }
}

final class ResidentTtsModelTests: XCTestCase {
    func testASecondStreamIsRefusedWhileOneIsLive() async throws {
        let (resident, drivers) = makeResident()
        let live = try await startLiveSession(on: resident, drivers: drivers)
        await assertBusy(
            { _ = try await resident.beginStream(request(text: "second")) },
            "a second stream entered while one held the slot")
        await live.driver.release()
    }

    func testBatchSynthesisIsRefusedWhileAStreamIsLive() async throws {
        // The crash this prevents is two CoreML predictions in flight, and a
        // batch call during a stream is that just as much as two streams are.
        let (resident, drivers) = makeResident()
        let live = try await startLiveSession(on: resident, drivers: drivers)
        await assertBusy(
            { _ = try await resident.synthesize(request(text: "batch")) },
            "batch synthesis ran alongside a live stream")
        await live.driver.release()
    }

    func testAStreamIsRefusedWhileBatchSynthesisIsInFlight() async throws {
        let (resident, drivers) = makeResident()
        try await resident.load("fake")
        let driver = try XCTUnwrap(drivers.latest)
        let batch = Task { try await resident.synthesize(request(text: "batch")) }
        // Let the batch call reach the parked driver and take the slot.
        try await Task.sleep(for: .milliseconds(50))
        await assertBusy(
            { _ = try await resident.beginStream(request(text: "stream")) },
            "a stream began while batch synthesis held the slot")
        await driver.release()
        _ = try await batch.value
    }

    func testLoadingADifferentModelIsRefusedWhileAStreamIsLive() async throws {
        let (resident, drivers) = makeResident()
        let live = try await startLiveSession(on: resident, drivers: drivers)
        await assertBusy(
            { try await resident.load("other") },
            "a load pulled the model out from under a live stream")
        await live.driver.release()
    }

    func testUnloadIsRefusedWhileAStreamIsLive() async throws {
        let (resident, drivers) = makeResident()
        let live = try await startLiveSession(on: resident, drivers: drivers)
        await assertBusy(
            { try await resident.unload() },
            "an unload nilled the driver under a live stream")
        await live.driver.release()
    }

    func testEnsureLoadedOfTheResidentModelSucceedsDuringAStream() async throws {
        // Every request names its model, so routine same-model contention must
        // not read as a conflict: nothing is being evicted.
        let (resident, drivers) = makeResident()
        let live = try await startLiveSession(on: resident, drivers: drivers)
        try await resident.ensureLoaded("fake")
        await live.driver.release()
    }

    func testASessionThatReleasesWithinTheDeadlineLetsTheNextOneProceed() async throws {
        let (resident, drivers) = makeResident(deadline: .seconds(2))
        let live = try await startLiveSession(on: resident, drivers: drivers)
        // A client closing one connection and opening the next arrives while
        // the previous teardown is still running; waiting is the right answer.
        Task {
            try? await Task.sleep(for: .milliseconds(50))
            await live.driver.release()
            await resident.endStream(token: live.token)
        }
        let next = try await resident.beginStream(request(text: "next"))
        XCTAssertNotEqual(next.token, live.token)
        await resident.endStream(token: next.token)
    }

    func testASlotHeldPastTheDeadlineReportsBusy() async throws {
        let (resident, drivers) = makeResident(deadline: .milliseconds(100))
        let live = try await startLiveSession(on: resident, drivers: drivers)
        await assertBusy(
            { _ = try await resident.beginStream(request(text: "next")) },
            "a slot still held after the deadline was treated as departing")
        await live.driver.release()
    }

    func testAStaleTokenDoesNotEndANewerSession() async throws {
        // A teardown arriving out of order must not close the session a later
        // connection has just opened.
        let (resident, drivers) = makeResident()
        let first = try await startLiveSession(on: resident, drivers: drivers)
        await first.driver.release()
        await resident.endStream(token: first.token)

        let second = try await resident.beginStream(request(text: "second"))
        await resident.endStream(token: first.token)
        let stillHeld = await resident.hasLiveStream
        XCTAssertTrue(stillHeld, "a stale token ended the session that replaced it")
        await resident.endStream(token: second.token)
    }

    func testAbandoningTheStreamDoesNotReleaseTheSlot() async throws {
        // A client disconnect abandons the consumer while CoreML may still be
        // predicting, and the slot has to survive that: releasing on the
        // consumer's exit would hand the next request an overlapping
        // prediction. The actor holds the slot until `endStream`; that the
        // route calls it at the producer's end rather than the consumer's is
        // the route's contract, not this one's.
        let (resident, drivers) = makeResident()
        let live = try await startLiveSession(on: resident, drivers: drivers)
        // The consumer is gone: `startLiveSession`'s iterator is dropped here.
        await assertBusy(
            { _ = try await resident.beginStream(request(text: "next")) },
            "the slot released when the consumer stopped reading")
        let finished = await live.driver.producerFinished
        XCTAssertFalse(finished, "the producer finished before the test released it")
        await live.driver.release()
    }

    func testTheSlotIsFreeAfterASessionEnds() async throws {
        let (resident, drivers) = makeResident()
        let live = try await startLiveSession(on: resident, drivers: drivers)
        await live.driver.release()
        await resident.endStream(token: live.token)
        let stillLive = await resident.hasLiveStream
        XCTAssertFalse(stillLive)
        let next = try await resident.beginStream(request(text: "next"))
        await resident.endStream(token: next.token)
    }

    /// Every route throws `TtsError` directly, so the status lives on the error
    /// rather than at one call site. A busy model reported as 500 is
    /// indistinguishable from a broken one.
    func testBusyAndNotLoadedAreConflictsRatherThanServerErrors() {
        XCTAssertEqual(TtsError.busy.status, .conflict)
        XCTAssertEqual(TtsError.notLoaded.status, .conflict)
        XCTAssertEqual(TtsError.unknownModel("nope").status, .badRequest)
    }

    func testStreamingAnUnloadedModelReportsNotLoaded() async throws {
        let (resident, _) = makeResident()
        do {
            _ = try await resident.beginStream(request(text: "hello"))
            XCTFail("a stream began with no model resident")
        } catch let error as SlotError {
            guard case .empty = error else {
                return XCTFail("expected an empty slot, got \(error)")
            }
        }
    }
}
