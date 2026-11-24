import Foundation
import XCTest

@testable import FluidServerSTT

/// From S3 the Triton routes are the only way to load or unload a model on
/// `fluid-stt` (spec section 9). The four spellings they replaced are gone, and
/// the listing and health routes stay.
final class ModelRoutesTests: XCTestCase {
    func testS3_TheOldLoadAndUnloadRoutesAreGoneAndLoadNothing() async throws {
        let h = try await startSttServer()
        let body = try JSONSerialization.data(withJSONObject: ["model": "parakeet-tdt-v3"])
        let routes: [(method: String, path: String)] = [
            ("POST", "/v1/models/load"),
            ("POST", "/v1/models?model_name=parakeet-tdt-v3"),
            ("POST", "/v1/models/unload"),
            ("DELETE", "/v1/models"),
        ]

        var answers: [String] = []
        for route in routes {
            let reply = try await h.live.request(
                route.method, route.path, headers: ["Content-Type": "application/json"], body: body)
            answers.append("\(route.method) \(route.path) \(reply.status)")
        }

        XCTAssertEqual(
            answers, routes.map { "\($0.method) \($0.path) 404" },
            "every old spelling should be a 404")
        let loaded = await h.resident.loadedId
        XCTAssertNil(loaded, "a removed route must not have loaded anything")
        await h.live.stop()
    }

    func testS3_TheModelListingAndHealthRoutesStay() async throws {
        let h = try await startSttServer()
        let listing = try await h.live.request("GET", "/v1/models")
        let health = try await h.live.request("GET", "/healthz")
        XCTAssertEqual(listing.status, 200)
        XCTAssertEqual(health.status, 200)
        await h.live.stop()
    }
}
