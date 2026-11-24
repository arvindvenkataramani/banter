import Foundation
import XCTest

@testable import FluidServerSTT

/// The two HTTP transcription APIs `fluid-stt` serves from S2 beyond today's
/// plain one: `deepgram.listen.prerecorded` (spec section 9, S2 row) and
/// `openai.audio.transcriptions` with `stream=true`. The model is scripted, so
/// the audio in the body is never decoded; what is checked is the route.
final class TranscriptionRoutesTests: XCTestCase {
    private let audio = Data(repeating: 0, count: 64)

    // MARK: - deepgram.listen.prerecorded

    func testS2_PrerecordedAnswersInDeepgramsShapeWithTheTranscript() async throws {
        let h = try await startSttServer()

        let reply = try await h.live.request(
            "POST", "/v1/listen?model=parakeet-tdt-v3", headers: ["Content-Type": "audio/wav"], body: audio)

        XCTAssertEqual(reply.status, 200, reply.text)
        let results = try XCTUnwrap(reply.object?["results"] as? [String: Any])
        let channel = try XCTUnwrap((results["channels"] as? [[String: Any]])?.first)
        let alternative = try XCTUnwrap((channel["alternatives"] as? [[String: Any]])?.first)
        XCTAssertEqual(alternative["transcript"] as? String, scriptedText)
        await h.live.stop()
    }

    /// The server's default model is `parakeet-tdt-v3`, so a different model
    /// resident afterwards is the one the request named.
    func testS2_PrerecordedHonoursTheModelParameter() async throws {
        let h = try await startSttServer()

        let reply = try await h.live.request(
            "POST", "/v1/listen?model=parakeet-unified-0.6b", headers: ["Content-Type": "audio/wav"],
            body: audio)

        XCTAssertEqual(reply.status, 200, reply.text)
        let loaded = await h.resident.loadedId
        XCTAssertEqual(loaded, "parakeet-unified-0.6b")
        await h.live.stop()
    }

    // MARK: - openai.audio.transcriptions, stream=true

    private func transcribe(_ h: SttHarness, fields: [String: String]) async throws -> HttpReply {
        let boundary = "banter-\(UUID().uuidString)"
        return try await h.live.request(
            "POST", "/v1/audio/transcriptions",
            headers: ["Content-Type": "multipart/form-data; boundary=\(boundary)"],
            body: multipartBody(boundary: boundary, file: audio, fields: fields))
    }

    func testS2_ATranscriptionWithStreamTrueAnswersAsServerSentEventsCarryingTheText() async throws {
        let h = try await startSttServer()

        let reply = try await transcribe(h, fields: ["stream": "true", "model": "parakeet-tdt-v3"])

        XCTAssertEqual(reply.status, 200, reply.text)
        XCTAssertTrue(reply.contentType.contains("text/event-stream"), reply.contentType)
        let events = reply.text.split(separator: "\n").filter { $0.hasPrefix("data:") }
        XCTAssertFalse(events.isEmpty, "no events in \(reply.text.prefix(200))")
        for event in events {
            let payload = event.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
            let object = try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any]
            XCTAssertNotNil(object?["type"] as? String, "each event is a typed JSON object: \(payload.prefix(80))")
        }
        XCTAssertTrue(reply.text.contains(scriptedText), "the stream never carried the transcript")
        await h.live.stop()
    }

    /// The same request without the flag is one JSON body, as before.
    func testS2_ATranscriptionWithoutStreamStaysOneJsonBody() async throws {
        let h = try await startSttServer()

        let reply = try await transcribe(h, fields: ["model": "parakeet-tdt-v3"])

        XCTAssertEqual(reply.status, 200, reply.text)
        XCTAssertTrue(reply.contentType.contains("application/json"), reply.contentType)
        XCTAssertEqual(reply.object?["text"] as? String, scriptedText)
        await h.live.stop()
    }
}
