import Foundation
import XCTest

@testable import FluidServerSTT

/// `deepgram.listen.live` as `fluid-stt` conforms to it from S2 (spec section
/// 9, "`deepgram.listen.live` conformance"), driven over a real socket against
/// a model that needs no weights. The scripted model answers `scriptedText` for
/// any audio and nothing for none, which is what shows an utterance's audio
/// reached it and that an empty utterance was answered without one.
final class ListenRouteTests: XCTestCase {
    private func connect(_ h: SttHarness, _ query: String) -> WSClient {
        WSClient(url: h.live.wsURL("/v1/listen?\(query)"))
    }

    private let linear16 = "encoding=linear16&sample_rate=16000&channels=1&model=parakeet-unified-0.6b"

    // MARK: - Audio formats

    func testS2_Linear16AudioIsAcceptedAndReachesTheModel() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=false")
        try await ws.send(tone(ms: 300))
        try await ws.send(json: ["type": "Finalize"])

        let answer = try await ws.requireFinalizeResult()
        XCTAssertEqual(transcript(of: answer), scriptedText)
        ws.close()
        await h.live.stop()
    }

    func testS2_OpusPacketsAreAcceptedOnePerMessageAndReachTheModel() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "encoding=opus&sample_rate=48000&channels=1&model=parakeet-unified-0.6b&endpointing=false")
        try await ws.send(opusSilencePacket)
        try await ws.send(opusSilencePacket)
        try await ws.send(json: ["type": "Finalize"])

        let answer = try await ws.requireFinalizeResult()
        XCTAssertEqual(transcript(of: answer), scriptedText)
        ws.close()
        await h.live.stop()
    }

    func testS2_AnEncodingThePlatformCannotDecodeClosesWith4007AndSendsNoFrame() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "encoding=mulaw&sample_rate=8000&model=parakeet-unified-0.6b")

        let first = await ws.next()

        XCTAssertEqual(first, .closed(4007), "the first thing the client sees is the close")
        await h.live.stop()
    }

    // MARK: - Finalize

    /// One answer per `Finalize`, in order: with audio, with none since the
    /// last one, and with audio again. None of them is double-counted, and the
    /// empty one is still an answer.
    func testS2_EveryFinalizeIsAnsweredByExactlyOneFromFinalizeResultIncludingAnEmptyOne() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=false")

        try await ws.send(tone(ms: 300))
        try await ws.send(json: ["type": "Finalize"])
        let first = try await ws.requireFinalizeResult()
        try await ws.send(json: ["type": "Finalize"])
        let second = try await ws.requireFinalizeResult()
        try await ws.send(tone(ms: 300))
        try await ws.send(json: ["type": "Finalize"])
        let third = try await ws.requireFinalizeResult()

        XCTAssertEqual(transcript(of: first), scriptedText)
        XCTAssertEqual(transcript(of: second), "")
        XCTAssertEqual(transcript(of: third), scriptedText)
        let extra = await ws.nextFinalizeResult(timeout: .milliseconds(400))
        XCTAssertNil(extra, "a Finalize is answered once")
        ws.close()
        await h.live.stop()
    }

    // MARK: - Endpointing

    private func speechThenPause(_ ws: WSClient) async throws {
        try await ws.send(tone(ms: 500))
        try await ws.send(silence(ms: 700))
    }

    func testS2_APauseClosesTheUtteranceWhenEndpointingIsOn() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=300")
        try await speechThenPause(ws)

        var closing: [String: Any]?
        for _ in 0..<20 {
            guard let results = await ws.nextResults(timeout: .seconds(3)) else { break }
            if results["is_final"] as? Bool == true { closing = results; break }
        }

        let closed = try XCTUnwrap(closing, "no final after a pause longer than endpointing")
        XCTAssertEqual(closed["from_finalize"] as? Bool, false)
        XCTAssertEqual(transcript(of: closed), scriptedText)
        ws.close()
        await h.live.stop()
    }

    /// The other side of the same switch: `endpointing=false` leaves the
    /// utterance open however long the pause, until the client finalizes it.
    func testS2_EndpointingFalseLeavesTheUtteranceOpenThroughThePauseUntilFinalize() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=false")
        try await speechThenPause(ws)

        var closedByPause = false
        while let results = await ws.nextResults(timeout: .milliseconds(800)) {
            if results["is_final"] as? Bool == true { closedByPause = true }
        }
        XCTAssertFalse(closedByPause, "the server closed an utterance the client keeps open")

        try await ws.send(json: ["type": "Finalize"])
        let answer = try await ws.requireFinalizeResult()
        XCTAssertEqual(answer["is_final"] as? Bool, true)
        XCTAssertEqual(transcript(of: answer), scriptedText)
        ws.close()
        await h.live.stop()
    }

    // MARK: - Model

    /// The default model cannot stream, so a session that works is one whose
    /// `model` parameter chose the model.
    func testS2_TheModelParameterChoosesTheModelTheSessionRuns() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=false")
        try await ws.send(tone(ms: 200))
        try await ws.send(json: ["type": "Finalize"])

        let answer = try await ws.requireFinalizeResult()
        let info = (answer["metadata"] as? [String: Any])?["model_info"] as? [String: Any]
        XCTAssertEqual(info?["name"] as? String, "parakeet-unified-0.6b")
        let loaded = await h.resident.loadedId
        XCTAssertEqual(loaded, "parakeet-unified-0.6b")
        ws.close()
        await h.live.stop()
    }

    // MARK: - Claiming the server, as on the stream socket

    private func hold(_ h: SttHarness, session: String) async throws -> WSClient {
        let ws = connect(h, "\(linear16)&endpointing=false&session=\(session)")
        try await ws.send(json: ["type": "Finalize"])
        _ = try await ws.requireFinalizeResult()
        return ws
    }

    func testS2_ADifferentSessionIsRefusedWithCloseCode4001AndNoFrameAndTheHolderKeepsIt() async throws {
        let h = try await startSttServer()
        let holder = try await hold(h, session: "a")

        let second = connect(h, "\(linear16)&endpointing=false&session=b")
        let first = await second.next()

        XCTAssertEqual(first, .closed(4001))
        try await holder.send(json: ["type": "Finalize"])
        _ = try await holder.requireFinalizeResult()
        holder.close()
        await h.live.stop()
    }

    func testS2_ATakeoverDisplacesTheHolderWithCloseCode4002AndNoFrame() async throws {
        let h = try await startSttServer()
        let holder = try await hold(h, session: "a")

        let taker = connect(h, "\(linear16)&endpointing=false&session=b&takeover=1")
        try await taker.send(json: ["type": "Finalize"])

        _ = try await taker.requireFinalizeResult()
        let displaced = await holder.next()
        XCTAssertEqual(displaced, .closed(4002), "the displaced socket sees only its close")
        taker.close()
        await h.live.stop()
    }

    func testS2_TheSameSessionReconnectingClosesTheOldSocketWith4010AndNoFrame() async throws {
        let h = try await startSttServer()
        let holder = try await hold(h, session: "a")

        let again = connect(h, "\(linear16)&endpointing=false&session=a")
        try await again.send(json: ["type": "Finalize"])

        _ = try await again.requireFinalizeResult()
        let replaced = await holder.next()
        XCTAssertEqual(replaced, .closed(4010))
        again.close()
        await h.live.stop()
    }

    // MARK: - Messages the server cannot read

    func testS2_AKeepAliveIsAnsweredWithNothingAndTheStreamStaysOpen() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=false")

        try await ws.send(json: ["type": "KeepAlive"])
        let reply = await ws.nextText(timeout: .milliseconds(400))
        XCTAssertNil(reply, "a KeepAlive is answered with nothing")
        try await ws.send(tone(ms: 300))
        try await ws.send(json: ["type": "Finalize"])
        let answer = try await ws.requireFinalizeResult()
        XCTAssertEqual(transcript(of: answer), scriptedText)
        ws.close()
        await h.live.stop()
    }

    func testS2_ACloseStreamSendsThePendingResultAndThenClosesTheSocket() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=false")

        try await ws.send(tone(ms: 300))
        try await ws.send(json: ["type": "CloseStream"])
        let events = await ws.collect(timeout: .seconds(5)) { if case .closed = $0 { return true } else { return false } }

        let results = events.filter { $0.type == "Results" }
        XCTAssertEqual(results.compactMap { $0.object.flatMap(transcript(of:)) }.last, scriptedText, "\(events)")
        guard case .closed = try XCTUnwrap(events.last) else { return XCTFail("the socket stays open: \(events)") }
        await h.live.stop()
    }

    func testS2_AnUnparseableClientMessageGetsAnErrorMessageAndTheStreamStaysOpen() async throws {
        let h = try await startSttServer()
        let ws = connect(h, "\(linear16)&endpointing=false")

        try await ws.send("this is not json")

        let reply = try await ws.requireText()
        XCTAssertEqual(reply.type, "Error")
        try await ws.send(json: ["type": "Finalize"])
        _ = try await ws.requireFinalizeResult()
        ws.close()
        await h.live.stop()
    }
}
