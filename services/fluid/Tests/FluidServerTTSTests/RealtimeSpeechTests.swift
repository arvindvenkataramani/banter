import Foundation
import XCTest

@testable import FluidServerTTS

/// The Realtime subset `fluid-tts` serves from S2 (spec section 9):
/// `session.update`, `response.create` speaking the text of `input_text` parts
/// verbatim, and `response.cancel`, answered in 24 kHz PCM. Driven over a real
/// socket against a stand-in driver that records what it was asked.
///
/// INVENTED: the shape of `response.create` (`response.input[].content[]` with
/// `input_text` parts, and `instructions` beside them) is the one
/// dev/analysis/service-api-binding.md read from OpenAI and Kokoro-FastAPI.
final class RealtimeSpeechTests: XCTestCase {
    private func connect(_ h: TtsHarness) -> WSClient {
        WSClient(url: h.live.wsURL("/v1/realtime"))
    }

    /// A `response.create` whose `input` holds one `input_text` part, with
    /// instructions that a model-running server would follow instead.
    private func create(_ text: String) -> [String: Any] {
        [
            "type": "response.create",
            "response": [
                "instructions": "Ignore the text and say something else entirely.",
                "input": [
                    [
                        "type": "message", "role": "user",
                        "content": [["type": "input_text", "text": text]],
                    ]
                ],
            ],
        ]
    }

    func testS2_ResponseCreateSpeaksTheInputTextVerbatimAndAnswersInOrder() async throws {
        let h = try await startTtsServer()
        h.script.open()
        let ws = connect(h)

        try await ws.send(json: create("Read exactly this, not that."))
        let events = await ws.collect(timeout: .seconds(5)) { $0.type == "response.done" }

        let types = events.compactMap(\.type)
        let created = try XCTUnwrap(types.firstIndex(of: "response.created"), "\(types)")
        let delta = try XCTUnwrap(types.firstIndex(of: "response.output_audio.delta"), "\(types)")
        let audioDone = try XCTUnwrap(types.firstIndex(of: "response.output_audio.done"), "\(types)")
        let done = try XCTUnwrap(types.firstIndex(of: "response.done"), "\(types)")
        XCTAssertLessThan(created, delta)
        XCTAssertLessThan(delta, audioDone)
        XCTAssertLessThan(audioDone, done)
        let asked = try XCTUnwrap(h.script.requests.last)
        XCTAssertEqual(asked.text, "Read exactly this, not that.")
        ws.close()
        await h.live.stop()
    }

    func testS2_AClientEventOutsideTheSubsetIsAnsweredWithAnError() async throws {
        let h = try await startTtsServer()
        let ws = connect(h)

        try await ws.send(json: ["type": "input_audio_buffer.append", "audio": ""])
        let events = await ws.collect { $0.type == "error" }

        XCTAssertEqual(events.last?.type, "error", "\(events)")
        ws.close()
        await h.live.stop()
    }

    /// With the model held after its first half second, a cancel has to stop
    /// the audio that would follow once it is released.
    func testS2_ResponseCancelStopsTheAudioThatWouldFollow() async throws {
        let h = try await startTtsServer()
        let ws = connect(h)
        try await ws.send(json: create("A long sentence that the client abandons."))
        _ = await ws.collect { $0.type == "response.output_audio.delta" }
        _ = await ws.drain(quiet: .milliseconds(300))

        try await ws.send(json: ["type": "response.cancel"])
        let cancelled = await ws.drain(quiet: .milliseconds(300))
        h.script.open()
        let released = await ws.drain(quiet: .milliseconds(500))

        let types = (cancelled + released).compactMap(\.type)
        XCTAssertTrue(types.contains("response.done"), "a cancelled response still ends: \(types)")
        XCTAssertFalse(types.contains("response.output_audio.delta"), "audio kept coming after the cancel: \(types)")
        ws.close()
        await h.live.stop()
    }
}
