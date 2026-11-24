import Foundation
import XCTest

@testable import FluidServerTTS

/// `deepgram.speak` (`POST /v1/speak`) and `deepgram.speak.live` (WebSocket
/// `/v1/speak`) as `fluid-tts` serves them from S2 (spec section 9). Deepgram's
/// `model` is a synthesis model and the voice is the `voice` parameter, which is
/// what `voice-param` declares. Driven over real sockets against a stand-in
/// driver that records what it was asked.
///
/// INVENTED: `Metadata` arrives on connect and `Flushed` and `Cleared` carry an
/// integer `sequence_id`, as the design and parts/deepgram.speak.live.json say;
/// no other field of any message is read.
final class DeepgramSpeakTests: XCTestCase {
    private let voices = """
        [{"id": "nicole", "name": "Nicole",
          "renderings": [{"model": "kokoro-82m", "method": "preset", "key": "af_nicole"}]}]
        """
    private let query = "model=kokoro-82m&voice=nicole&encoding=linear16&sample_rate=24000"

    private func text(_ extra: [String: Any] = [:]) throws -> Data {
        var body: [String: Any] = ["text": "Hello there"]
        for (key, value) in extra { body[key] = value }
        return try JSONSerialization.data(withJSONObject: body)
    }

    // MARK: - POST /v1/speak

    func testS2_SpeakSpeaksTheTextWithTheNamedModelAndVoiceAsRawLinear16() async throws {
        let h = try await startTtsServer(voices: voices)
        h.script.open()

        let reply = try await h.live.request(
            "POST", "/v1/speak?\(query)&container=none",
            headers: ["Content-Type": "application/json"], body: try text())

        XCTAssertEqual(reply.status, 200, reply.text)
        XCTAssertEqual(h.script.builds, ["kokoro-ane"], "the model parameter chose the model")
        let asked = try XCTUnwrap(h.script.requests.last)
        XCTAssertEqual(asked.text, "Hello there")
        XCTAssertEqual(asked.voice, "af_nicole", "the voice parameter chose the voice")
        XCTAssertEqual(reply.body.count, 2 * 2 * GatedDriver.halfSamples, "16-bit samples, no container")
        await h.live.stop()
    }

    func testS2_SpeakRefusesAnEncodingOutsideWhatTheServerEncodes() async throws {
        let h = try await startTtsServer(voices: voices)
        h.script.open()

        let reply = try await h.live.request(
            "POST", "/v1/speak?model=kokoro-82m&voice=nicole&encoding=mp3",
            headers: ["Content-Type": "application/json"], body: try text())

        XCTAssertEqual(reply.status, 400)
        await h.live.stop()
    }

    // MARK: - WebSocket /v1/speak

    private func connect(_ h: TtsHarness, _ extra: String = "") -> WSClient {
        WSClient(url: h.live.wsURL("/v1/speak?\(query)\(extra)"))
    }

    func testS2_SpeakLiveSendsMetadataFirstThenTheAudioOfASpeakBeforeFlushed() async throws {
        let h = try await startTtsServer(voices: voices)
        h.script.open()
        let ws = connect(h)
        let first = await ws.nextText()
        XCTAssertEqual(first?.type, "Metadata")

        try await ws.send(json: ["type": "Speak", "text": "Hello there"])
        try await ws.send(json: ["type": "Flush"])
        let events = await ws.collect { $0.type == "Flushed" }

        let flushed = try XCTUnwrap(events.last?.object, "no Flushed arrived: \(events)")
        XCTAssertEqual(flushed["type"] as? String, "Flushed")
        XCTAssertNotNil(flushed["sequence_id"] as? Int)
        var audio = 0
        for case .binary(let data) in events { audio += data.count }
        XCTAssertEqual(audio, 2 * 2 * GatedDriver.halfSamples, "all of the audio comes before Flushed")
        let asked = try XCTUnwrap(h.script.requests.last)
        XCTAssertEqual(asked.text, "Hello there")
        XCTAssertEqual(asked.voice, "af_nicole")
        ws.close()
        await h.live.stop()
    }

    func testS2_SpeakLiveAnswersAClearWithCleared() async throws {
        let h = try await startTtsServer(voices: voices)
        let ws = connect(h)
        _ = await ws.nextText()

        try await ws.send(json: ["type": "Clear"])
        let events = await ws.collect { $0.type == "Cleared" }

        let cleared = try XCTUnwrap(events.last?.object, "no Cleared arrived: \(events)")
        XCTAssertNotNil(cleared["sequence_id"] as? Int)
        ws.close()
        await h.live.stop()
    }

    /// `session-claim`: a connection with a different session id is refused by
    /// close code alone, as on the stream socket.
    func testS2_SpeakLiveRefusesADifferentSessionWithCloseCode4001AndNoFrame() async throws {
        let h = try await startTtsServer(voices: voices)
        let holder = connect(h, "&session=a")
        let metadata = await holder.nextText()
        XCTAssertEqual(metadata?.type, "Metadata", "the first session never started")

        let second = connect(h, "&session=b")
        let first = await second.next()

        XCTAssertEqual(first, .closed(4001))
        holder.close()
        await h.live.stop()
    }
}
