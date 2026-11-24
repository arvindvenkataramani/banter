import Foundation
import XCTest

@testable import FluidServerTTS

/// `openai.audio.speech` as `fluid-tts` serves it from S1: audio streams as it
/// renders without any request flag, and `stream_format=sse` is implemented
/// (spec section 9, routes by step).
final class SpeechStreamingTests: XCTestCase {
    private actor Progress {
        private(set) var bytes = 0
        private(set) var finished = false
        func update(_ count: Int) { bytes = count }
        func finish(_ count: Int) { bytes = count; finished = true }
    }

    private func speech(_ extra: [String: Any]) throws -> Data {
        var body: [String: Any] = ["model": "pocket", "input": "hello", "response_format": "pcm"]
        for (key, value) in extra { body[key] = value }
        return try JSONSerialization.data(withJSONObject: body)
    }

    /// The promise is audio before the utterance is finished: with the model
    /// held half way, the first half of the audio has to be on the wire.
    func testS1_SpeechWithoutAStreamFlagArrivesWhileTheModelIsStillSynthesizing() async throws {
        let h = try await startTtsServer()
        let reply = try await h.live.stream(
            "POST", "/v1/audio/speech", headers: ["Content-Type": "application/json"],
            body: try speech([:]))
        XCTAssertEqual(reply.response.statusCode, 200)

        let progress = Progress()
        let reader = Task {
            var count = 0
            for try await _ in reply.bytes {
                count += 1
                if count % 512 == 0 { await progress.update(count) }
            }
            await progress.finish(count)
        }

        var early = 0
        for _ in 0..<300 {
            early = await progress.bytes
            if early > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let finishedEarly = await progress.finished
        XCTAssertGreaterThan(early, 0, "no audio arrived while the model was held half way")
        XCTAssertFalse(finishedEarly, "the response ended before the model was released")

        h.script.open()
        try await reader.value
        let total = await progress.bytes
        XCTAssertEqual(total, 2 * 2 * GatedDriver.halfSamples, "both halves, 16-bit samples")
        await h.live.stop()
    }

    func testS1_StreamFormatSseAnswersAsServerSentEventsCarryingTheAudio() async throws {
        let h = try await startTtsServer()
        h.script.open()

        let reply = try await h.live.request(
            "POST", "/v1/audio/speech", headers: ["Content-Type": "application/json"],
            body: try speech(["stream_format": "sse"]))

        XCTAssertEqual(reply.status, 200, reply.text)
        XCTAssertTrue(reply.contentType.contains("text/event-stream"), reply.contentType)
        let objects = try reply.text.split(separator: "\n").filter { $0.hasPrefix("data:") }.map { line in
            let payload = line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
            return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any])
        }
        let deltas = objects.filter { $0["type"] as? String == "speech.audio.delta" }
        XCTAssertGreaterThanOrEqual(deltas.count, 2, "several audio events, not one: \(reply.text.prefix(200))")
        XCTAssertEqual(objects.last?["type"] as? String, "speech.audio.done")
        let decoded = try deltas.reduce(0) { total, event in
            total + (try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(event["audio"] as? String)))).count
        }

        h.script.open()
        let plain = try await h.live.request(
            "POST", "/v1/audio/speech", headers: ["Content-Type": "application/json"], body: try speech([:]))
        XCTAssertEqual(decoded, plain.body.count, "the events carry the same audio as the plain response")
        await h.live.stop()
    }
}
