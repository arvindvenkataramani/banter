import XCTest

@testable import FluidServerSTT

/// The query string is how a Deepgram client declares what its binary frames
/// are. A wrong reading reaches the model as noise, so each declared value is
/// pinned, and an encoding the server cannot decode is refused up front.
final class ListenQueryTests: XCTestCase {
    func testAnEmptyQueryMeansSixteenKilohertzMonoLinear16() throws {
        let query = try ListenQuery.parse([:])
        XCTAssertEqual(query.sampleRate, 16000)
        XCTAssertEqual(query.channels, 1)
    }

    func testDeclaredRateChannelsAndModelAreRead() throws {
        let query = try ListenQuery.parse([
            "sample_rate": "48000", "channels": "2", "model": "nova-3", "language": "en",
        ])
        XCTAssertEqual(query.sampleRate, 48000)
        XCTAssertEqual(query.channels, 2)
        XCTAssertEqual(query.model, "nova-3")
    }

    func testEndpointingMillisecondsAreRead() throws {
        XCTAssertEqual(try ListenQuery.parse(["endpointing": "300"]).endpointingMs, 300)
    }

    func testAnEncodingOtherThanLinear16IsRefused() {
        XCTAssertThrowsError(try ListenQuery.parse(["encoding": "opus"])) { error in
            guard case FluidServerSTTError.unsupportedEncoding("opus") = error else {
                return XCTFail("expected unsupportedEncoding(opus), got \(error)")
            }
        }
    }

    func testANonNumericRateIsRefusedRatherThanDefaulted() {
        XCTAssertThrowsError(try ListenQuery.parse(["sample_rate": "fast"]))
    }
}
