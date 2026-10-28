import XCTest

@testable import FluidServerSTT

/// The managers consume 16 kHz mono floats. A Deepgram client declares its own
/// rate and channel count, so the decoder is where a mismatch becomes either
/// correct audio or plausible-sounding garbage.
final class Linear16DecoderTests: XCTestCase {
    private func int16Bytes(_ values: [Int16]) -> [UInt8] {
        values.flatMap { v -> [UInt8] in
            let u = UInt16(bitPattern: v)
            return [UInt8(u & 0xFF), UInt8(u >> 8)]
        }
    }

    func testSixteenKilohertzMonoPassesThroughUnchanged() {
        let decoder = Linear16Decoder(sampleRate: 16000, channels: 1)
        let out = decoder.decode(int16Bytes([0, 16384, -16384]))
        XCTAssertEqual(out, [0, 0.5, -0.5])
    }

    func testFortyEightKilohertzYieldsAThirdAsManySamples() {
        let decoder = Linear16Decoder(sampleRate: 48000, channels: 1)
        let out = decoder.decode(int16Bytes([Int16](repeating: 8192, count: 4800)))
        XCTAssertEqual(out.count, 1600, accuracy: 2)
        XCTAssertEqual(out.last ?? 0, 0.25, accuracy: 1e-3, "a constant level survives resampling")
    }

    func testInterleavedChannelsAreAveragedToMono() {
        let decoder = Linear16DecoderTests.stereo()
        let out = decoder.decode(int16Bytes([16384, 0, 16384, 0]))
        XCTAssertEqual(out, [0.25, 0.25])
    }

    /// Frames split anywhere. A sample cut across two frames must be joined, not
    /// dropped or read as two half samples.
    func testASampleSplitAcrossFramesIsJoined() {
        let decoder = Linear16Decoder(sampleRate: 16000, channels: 1)
        let bytes = int16Bytes([16384, 16384])
        let first = decoder.decode(Array(bytes[0..<3]))
        let second = decoder.decode(Array(bytes[3..<4]))
        XCTAssertEqual(first + second, [0.5, 0.5])
    }

    private static func stereo() -> Linear16Decoder {
        Linear16Decoder(sampleRate: 16000, channels: 2)
    }
}
