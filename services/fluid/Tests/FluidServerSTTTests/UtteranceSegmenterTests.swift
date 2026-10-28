import XCTest

@testable import FluidServerSTT

/// A Deepgram client expects finals as it goes; the server decides where an
/// utterance ends by listening for a pause after speech. Silence alone must
/// never close anything, or an idle meeting would emit empty finals forever.
final class UtteranceSegmenterTests: XCTestCase {
    private let rate = 16000
    private func speech(ms: Int) -> [Float] {
        (0..<(rate * ms / 1000)).map { Float(sin(Double($0) * 0.2)) * 0.3 }
    }
    private func silence(ms: Int) -> [Float] {
        [Float](repeating: 0, count: rate * ms / 1000)
    }

    func testAPauseLongerThanEndpointingAfterSpeechEndsTheUtterance() {
        var segmenter = UtteranceSegmenter(endpointingMs: 500)
        XCTAssertFalse(segmenter.feed(speech(ms: 1000)))
        XCTAssertTrue(segmenter.feed(silence(ms: 600)))
    }

    func testAPauseShorterThanEndpointingDoesNotEndIt() {
        var segmenter = UtteranceSegmenter(endpointingMs: 500)
        _ = segmenter.feed(speech(ms: 1000))
        XCTAssertFalse(segmenter.feed(silence(ms: 400)))
    }

    func testSilenceWithoutPriorSpeechNeverEndsAnUtterance() {
        var segmenter = UtteranceSegmenter(endpointingMs: 500)
        XCTAssertFalse(segmenter.feed(silence(ms: 5000)))
    }

    func testSpeechResumingBeforeThePauseCompletesResetsTheCount() {
        var segmenter = UtteranceSegmenter(endpointingMs: 500)
        _ = segmenter.feed(speech(ms: 500))
        _ = segmenter.feed(silence(ms: 400))
        _ = segmenter.feed(speech(ms: 200))
        XCTAssertFalse(segmenter.feed(silence(ms: 400)))
    }

    func testTheNextUtteranceIsDetectedAfterOneEnds() {
        var segmenter = UtteranceSegmenter(endpointingMs: 500)
        _ = segmenter.feed(speech(ms: 500))
        XCTAssertTrue(segmenter.feed(silence(ms: 600)))
        _ = segmenter.feed(speech(ms: 500))
        XCTAssertTrue(segmenter.feed(silence(ms: 600)))
    }
}
