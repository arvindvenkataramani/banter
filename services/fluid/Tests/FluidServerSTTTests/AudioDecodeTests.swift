import XCTest

@testable import FluidServerSTT

/// The pcm16 path is byte arithmetic over what a browser's `Int16Array` puts on
/// the wire. Getting the endianness or the scale wrong yields audio that is
/// quiet, loud, or noise — all of which reach the model as *something*, so
/// nothing downstream reports the mistake.
final class AudioDecodeTests: XCTestCase {
    private func decoder() throws -> AudioDecoder {
        try AudioDecoder(format: .pcm16)
    }

    /// Little-endian, as a browser serialises it: low byte first.
    func testSamplesAreReadLittleEndian() throws {
        // 0x0100 little-endian is 256.
        let samples = try decoder().decode([0x00, 0x01])
        XCTAssertEqual(samples.count, 1)
        XCTAssertEqual(samples[0], 256.0 / 32768.0, accuracy: 1e-6)
    }

    func testFullScaleNegativeReachesMinusOne() throws {
        // Int16.min is 0x8000.
        let samples = try decoder().decode([0x00, 0x80])
        XCTAssertEqual(samples[0], -1.0, accuracy: 1e-6)
    }

    func testFullScalePositiveIsJustUnderOne() throws {
        // Int16.max over 32768 — the scale divides by 32768, not 32767, so this
        // lands just below 1.0 rather than exactly on it.
        let samples = try decoder().decode([0xFF, 0x7F])
        XCTAssertEqual(samples[0], 32767.0 / 32768.0, accuracy: 1e-6)
    }

    func testSilenceDecodesToZero() throws {
        let samples = try decoder().decode([UInt8](repeating: 0, count: 8))
        XCTAssertEqual(samples, [0, 0, 0, 0])
    }

    func testEachPairOfBytesIsOneSample() throws {
        let samples = try decoder().decode([UInt8](repeating: 0, count: 320))
        XCTAssertEqual(samples.count, 160, "10 ms at 16 kHz")
    }

    func testAnEmptyFrameDecodesToNoSamples() throws {
        XCTAssertTrue(try decoder().decode([]).isEmpty)
    }

    /// A trailing odd byte would be half a sample. The framing does not produce
    /// one, and a decoder that read past it would walk off the end.
    func testATrailingOddByteIsIgnoredRatherThanRead() throws {
        let samples = try decoder().decode([0x00, 0x01, 0x7F])
        XCTAssertEqual(samples.count, 1)
    }

    func testSampleOrderIsPreserved() throws {
        let samples = try decoder().decode([0x00, 0x01, 0x00, 0x02, 0x00, 0x03])
        XCTAssertEqual(samples.count, 3)
        XCTAssertLessThan(samples[0], samples[1])
        XCTAssertLessThan(samples[1], samples[2])
    }

    // MARK: - Format selection

    func testTheWireNamesForEachFormat() {
        XCTAssertEqual(AudioFormat(rawValue: "pcm16"), .pcm16)
        XCTAssertEqual(AudioFormat(rawValue: "opus"), .opus)
        XCTAssertNil(AudioFormat(rawValue: "mp3"))
    }
}
