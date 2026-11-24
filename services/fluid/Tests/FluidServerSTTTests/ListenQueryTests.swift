import Foundation
import XCTest

@testable import FluidServerSTT

/// The query string is how a Deepgram client declares what its binary frames
/// are. A wrong reading reaches the model as noise, so each declared value is
/// pinned, and an encoding the server cannot decode is refused up front.
///
/// INVENTED seams (see dev/plans/service-apis-run/inventions.md):
/// `ListenQuery.endpointingMs` is nil when the client sent `endpointing=false`,
/// and `ListenQuery.parse(_:provisions:)` reads the default for an absent
/// `endpointing` from the entry's `deepgram.listen.live` provision, falling
/// back to Deepgram's own default of 10 ms when `provisions` is omitted or
/// declares none.
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

    func testS2_OpusAndLinear16AreAcceptedAndAnyOtherEncodingIsRefused() {
        XCTAssertNoThrow(try ListenQuery.parse(["encoding": "opus"]))
        XCTAssertNoThrow(try ListenQuery.parse(["encoding": "linear16"]))
        XCTAssertThrowsError(try ListenQuery.parse(["encoding": "mulaw"])) { error in
            guard case FluidServerSTTError.unsupportedEncoding("mulaw") = error else {
                return XCTFail("expected unsupportedEncoding(mulaw), got \(error)")
            }
        }
    }

    func testS2_EndpointingFalseTurnsTheSegmenterOff() throws {
        let query = try ListenQuery.parse(["endpointing": "false"])
        XCTAssertNil(query.endpointingMs)
    }

    func testANonNumericRateIsRefusedRatherThanDefaulted() {
        XCTAssertThrowsError(try ListenQuery.parse(["sample_rate": "fast"]))
    }

    // MARK: - The default comes from the provision

    private var exampleURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("registry.fluid.example.json")
            .standardizedFileURL
    }

    /// The example registry with its `deepgram.listen.live` default for
    /// `endpointing` replaced by `milliseconds`, or as it is when nil.
    private func provisions(endpointing milliseconds: Int?) throws -> Provisions {
        var file = exampleURL
        if let milliseconds {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("listen-defaults-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
            var root = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(contentsOf: exampleURL)) as? [String: Any])
            var services = try XCTUnwrap(root["services"] as? [[String: Any]])
            let at = try XCTUnwrap(services.firstIndex { $0["id"] as? String == "fluid-stt" })
            var provides = try XCTUnwrap(services[at]["provides"] as? [[String: Any]])
            let live = try XCTUnwrap(provides.firstIndex { $0["api"] as? String == "deepgram.listen.live" })
            provides[live]["defaults"] = ["endpointing": milliseconds]
            services[at]["provides"] = provides
            root["services"] = services
            file = directory.appendingPathComponent("registry.json")
            try JSONSerialization.data(withJSONObject: root).write(to: file)
        }
        return try Provisions.load(registry: file, provider: "fluid-stt")
    }

    /// Nothing in the server holds the number: the declared value is the
    /// default, whichever it is, and a client that sends one overrides it.
    func testS2_TheEndpointingDefaultIsWhatTheListenProvisionDeclares() throws {
        XCTAssertEqual(try ListenQuery.parse([:], provisions: provisions(endpointing: nil)).endpointingMs, 700)
        XCTAssertEqual(try ListenQuery.parse([:], provisions: provisions(endpointing: 300)).endpointingMs, 300)
        XCTAssertEqual(
            try ListenQuery.parse(["endpointing": "450"], provisions: provisions(endpointing: 300)).endpointingMs,
            450)
    }

    func testS2_WithNoDeclaredDefaultDeepgramsOwnTenMillisecondsApplies() throws {
        XCTAssertEqual(try ListenQuery.parse([:]).endpointingMs, 10)
    }
}
