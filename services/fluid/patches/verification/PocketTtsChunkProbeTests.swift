import Foundation
import XCTest

@testable import FluidAudio

/// Prints what PocketTTS is given, chunk by chunk, for every `.txt` file in the
/// verification directory, using the model's real tokenizer. Not part of any
/// PR: copy it into `Tests/FluidAudioTests/TTS/PocketTTS/` of a FluidAudio
/// checkout, run `swift test --filter PocketTtsChunkProbeTests`, then delete it.
///
/// A chunk whose token count is close to its character count is being
/// tokenized one character at a time, which the model speaks as garble.
final class PocketTtsChunkProbeTests: XCTestCase {
    func testPrintChunks() throws {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let tokenizerURL = home.appendingPathComponent(
            ".cache/fluidaudio/Models/pocket-tts/v2.1/english/constants_bin/tokenizer.model")
        guard FileManager.default.fileExists(atPath: tokenizerURL.path) else {
            throw XCTSkip("tokenizer.model not on disk; run the PocketTTS CLI once to download it")
        }
        let tokenizer = try SentencePieceTokenizer(modelData: Data(contentsOf: tokenizerURL))

        let directory =
            ProcessInfo.processInfo.environment["POCKET_PROBE_DIR"]
            ?? home.appendingPathComponent(
                "Code/airavatha/sutradhara/platform/services/fluid/patches/verification"
            ).path
        let files = try FileManager.default.contentsOfDirectory(atPath: directory)
            .filter { $0.hasPrefix("passage-") && $0.hasSuffix(".txt") }.sorted()

        for file in files {
            let text = try String(contentsOfFile: directory + "/" + file, encoding: .utf8)
            print("PROBE === \(file): \(tokenizer.encode(text).count) tokens as one string")
            for (index, chunk) in PocketTtsSynthesizer.chunkTextWithMetadata(
                text, tokenizer: tokenizer
            ).enumerated() {
                let (normalized, _) = PocketTtsSynthesizer.normalizeText(
                    chunk.text, isMidSentence: chunk.isMidSentence)
                let tokens = tokenizer.encode(normalized).count
                let characters = normalized.unicodeScalars.count
                let flag = tokens * 10 > characters * 8 ? "  <-- PER-CHARACTER" : ""
                print("PROBE chunk \(index + 1) [\(tokens) tokens, \(characters) chars]\(flag) :: \(normalized)")
            }
        }
    }
}
