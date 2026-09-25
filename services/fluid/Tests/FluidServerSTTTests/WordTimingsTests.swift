import FluidAudio
import XCTest

@testable import FluidServerSTT

/// Word grouping is where the two tokenizers disagree, and where getting it
/// wrong produces timings that look fine and cannot be aligned against a
/// reference transcript. It is pure logic over decoder output, so it is
/// checkable without loading a model.
final class WordTimingsTests: XCTestCase {
    private func token(_ text: String, _ start: Double, _ end: Double) -> TokenTiming {
        TokenTiming(token: text, tokenId: 0, startTime: start, endTime: end, confidence: 1.0)
    }

    // MARK: - Parakeet: a leading space opens a word

    /// "Bethany" arrives as three sub-word tokens; only the first carries the
    /// space that marks a word boundary.
    func testSubWordTokensJoinIntoOneWord() {
        let words = mergeTokensIntoWords([
            token(" Bet", 0.0, 0.1), token("h", 0.1, 0.2), token("any", 0.2, 0.4),
        ])
        XCTAssertEqual(words.map(\.word), ["Bet" + "h" + "any"])
        XCTAssertEqual(words.first?.word, "Bethany")
    }

    /// A word spans from the start of its first token to the end of its last.
    func testAWordSpansFromItsFirstTokenToItsLast() {
        let words = mergeTokensIntoWords([
            token(" Bet", 0.0, 0.1), token("h", 0.1, 0.2), token("any", 0.2, 0.4),
        ])
        XCTAssertEqual(words.first?.start, 0.0)
        XCTAssertEqual(words.first?.end, 0.4)
    }

    func testEachLeadingSpaceOpensANewWord() {
        let words = mergeTokensIntoWords([
            token(" one", 0.0, 0.2), token(" two", 0.2, 0.4), token(" three", 0.4, 0.6),
        ])
        XCTAssertEqual(words.map(\.word), ["one", "two", "three"])
        XCTAssertEqual(words.map(\.start), [0.0, 0.2, 0.4])
    }

    /// Stripping a token before testing it destroys the boundary signal and
    /// yields sub-word fragments labelled as words. This is that failure.
    func testContinuationTokensDoNotOpenWords() {
        let words = mergeTokensIntoWords([
            token(" walk", 0.0, 0.2), token("ing", 0.2, 0.3), token(" home", 0.3, 0.5),
        ])
        XCTAssertEqual(words.map(\.word), ["walking", "home"])
    }

    // MARK: - Nemotron: U+2581 marks the boundary, and one token holds many words

    /// Testing only for whitespace returned Nemotron's entire transcript as a
    /// single "word" — correct text, useless timings.
    func testAMarkedTokenSplitsIntoSeveralWords() {
        let words = mergeTokensIntoWords([
            token("\u{2581}the\u{2581}stones\u{2581}stand", 0.0, 1.2)
        ])
        XCTAssertEqual(words.map(\.word), ["the", "stones", "stand"])
    }

    /// A token spanning several words can only be timed across its own span, so
    /// its words share it. Coarser than per-token timings, and the honest
    /// resolution of what the model reported.
    func testWordsFromOneTokenShareThatTokensSpan() {
        let words = mergeTokensIntoWords([
            token("\u{2581}the\u{2581}stones", 0.5, 1.5)
        ])
        XCTAssertEqual(words.count, 2)
        for word in words {
            XCTAssertEqual(word.start, 0.5)
            XCTAssertEqual(word.end, 1.5)
        }
    }

    func testMarkedTokensAcrossSeveralCallsKeepTheirOwnSpans() {
        let words = mergeTokensIntoWords([
            token("\u{2581}first\u{2581}part", 0.0, 1.0),
            token("\u{2581}second", 1.0, 1.6),
        ])
        XCTAssertEqual(words.map(\.word), ["first", "part", "second"])
        XCTAssertEqual(words.last?.start, 1.0)
        XCTAssertEqual(words.last?.end, 1.6)
    }

    // MARK: - Edges

    func testNoTokensProduceNoWords() {
        XCTAssertTrue(mergeTokensIntoWords([]).isEmpty)
    }

    /// A token with no leading space and nothing before it still opens a word,
    /// rather than being dropped for want of a boundary.
    func testAFirstTokenWithoutASpaceStillOpensAWord() {
        let words = mergeTokensIntoWords([token("hello", 0.0, 0.3)])
        XCTAssertEqual(words.map(\.word), ["hello"])
    }

    /// A whitespace-only token is itself the boundary; dropping it would join
    /// the words on either side.
    func testAWhitespaceOnlyTokenSeparatesTheWordsAroundIt() {
        let words = mergeTokensIntoWords([
            token("stone", 0.0, 0.2), token(" ", 0.2, 0.21), token("circle", 0.21, 0.5),
        ])
        XCTAssertEqual(words.map(\.word), ["stone", "circle"])
    }

    /// Timestamps are quantised to the model's frame rate; three decimals keeps
    /// that precision without float noise from an unrounded division.
    func testTimestampsAreRoundedToMilliseconds() {
        let words = mergeTokensIntoWords([
            token(" word", 0.1234567, 0.7654321)
        ])
        XCTAssertEqual(words.first?.start, 0.123)
        XCTAssertEqual(words.first?.end, 0.765)
    }
}
