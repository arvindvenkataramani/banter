import FluidAudio
import Foundation

/// One word and the span of audio it was spoken over.
struct WordTiming: Codable {
    let word: String
    let start: Double
    let end: Double
}

/// Group Parakeet's sub-word tokens into whole words.
///
/// The TDT decoder emits sentencepiece tokens, so "Bethany" arrives as `" Bet"`,
/// `"h"`, `"any"` — three timed tokens, not one word. A token that begins a new
/// word carries a leading space; continuation tokens do not. parakeet-mlx uses
/// the same test to build its own sentences, so this reads the boundary the
/// tokenizer actually encodes rather than guessing from the text.
///
/// Stripping a token before testing it destroys that signal and yields
/// sub-word fragments labelled as words, which is the failure mode this exists
/// to avoid: timestamps that cannot be aligned against a reference transcript.
///
/// A word spans from the start of its first token to the end of its last.
/// SentencePiece's word-boundary marker (U+2581), which Nemotron's tokenizer
/// emits where Parakeet's uses a leading space.
private let wordMarker: Character = "\u{2581}"

func mergeTokensIntoWords(_ timings: [TokenTiming]) -> [WordTiming] {
    var words: [WordTiming] = []
    var text = ""
    var start = 0.0
    var end = 0.0

    func flush() {
        guard !text.isEmpty else { return }
        words.append(WordTiming(word: text, start: start.roundedToMillis, end: end.roundedToMillis))
    }

    for timing in timings {
        // Two tokenizers reach here and they mark a word boundary differently.
        // Parakeet's sub-word tokens carry a leading space. Nemotron's carry
        // SentencePiece's "▁" instead, and it emits whole spans rather than one
        // token per sub-word, so a single token can hold several words. Testing
        // only for whitespace returned Nemotron's entire transcript as one
        // "word": correct text, useless timings.
        let marked = timing.token.contains(wordMarker)
        let startsWord = marked || (timing.token.first?.isWhitespace ?? false)

        // A token spanning several words can only be timed across its own span,
        // so its words share it. That is coarser than Parakeet's per-token
        // timings and is the honest resolution of what the model reported.
        let pieces =
            marked
            ? timing.token.split(separator: wordMarker).map(String.init)
            : [timing.token.trimmingCharacters(in: .whitespacesAndNewlines)]

        for (index, piece) in pieces.enumerated() {
            let trimmed = piece.trimmingCharacters(in: .whitespacesAndNewlines)

            // Every piece after the first began at a marker, so it always opens
            // a word. The first opens one only if its own token did.
            //
            // An empty piece is not skipped: a token that is only whitespace is
            // itself the boundary, and dropping it would join the words either
            // side of it.
            let opensWord = index > 0 || startsWord
            if opensWord || text.isEmpty {
                flush()
                text = trimmed
                start = timing.startTime
            } else {
                text += trimmed
            }
            end = timing.endTime
        }
    }
    flush()

    return words
}

extension Double {
    /// Timestamps are quantised to the model's frame rate; three decimals keeps
    /// that precision without the float noise of an unrounded division.
    fileprivate var roundedToMillis: Double { (self * 1000).rounded() / 1000 }
}
