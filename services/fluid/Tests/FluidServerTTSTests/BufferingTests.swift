import XCTest

import FluidServerKit
@testable import FluidServerTTS

/// The buffering policy is what bounds TTFB: a caller waits at most one
/// interval for audio regardless of how long the text is. These tests fix that
/// contract without a model, which is the reason the policy is a free function
/// rather than route code.
final class BufferingTests: XCTestCase {
    /// Collect what `bufferedChunks` emits for a fixed sequence of frames.
    private func emissions(
        frames: [[Float]], interval: Double, sampleRate: Int
    ) async throws -> [[Float]] {
        let source = AsyncThrowingStream<[Float], Error> { continuation in
            for frame in frames { continuation.yield(frame) }
            continuation.finish()
        }
        var out: [[Float]] = []
        for try await chunk in bufferedChunks(
            source, interval: interval, sampleRate: sampleRate)
        {
            out.append(chunk)
        }
        return out
    }

    func testEmitsOnceTheIntervalIsReached() async throws {
        // 1.0s at 100 Hz is 100 samples; two 50-sample frames reach it exactly.
        let out = try await emissions(
            frames: [Array(repeating: 0.1, count: 50), Array(repeating: 0.2, count: 50)],
            interval: 1.0, sampleRate: 100)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].count, 100)
    }

    func testHoldsOneSampleShortOfTheInterval() async throws {
        // 99 of the 100 samples an interval needs: still buffered, so the only
        // emission is the tail flush.
        let out = try await emissions(
            frames: [Array(repeating: 0.1, count: 99)], interval: 1.0, sampleRate: 100)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].count, 99)
    }

    func testFlushesTheTailAfterAFullInterval() async throws {
        let out = try await emissions(
            frames: [Array(repeating: 0.1, count: 100), Array(repeating: 0.2, count: 30)],
            interval: 1.0, sampleRate: 100)
        XCTAssertEqual(out.map(\.count), [100, 30])
    }

    func testEmitsEveryWholeIntervalInOneOversizedFrame() async throws {
        // A frame larger than the interval must not collapse to one emission:
        // the policy is a sample count, not a frame boundary.
        let out = try await emissions(
            frames: [Array(repeating: 0.1, count: 250)], interval: 1.0, sampleRate: 100)
        XCTAssertEqual(out.map(\.count), [100, 100, 50])
    }

    func testPreservesSampleOrderAcrossChunkBoundaries() async throws {
        let ramp = (0..<200).map { Float($0) }
        let out = try await emissions(
            frames: [ramp], interval: 1.0, sampleRate: 100)
        XCTAssertEqual(out.flatMap { $0 }, ramp)
    }

    func testEmitsNothingForAnEmptyStream() async throws {
        let out = try await emissions(frames: [], interval: 1.0, sampleRate: 100)
        XCTAssertTrue(out.isEmpty)
    }

    func testClampsANonPositiveIntervalToASingleSample() async throws {
        // Zero would divide the stream into nothing; one sample per emission is
        // the smallest honest reading of "as fast as possible".
        let out = try await emissions(
            frames: [[0.1, 0.2, 0.3]], interval: 0, sampleRate: 100)
        XCTAssertEqual(out.map(\.count), [1, 1, 1])
    }

    func testPropagatesAProducerFailureAfterEmittingWhatArrived() async throws {
        struct Boom: Error {}
        let source = AsyncThrowingStream<[Float], Error> { continuation in
            continuation.yield(Array(repeating: 0.1, count: 100))
            continuation.finish(throwing: Boom())
        }
        var out: [[Float]] = []
        do {
            for try await chunk in bufferedChunks(source, interval: 1.0, sampleRate: 100) {
                out.append(chunk)
            }
            XCTFail("expected the producer's error to surface")
        } catch {
            // The full interval reached the caller before the failure did; a
            // mid-stream error truncates rather than discarding what was sent.
            XCTAssertEqual(out.map(\.count), [100])
        }
    }
}
