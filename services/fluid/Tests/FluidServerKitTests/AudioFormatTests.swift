import Foundation
import XCTest

@testable import FluidServerKit

/// The wire contract: one container per response, whatever the codec.
///
/// A per-interval container repeats its header at every seam, which is what
/// makes a streamed response unplayable by a client that expects one stream.
/// These tests hold the encoders to emitting a header once and frames after it.
final class AudioFormatTests: XCTestCase {
    private func tone(seconds: Double, sampleRate: Int) -> [Float] {
        (0..<Int(seconds * Double(sampleRate))).map {
            sin(2.0 * .pi * 220.0 * Float($0) / Float(sampleRate)) * 0.3
        }
    }

    // MARK: - Format selection

    func testKnownFormatsResolveAndUnknownOnesDoNot() {
        XCTAssertEqual(AudioFormat(requested: "aac"), .aac)
        XCTAssertEqual(AudioFormat(requested: "wav"), .wav)
        // Absent means the default rather than an error: most callers do not
        // name a format and the server has to pick one.
        XCTAssertEqual(AudioFormat(requested: nil), .aac)
        // A format the server cannot produce must be refused rather than
        // silently served as something else — returning WAV to a caller that
        // asked for mp3 is what makes a broken stream look like a working one.
        XCTAssertNil(AudioFormat(requested: "mp3"))
        XCTAssertNil(AudioFormat(requested: "flac"))
    }

    func testEachFormatCarriesItsOwnContentType() {
        XCTAssertEqual(AudioFormat.aac.contentType, "audio/aac")
        XCTAssertEqual(AudioFormat.wav.contentType, "audio/wav")
    }

    // MARK: - WAV: one header per response

    func testWavStreamWritesOneHeaderThenRawSamples() throws {
        let encoder = try makeEncoder(format: .wav, sampleRate: 24000)
        let first = try encoder.encode(tone(seconds: 0.1, sampleRate: 24000))
        let second = try encoder.encode(tone(seconds: 0.1, sampleRate: 24000))
        _ = try encoder.finish()

        XCTAssertEqual(first.prefix(4).map { $0 }, Array("RIFF".utf8))
        // The second emission is audio, not another file. A `RIFF` here is the
        // per-chunk-container bug this contract exists to prevent.
        XCTAssertNotEqual(second.prefix(4).map { $0 }, Array("RIFF".utf8))
        XCTAssertEqual(second.count, 2400 * 2, "0.1s at 24kHz as 16-bit PCM")
    }

    func testWavStreamDeclaresAnUndeterminedLengthUpFront() throws {
        // The total is unknown when the header goes out, so the size fields
        // carry the streaming sentinel rather than a number that will be wrong.
        let encoder = try makeEncoder(format: .wav, sampleRate: 24000)
        let header = try encoder.encode(tone(seconds: 0.05, sampleRate: 24000))
        let riffSize = header.withUnsafeBytes {
            $0.loadUnaligned(fromByteOffset: 4, as: UInt32.self).littleEndian
        }
        XCTAssertEqual(riffSize, UInt32.max)
    }

    // MARK: - AAC: one ADTS stream per response

    func testAacStreamEmitsAdtsFramesWithSyncWords() throws {
        let encoder = try makeEncoder(format: .aac, sampleRate: 24000)
        var out = Data()
        // Several intervals, as a real response produces.
        for _ in 0..<4 { out.append(try encoder.encode(tone(seconds: 0.5, sampleRate: 24000))) }
        out.append(try encoder.finish())

        XCTAssertGreaterThan(out.count, 0, "the encoder produced no audio")
        // Every ADTS frame opens with a 12-bit sync word, 0xFFF. The first byte
        // of the response being one is what makes the stream self-delimiting.
        XCTAssertEqual(out[0], 0xFF)
        XCTAssertEqual(out[1] & 0xF0, 0xF0)
    }

    func testAacFramesTileTheStreamWithNoBytesBetweenThem() throws {
        // Walking the stream by each frame's declared length has to land exactly
        // on the end. A gap or overlap means something other than ADTS frames is
        // on the wire, which is what a per-chunk container would produce.
        let encoder = try makeEncoder(format: .aac, sampleRate: 24000)
        var out = Data()
        for _ in 0..<3 { out.append(try encoder.encode(tone(seconds: 0.5, sampleRate: 24000))) }
        out.append(try encoder.finish())

        var offset = 0
        var frames = 0
        while offset + 7 <= out.count {
            XCTAssertEqual(out[offset], 0xFF, "frame \(frames) does not start with a sync word")
            // Frame length is 13 bits spanning bytes 3-5 of the header.
            let length =
                (Int(out[offset + 3] & 0x03) << 11) | (Int(out[offset + 4]) << 3)
                | (Int(out[offset + 5] & 0xE0) >> 5)
            XCTAssertGreaterThan(length, 7, "frame \(frames) declares no payload")
            offset += length
            frames += 1
        }
        XCTAssertEqual(offset, out.count, "frames do not tile the stream exactly")
        XCTAssertGreaterThan(frames, 1, "expected several frames across three intervals")
    }

    /// The encoder must carry the whole utterance, not the first fraction of it.
    ///
    /// AudioToolbox's converter pulls until its input callback reports
    /// exhaustion; a callback staged with one packet at a time says so after
    /// the first, and the converter stops. The result is valid AAC of the right
    /// codec and sample rate that is a twentieth of the length it should be —
    /// which every structural check above passes.
    func testAacCarriesTheFullDurationOfTheInput() throws {
        let sampleRate = 24000
        let encoder = try makeEncoder(format: .aac, sampleRate: sampleRate)
        var out = Data()
        // Six seconds, as an ordinary utterance runs, in 0.5s intervals.
        for _ in 0..<12 {
            out.append(try encoder.encode(tone(seconds: 0.5, sampleRate: sampleRate)))
        }
        out.append(try encoder.finish())

        // Each ADTS frame carries 1024 samples, so frame count fixes duration.
        var offset = 0
        var frames = 0
        while offset + 7 <= out.count {
            let length =
                (Int(out[offset + 3] & 0x03) << 11) | (Int(out[offset + 4]) << 3)
                | (Int(out[offset + 5] & 0xE0) >> 5)
            guard length > 7 else { break }
            offset += length
            frames += 1
        }
        let seconds = Double(frames * 1024) / Double(sampleRate)
        // Encoder priming and packet padding move this by a frame or two; a
        // truncation bug moves it by an order of magnitude.
        XCTAssertEqual(
            seconds, 6.0, accuracy: 0.2,
            "encoded \(String(format: "%.2f", seconds))s of a 6.0s input")
    }

    func testAacEncodesWhatTheModelProduces() throws {
        // 24 kHz mono is Pocket-TTS's output, and an encoder that cannot take it
        // would push a resample into every response.
        XCTAssertNoThrow(try makeEncoder(format: .aac, sampleRate: 24000))
    }

    func testFinishIsSafeWhenNothingWasEncoded() throws {
        // A request that fails before generating anything still runs the flush
        // on its way out.
        let encoder = try makeEncoder(format: .aac, sampleRate: 24000)
        XCTAssertNoThrow(try encoder.finish())
    }
}
