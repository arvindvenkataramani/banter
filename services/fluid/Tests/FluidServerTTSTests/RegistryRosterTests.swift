import Foundation
import XCTest

@testable import FluidServerTTS

/// The server reads its models from the `roster` section of the node's
/// registry, under its own provider id.
final class RegistryRosterTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("registry-roster-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func registry(_ json: String) throws -> URL {
        let file = directory.appendingPathComponent("registry.json")
        try Data(json.utf8).write(to: file)
        return file
    }

    private let services = #""version": 2, "services": [{"id": "fluid-tts"}]"#

    func testLoadsTheProvidersModelsFromTheRosterSection() throws {
        let file = try registry(
            """
            {\(services), "roster": {"providers": {"fluid-tts": {"responseFormat": "json", "ttsModels": [
              {"id": "pocket-tts", "name": "Pocket-TTS", "key": "pocket-tts"}
            ]}}, "voices": {}}}
            """)
        let roster = try TtsRoster.load(registry: file, provider: "fluid-tts")
        XCTAssertEqual(roster.models.map(\.id), ["pocket-tts"])
    }

    func testARegistryWithNoRosterSectionFailsNamingThePathAndProvider() throws {
        let file = try registry("{\(services)}")
        XCTAssertThrowsError(try TtsRoster.load(registry: file, provider: "fluid-tts")) { error in
            guard case TtsRosterError.noRoster(let path, let provider) = error else {
                return XCTFail("expected noRoster, got \(error)")
            }
            XCTAssertEqual(path, file.path)
            XCTAssertEqual(provider, "fluid-tts")
        }
    }

    func testAMissingProviderFailsNamingThePathAndProvider() throws {
        let file = try registry(#"{\#(services), "roster": {"providers": {}, "voices": {}}}"#)
        XCTAssertThrowsError(try TtsRoster.load(registry: file, provider: "fluid-tts")) { error in
            guard case TtsRosterError.noSuchProvider(let id, let path) = error else {
                return XCTFail("expected noSuchProvider, got \(error)")
            }
            XCTAssertEqual(path, file.path)
            XCTAssertEqual(id, "fluid-tts")
        }
    }

    /// An install copies one of the shipped examples to the registry this server
    /// is launched with, so each has to load.
    func testTheShippedExampleRegistriesLoad() throws {
        let repo = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../..")
        for node in ["control-plane", "control-shard"] {
            let file = repo.appendingPathComponent("control/\(node)/data/registry.example.json")
                .standardizedFileURL
            let roster = try TtsRoster.load(registry: file, provider: "fluid-tts")
            XCTAssertFalse(roster.models.isEmpty, node)
        }
    }
}
