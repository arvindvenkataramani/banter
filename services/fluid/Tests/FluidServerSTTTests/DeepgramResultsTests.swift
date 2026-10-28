import XCTest

@testable import FluidServerSTT

/// Anarlog's parser drops a message it cannot decode, so a missing required
/// field loses the transcript silently. These pin the fields its types require.
final class DeepgramResultsTests: XCTestCase {
    private let words = [
        WordTiming(word: "Hello,", start: 0.0, end: 0.4),
        WordTiming(word: "world.", start: 0.5, end: 0.9),
    ]

    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    func testAStreamingResultCarriesEveryFieldTheClientRequires() throws {
        let json = DeepgramResults.streamResult(
            text: "Hello, world.", words: words, offset: 2.0, duration: 1.0,
            isFinal: true, speechFinal: true, fromFinalize: false, channels: 2,
            model: "parakeet", requestId: "r1")
        let msg = try object(json)
        XCTAssertEqual(msg["type"] as? String, "Results")
        for key in ["start", "duration", "is_final", "speech_final", "from_finalize", "channel", "metadata", "channel_index"] {
            XCTAssertNotNil(msg[key], "missing \(key)")
        }
        XCTAssertEqual(msg["channel_index"] as? [Int], [0, 2])
        let meta = try XCTUnwrap(msg["metadata"] as? [String: Any])
        for key in ["request_id", "model_info", "model_uuid"] { XCTAssertNotNil(meta[key], "metadata.\(key)") }
    }

    func testWordsAreOffsetByTheUtteranceStartAndSplitIntoBareAndPunctuatedForms() throws {
        let json = DeepgramResults.streamResult(
            text: "Hello, world.", words: words, offset: 2.0, duration: 1.0,
            isFinal: true, speechFinal: true, fromFinalize: false, channels: 1,
            model: "m", requestId: "r")
        let channel = try XCTUnwrap(try object(json)["channel"] as? [String: Any])
        let alt = try XCTUnwrap((channel["alternatives"] as? [[String: Any]])?.first)
        XCTAssertEqual(alt["transcript"] as? String, "Hello, world.")
        let w = try XCTUnwrap((alt["words"] as? [[String: Any]])?.first)
        XCTAssertEqual(w["word"] as? String, "hello")
        XCTAssertEqual(w["punctuated_word"] as? String, "Hello,")
        XCTAssertEqual(w["start"] as? Double ?? -1, 2.0, accuracy: 1e-9)
        XCTAssertNotNil(w["confidence"])
    }

    func testAnInterimResultIsNotFinal() throws {
        let json = DeepgramResults.streamResult(
            text: "hel", words: [], offset: 0, duration: 0.3,
            isFinal: false, speechFinal: false, fromFinalize: false, channels: 1,
            model: "m", requestId: "r")
        let msg = try object(json)
        XCTAssertEqual(msg["is_final"] as? Bool, false)
        XCTAssertEqual(msg["speech_final"] as? Bool, false)
    }

    func testABatchResponseHasMetadataAndOneChannelWithAlternatives() throws {
        let data = DeepgramResults.batchResponse(
            text: "Hello, world.", words: words, duration: 1.0, channels: 1,
            model: "m", requestId: "r")
        let msg = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(msg["metadata"])
        let results = try XCTUnwrap(msg["results"] as? [String: Any])
        let alt = try XCTUnwrap(
            ((results["channels"] as? [[String: Any]])?.first?["alternatives"] as? [[String: Any]])?.first)
        XCTAssertEqual(alt["transcript"] as? String, "Hello, world.")
        XCTAssertNotNil(alt["confidence"])
        XCTAssertEqual((alt["words"] as? [Any])?.count, 2)
    }
}
