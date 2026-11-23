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

    private let services = #""version": 4, "services": [{"id": "fluid-tts"}]"#

    func testLoadsTheProvidersModelsFromTheRosterSection() throws {
        let file = try registry(
            """
            {\(services), "roster": {
              "ttsModels": [
                {"id": "pocket-tts", "name": "Pocket-TTS"},
                {"id": "kokoro-82m", "name": "Kokoro 82M"},
                {"id": "chatterbox", "name": "Chatterbox"}
              ],
              "providers": {
                "fluid-tts": {"resolvesVoices": true, "serves": [
                  {"model": "pocket-tts", "key": "pocket-tts"},
                  {"model": "kokoro-82m", "key": "kokoro-ane"}
                ]},
                "tts-mlx-audio": {"resolvesVoices": false, "serves": [
                  {"model": "chatterbox", "key": "mlx-community/chatterbox-turbo-fp16"}
                ]}
              },
              "voices": []}}
            """)
        let roster = try TtsRoster.load(registry: file, provider: "fluid-tts")
        // The models are the top-level ones this provider serves, each named by
        // the serving's key; another runtime's servings are none of its business.
        XCTAssertEqual(roster.models.map(\.id), ["pocket-tts", "kokoro-82m"])
        XCTAssertEqual(roster.key(for: "kokoro-82m"), "kokoro-ane")
        XCTAssertNil(roster.key(for: "chatterbox"))
    }

    func testLoadsTheVoicesAndTheirRenderingsFromTheTopLevel() throws {
        let file = try registry(
            """
            {\(services), "roster": {
              "ttsModels": [{"id": "kokoro-82m", "name": "Kokoro 82M"}],
              "providers": {"fluid-tts": {"resolvesVoices": true, "serves": [{"model": "kokoro-82m", "key": "kokoro-ane"}]}},
              "voices": [{"id": "nicole", "name": "Nicole",
                "renderings": [{"model": "kokoro-82m", "method": "preset", "key": "af_nicole"}]}]}}
            """)
        let roster = try TtsRoster.load(registry: file, provider: "fluid-tts")
        XCTAssertEqual(try roster.resolve(voice: "nicole", model: "kokoro-82m"), .preset("af_nicole"))
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
        let file = try registry(#"{\#(services), "roster": {"ttsModels": [], "providers": {}, "voices": []}}"#)
        XCTAssertThrowsError(try TtsRoster.load(registry: file, provider: "fluid-tts")) { error in
            guard case TtsRosterError.noSuchProvider(let id, let path) = error else {
                return XCTFail("expected noSuchProvider, got \(error)")
            }
            XCTAssertEqual(path, file.path)
            XCTAssertEqual(id, "fluid-tts")
        }
    }

    /// The fluid entries an install merges into the registry this server is
    /// launched with come from the fluid example, so it has to load.
    func testTheFluidExampleRegistryLoads() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("registry.fluid.example.json")
            .standardizedFileURL
        let roster = try TtsRoster.load(registry: file, provider: "fluid-tts")
        XCTAssertFalse(roster.models.isEmpty)
    }
}
