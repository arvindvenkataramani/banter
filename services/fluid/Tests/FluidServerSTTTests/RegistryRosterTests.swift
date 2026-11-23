import Foundation
import XCTest

@testable import FluidServerSTT

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

    private let services = #""version": 4, "services": [{"id": "fluid-stt"}]"#

    func testLoadsTheProvidersModelsFromTheRosterSection() throws {
        let file = try registry(
            """
            {\(services), "roster": {
              "sttModels": [
                {"id": "parakeet-tdt-v3", "name": "Parakeet TDT v3", "kind": "batch"},
                {"id": "whisper-large-v3-turbo", "name": "Whisper", "kind": "batch"}
              ],
              "providers": {
                "fluid-stt": {"serves": [{"model": "parakeet-tdt-v3", "key": "parakeet-tdt-v3"}]},
                "stt-whisper": {"serves": [{"model": "whisper-large-v3-turbo", "key": "mlx-community/whisper-large-v3-turbo"}]}
              },
              "voices": []}}
            """)
        let roster = try Roster.load(registry: file, provider: "fluid-stt")
        // Top-level models, narrowed to the ones this provider serves.
        XCTAssertEqual(roster.models.map(\.id), ["parakeet-tdt-v3"])
    }

    func testARegistryWithNoRosterSectionFailsNamingThePathAndProvider() throws {
        let file = try registry("{\(services)}")
        XCTAssertThrowsError(try Roster.load(registry: file, provider: "fluid-stt")) { error in
            guard case RosterError.noRoster(let path, let provider) = error else {
                return XCTFail("expected noRoster, got \(error)")
            }
            XCTAssertEqual(path, file.path)
            XCTAssertEqual(provider, "fluid-stt")
        }
    }

    func testAMissingProviderFailsNamingThePathAndProvider() throws {
        let file = try registry(#"{\#(services), "roster": {"sttModels": [], "providers": {}, "voices": []}}"#)
        XCTAssertThrowsError(try Roster.load(registry: file, provider: "fluid-stt")) { error in
            guard case RosterError.noSuchProvider(let id, let path) = error else {
                return XCTFail("expected noSuchProvider, got \(error)")
            }
            XCTAssertEqual(path, file.path)
            XCTAssertEqual(id, "fluid-stt")
        }
    }

    /// The fluid entries an install merges into the registry this server is
    /// launched with come from the fluid example, so it has to load.
    func testTheFluidExampleRegistryLoads() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("registry.fluid.example.json")
            .standardizedFileURL
        let roster = try Roster.load(registry: file, provider: "fluid-stt")
        XCTAssertFalse(roster.models.isEmpty)
    }
}
