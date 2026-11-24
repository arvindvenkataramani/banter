import Foundation
import XCTest

@testable import FluidServerSTT

/// The Realtime subset `fluid-stt` serves from S2 (spec section 9): a
/// transcription session with `session.update`, `input_audio_buffer.append`,
/// `.commit` and `.clear`, answered by the events the spec lists. Driven over a
/// real socket against a scripted model.
///
/// INVENTED: the event fields beyond `type` (`session.audio.input.format`,
/// `audio` on an append, `item_id` on committed and completed) are the ones
/// dev/analysis/service-api-binding.md read from OpenAI's pages; the pinned
/// pages were not re-read. The transcript is matched as text inside the
/// completed event rather than by field name.
final class RealtimeTranscriptionTests: XCTestCase {
    private func connect(_ h: SttHarness) -> WSClient {
        WSClient(url: h.live.wsURL("/v1/realtime?intent=transcription"))
    }

    private func sessionUpdate(format: [String: Any]) -> [String: Any] {
        [
            "type": "session.update",
            "session": [
                "type": "transcription",
                "audio": ["input": ["format": format, "turn_detection": NSNull()]],
            ],
        ]
    }

    private func append(_ data: Data) -> [String: Any] {
        ["type": "input_audio_buffer.append", "audio": data.base64EncodedString()]
    }

    /// Text messages until the transcript for a commit completes.
    private func untilCompleted(_ ws: WSClient) async -> [WSClient.Event] {
        await ws.collect(timeout: .seconds(5)) {
            $0.type == "conversation.item.input_audio_transcription.completed"
        }
    }

    func testS2_ASessionIsCreatedThenUpdatedInThatOrder() async throws {
        let h = try await startSttServer()
        let ws = connect(h)

        try await ws.send(json: sessionUpdate(format: ["type": "audio/pcm", "rate": 24000]))
        let events = await ws.collect { $0.type == "session.updated" }

        let types = events.compactMap(\.type)
        XCTAssertEqual(types.last, "session.updated")
        XCTAssertTrue(types.contains("session.created"), "\(types)")
        XCTAssertLessThan(try XCTUnwrap(types.firstIndex(of: "session.created")), types.count - 1)
        ws.close()
        await h.live.stop()
    }

    func testS2_ACommitIsAnsweredWithCommittedAndThenTheTranscriptOfThatItem() async throws {
        let h = try await startSttServer()
        let ws = connect(h)
        try await ws.send(json: sessionUpdate(format: ["type": "audio/pcm", "rate": 24000]))
        _ = try await ws.require(type: "session.updated")

        try await ws.send(json: append(tone(ms: 500, rate: 24000)))
        try await ws.send(json: ["type": "input_audio_buffer.commit"])
        let events = await untilCompleted(ws)

        let types = events.compactMap(\.type)
        let committed = try XCTUnwrap(events.first { $0.type == "input_audio_buffer.committed" }?.object)
        let completed = try XCTUnwrap(
            events.first { $0.type == "conversation.item.input_audio_transcription.completed" })
        XCTAssertLessThan(
            try XCTUnwrap(types.firstIndex(of: "input_audio_buffer.committed")),
            try XCTUnwrap(types.firstIndex(of: "conversation.item.input_audio_transcription.completed")))
        let itemId = try XCTUnwrap(committed["item_id"] as? String)
        XCTAssertFalse(itemId.isEmpty)
        XCTAssertEqual(completed.object?["item_id"] as? String, itemId, "the transcript is matched to its commit")
        XCTAssertTrue(completed.text?.contains(scriptedText) == true, "\(completed)")
        ws.close()
        await h.live.stop()
    }

    func testS2_OpusInputIsAcceptedWhenTheSessionNamesItAndEachAppendIsOnePacket() async throws {
        let h = try await startSttServer()
        let ws = connect(h)
        try await ws.send(json: sessionUpdate(format: ["type": "audio/opus", "rate": 16000]))
        let updated = try await ws.require(type: "session.updated")
        let announced = ((((updated["session"] as? [String: Any])?["audio"] as? [String: Any])?["input"] as? [String: Any])?["format"] as? [String: Any])
        XCTAssertEqual(announced?["type"] as? String, "audio/opus")
        XCTAssertEqual(announced?["rate"] as? Int, 16000, "the session names Opus at the 16 kHz the engine encodes")

        try await ws.send(json: append(opusSilencePacket))
        try await ws.send(json: append(opusSilencePacket))
        try await ws.send(json: ["type": "input_audio_buffer.commit"])
        let events = await untilCompleted(ws)

        let completed = events.first { $0.type == "conversation.item.input_audio_transcription.completed" }
        XCTAssertTrue(completed?.text?.contains(scriptedText) == true, "\(events)")
        ws.close()
        await h.live.stop()
    }

    func testS2_AClearIsAnsweredWithCleared() async throws {
        let h = try await startSttServer()
        let ws = connect(h)
        try await ws.send(json: sessionUpdate(format: ["type": "audio/pcm", "rate": 24000]))
        _ = try await ws.require(type: "session.updated")

        try await ws.send(json: append(tone(ms: 200, rate: 24000)))
        try await ws.send(json: ["type": "input_audio_buffer.clear"])

        _ = try await ws.require(type: "input_audio_buffer.cleared")
        ws.close()
        await h.live.stop()
    }

    /// The adapter accumulates deltas per item, so the server must send them.
    func testS2_ACommitYieldsAtLeastOneDeltaForTheSameItemBeforeItCompletes() async throws {
        let h = try await startSttServer()
        let ws = connect(h)
        try await ws.send(json: sessionUpdate(format: ["type": "audio/pcm", "rate": 24000]))
        _ = try await ws.require(type: "session.updated")

        try await ws.send(json: append(tone(ms: 500, rate: 24000)))
        try await ws.send(json: ["type": "input_audio_buffer.commit"])
        let events = await untilCompleted(ws)

        let completed = try XCTUnwrap(
            events.first { $0.type == "conversation.item.input_audio_transcription.completed" })
        let itemId = try XCTUnwrap(completed.object?["item_id"] as? String)
        let deltas = events.filter {
            $0.type == "conversation.item.input_audio_transcription.delta"
                && $0.object?["item_id"] as? String == itemId
        }
        XCTAssertFalse(deltas.isEmpty, "\(events.compactMap(\.type))")
        ws.close()
        await h.live.stop()
    }

    func testS2_ASessionUpdateForAConversationSessionIsAnsweredWithAnError() async throws {
        let h = try await startSttServer()
        let ws = connect(h)

        try await ws.send(json: ["type": "session.update", "session": ["type": "realtime"]])

        _ = try await ws.require(type: "error")
        ws.close()
        await h.live.stop()
    }

    func testS2_AClientEventOutsideTheSubsetIsAnsweredWithAnError() async throws {
        let h = try await startSttServer()
        let ws = connect(h)
        try await ws.send(json: sessionUpdate(format: ["type": "audio/pcm", "rate": 24000]))
        _ = try await ws.require(type: "session.updated")

        try await ws.send(json: ["type": "conversation.item.create", "item": ["type": "message"]])

        _ = try await ws.require(type: "error")
        ws.close()
        await h.live.stop()
    }
}
