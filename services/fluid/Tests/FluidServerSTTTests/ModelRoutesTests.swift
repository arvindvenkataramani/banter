import Foundation
import Logging
import XCTest

@testable import FluidServerSTT

/// `POST /v1/models?model_name=` is the synthesis server's spelling of a load,
/// answered here too so a client written against one reads the other. Loading
/// a real model needs its weights, so these check the route resolves through
/// the roster rather than what a load makes resident.
final class ModelRoutesTests: XCTestCase {
    private func makeHandlers() throws -> APIHandlers {
        let roster = try Roster.validate([
            RosterEntry(
                id: "unified", name: "Unified", key: "parakeet-unified-0.6b", kind: .both,
                params: nil, variants: nil)
        ])
        let resident = ResidentModel(roster: roster, logger: Logger(label: "test"))
        return APIHandlers(ctx: AppContext(resident: resident, logger: Logger(label: "test")))
    }

    func testLoadingByQueryRefusesAModelTheRosterLacks() async throws {
        let handlers = try makeHandlers()
        let output = try await handlers.loadModelByName(.init(query: .init(model_name: "nope")))
        guard case .badRequest(let response) = output else {
            return XCTFail("expected 400, got \(output)")
        }
        guard case .json(let body) = response.body else { return XCTFail("expected a JSON body") }
        XCTAssertTrue(body.error.contains("nope"), "the refusal should name the model: \(body.error)")
    }

    /// A model capable of both modes has to be told which, and the query form
    /// carries no mode, so it is refused rather than guessed.
    func testLoadingByQueryRefusesAModelThatNeedsAMode() async throws {
        let handlers = try makeHandlers()
        let output = try await handlers.loadModelByName(.init(query: .init(model_name: "unified")))
        guard case .badRequest = output else { return XCTFail("expected 400, got \(output)") }
    }
}
