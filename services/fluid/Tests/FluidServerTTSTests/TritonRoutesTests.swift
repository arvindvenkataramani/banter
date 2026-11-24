import FluidServerKit
import Foundation
import XCTest

@testable import FluidServerTTS

/// `triton.model-repository` with `resident-slot`, as `fluid-tts` serves it
/// (spec section 9, "Triton routes"). The model name on a route is the roster
/// id, and the server maps it to its runtime key: `kokoro-82m` is `kokoro-ane`.
/// Driven over a real socket against a stand-in driver.
final class TritonRoutesTests: XCTestCase {
    private func load(_ h: TtsHarness, _ name: String) async throws -> HttpReply {
        try await h.live.postJSON("/v2/repository/models/\(name)/load", ["parameters": [String: Any]()])
    }

    private func index(_ h: TtsHarness) async throws -> [[String: Any]] {
        let reply = try await h.live.postJSON("/v2/repository/index", [String: Any]())
        XCTAssertEqual(reply.status, 200)
        return try XCTUnwrap(reply.json as? [[String: Any]], "the index is a JSON array")
    }

    // The index's body is optional (Triton's extension), so a request with none
    // answers the index whether or not it names a JSON content type.
    func testS1_AnIndexRequestWithNoBodyAnswersTheIndex() async throws {
        let h = try await startTtsServer()
        for headers in [["Content-Type": "application/json"], [:]] {
            let reply = try await h.live.request("POST", "/v2/repository/index", headers: headers)
            XCTAssertEqual(reply.status, 200, "\(headers): \(reply.text)")
            let entries = try XCTUnwrap(reply.json as? [[String: Any]], "\(headers): the index is a JSON array")
            XCTAssertFalse(entries.isEmpty)
        }
        await h.live.stop()
    }

    func testS1_ALoadNamedByRosterIdMakesTheRuntimeKeyResident() async throws {
        let h = try await startTtsServer()
        let reply = try await load(h, "kokoro-82m")
        XCTAssertEqual(reply.status, 200, reply.text)
        let current = await h.resident.currentModel
        XCTAssertEqual(current, "kokoro-ane")
        await h.live.stop()
    }

    func testS1_ALoadOfAModelTheRosterLacksIsRefusedWith400NamingIt() async throws {
        let h = try await startTtsServer()
        let reply = try await load(h, "no-such-model")
        XCTAssertEqual(reply.status, 400)
        let message = try XCTUnwrap(reply.object?["error"] as? String, "a failure carries {\"error\": ...}")
        XCTAssertTrue(message.contains("no-such-model"), message)
        let current = await h.resident.currentModel
        XCTAssertNil(current)
        await h.live.stop()
    }

    /// Triton reloads a loaded model; `resident-slot` does not.
    func testS1_ALoadOfTheResidentModelIs200AndBuildsNothing() async throws {
        let h = try await startTtsServer()
        _ = try await load(h, "pocket")
        let again = try await load(h, "pocket")
        XCTAssertEqual(again.status, 200, again.text)
        XCTAssertEqual(h.script.builds, ["pocket-tts"])
        await h.live.stop()
    }

    func testS1_ALoadThatWouldChangeTheModelWhileAStreamHoldsTheServerIs409() async throws {
        let h = try await startTtsServer()
        _ = try await load(h, "pocket")
        let begun = try await h.resident.beginStream(synthesisRequest(text: "hold"))

        let reply = try await load(h, "kokoro-82m")

        XCTAssertEqual(reply.status, 409)
        let current = await h.resident.currentModel
        XCTAssertEqual(current, "pocket-tts")
        await h.resident.endStream(token: begun.token)
        h.script.open()
        await h.live.stop()
    }

    func testS1_AnUnloadEmptiesTheServerAndTheIndexShowsIt() async throws {
        let h = try await startTtsServer()
        _ = try await load(h, "pocket")

        let reply = try await h.live.postJSON("/v2/repository/models/pocket/unload", [String: Any]())

        XCTAssertEqual(reply.status, 200, reply.text)
        let current = await h.resident.currentModel
        XCTAssertNil(current)
        let ready = try await index(h).filter { $0["state"] as? String == "READY" }
        XCTAssertTrue(ready.isEmpty)
        await h.live.stop()
    }

    func testS1_TheIndexListsEveryRosterModelReadyOnlyForTheResidentOne() async throws {
        let h = try await startTtsServer()
        _ = try await load(h, "kokoro-82m")

        let entries = try await index(h)

        XCTAssertEqual(Set(entries.compactMap { $0["name"] as? String }), ["pocket", "kokoro-82m"])
        for entry in entries {
            XCTAssertNotNil(entry["reason"] as? String, "each entry carries a reason: \(entry)")
            let expected = entry["name"] as? String == "kokoro-82m" ? "READY" : "UNAVAILABLE"
            XCTAssertEqual(entry["state"] as? String, expected, "\(entry)")
        }
        await h.live.stop()
    }
}
