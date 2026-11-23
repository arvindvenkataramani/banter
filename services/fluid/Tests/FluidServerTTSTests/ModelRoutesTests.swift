import FluidServerKit
import Foundation
import Logging
import XCTest

@testable import FluidServerTTS

/// `POST /v1/models?model_name=` and `POST /v1/models/load` are two spellings
/// of one load: the first is what mlx-audio answers and the dashboard sends.
final class ModelRoutesTests: XCTestCase {
    /// A roster loaded from a registry in the shape a server is launched with.
    private func makeRoster() throws -> TtsRoster {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("model-routes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("registry.json")
        try Data(
            """
            {"version": 4, "services": [{"id": "fluid-tts"}], "roster": {
              "ttsModels": [{"id": "slow-model", "name": "Slow"}],
              "providers": {"fluid-tts": {"resolvesVoices": true, "serves": [{"model": "slow-model", "key": "pocket-tts"}]}},
              "voices": []}}
            """.utf8
        ).write(to: file)
        return try TtsRoster.load(registry: file, provider: "fluid-tts")
    }

    private func makeHandlers() throws -> (APIHandlers, ResidentTtsModel) {
        let resident = ResidentTtsModel(
            modelsDirectory: nil,
            temporaryDirectory: FileManager.default.temporaryDirectory,
            logger: Logger(label: "test"),
            waitDeadline: .seconds(5),
            makeDriver: { _, _, _ in try await SlowStreamingDriver(modelsDirectory: nil) })
        let ctx = TtsAppContext(
            resident: resident, roster: try makeRoster(),
            logger: Logger(label: "test"),
            identity: AppIdentity(
                bundleIdentifier: "test.fluid-tts", shortVersion: "0.0.0", buildVersion: "test"))
        return (APIHandlers(ctx: ctx), resident)
    }

    func testLoadingByQueryMakesTheRosterModelResident() async throws {
        let (handlers, resident) = try makeHandlers()
        let output = try await handlers.loadModelByName(.init(query: .init(model_name: "slow-model")))
        guard case .ok = output else { return XCTFail("expected 200, got \(output)") }
        let loaded = await resident.currentModel
        XCTAssertEqual(loaded, "pocket-tts")
    }

    func testLoadingByQueryRefusesAModelTheRosterLacks() async throws {
        let (handlers, resident) = try makeHandlers()
        let output = try await handlers.loadModelByName(.init(query: .init(model_name: "nope")))
        guard case .badRequest = output else { return XCTFail("expected 400, got \(output)") }
        let loaded = await resident.currentModel
        XCTAssertNil(loaded)
    }

    func testBothSpellingsLoadTheSameModel() async throws {
        let (handlers, resident) = try makeHandlers()
        _ = try await handlers.loadModel(.init(body: .json(.init(model: "slow-model"))))
        let viaBody = await resident.currentModel
        _ = try await handlers.unloadModel(.init())
        _ = try await handlers.loadModelByName(.init(query: .init(model_name: "slow-model")))
        let viaQuery = await resident.currentModel
        XCTAssertEqual(viaBody, viaQuery)
    }
}
