import FluidServerKit
import Foundation
import Logging
import XCTest

@testable import FluidServerTTS

/// `POST /v1/models?model_name=` and `POST /v1/models/load` are two spellings
/// of one load: the first is what mlx-audio answers and the dashboard sends.
final class ModelRoutesTests: XCTestCase {
    private func makeHandlers() -> (APIHandlers, ResidentTtsModel) {
        let resident = ResidentTtsModel(
            modelsDirectory: nil,
            logger: Logger(label: "test"),
            waitDeadline: .seconds(5),
            makeDriver: { _, _ in try await SlowStreamingDriver(modelsDirectory: nil) })
        let entry = TtsRosterEntry(
            id: "slow-model", name: "Slow", key: "slow",
            cloning: nil, chunkProfile: nil, presetVoices: nil)
        let ctx = TtsAppContext(
            resident: resident, roster: TtsRoster(models: [ValidatedTtsModel(entry: entry)]),
            logger: Logger(label: "test"))
        return (APIHandlers(ctx: ctx), resident)
    }

    func testLoadingByQueryMakesTheRosterModelResident() async throws {
        let (handlers, resident) = makeHandlers()
        let output = try await handlers.loadModelByName(.init(query: .init(model_name: "slow-model")))
        guard case .ok = output else { return XCTFail("expected 200, got \(output)") }
        let loaded = await resident.currentModel
        XCTAssertEqual(loaded, "slow")
    }

    func testLoadingByQueryRefusesAModelTheRosterLacks() async throws {
        let (handlers, resident) = makeHandlers()
        let output = try await handlers.loadModelByName(.init(query: .init(model_name: "nope")))
        guard case .badRequest = output else { return XCTFail("expected 400, got \(output)") }
        let loaded = await resident.currentModel
        XCTAssertNil(loaded)
    }

    func testBothSpellingsLoadTheSameModel() async throws {
        let (handlers, resident) = makeHandlers()
        _ = try await handlers.loadModel(.init(body: .json(.init(model: "slow-model"))))
        let viaBody = await resident.currentModel
        _ = try await handlers.unloadModel(.init())
        _ = try await handlers.loadModelByName(.init(query: .init(model_name: "slow-model")))
        let viaQuery = await resident.currentModel
        XCTAssertEqual(viaBody, viaQuery)
    }
}
