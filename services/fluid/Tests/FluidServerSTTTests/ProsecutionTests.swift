import Foundation
import XCTest

@testable import FluidServerSTT

/// The startup check also refuses an entry claiming an extension the build does
/// not implement for that API (spec section 9, Startup).
final class ProsecutionTests: XCTestCase {
    private var exampleURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("registry.fluid.example.json")
            .standardizedFileURL
    }

    /// The example with `extension` added to the `fluid-stt` provision of `api`.
    private func registry(extending api: String, with extension: String) throws -> URL {
        var root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: exampleURL)) as? [String: Any])
        var services = try XCTUnwrap(root["services"] as? [[String: Any]])
        let at = try XCTUnwrap(services.firstIndex { $0["id"] as? String == "fluid-stt" })
        var provides = try XCTUnwrap(services[at]["provides"] as? [[String: Any]])
        let index = try XCTUnwrap(provides.firstIndex { $0["api"] as? String == api })
        provides[index]["extends"] = (provides[index]["extends"] as? [String] ?? []) + [`extension`]
        services[at]["provides"] = provides
        root["services"] = services
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("prosecution-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("registry.json")
        try JSONSerialization.data(withJSONObject: root).write(to: file)
        return file
    }

    func testP1_StartupRefusesAnEntryClaimingAnExtensionTheBuildDoesNotImplement() throws {
        let file = try registry(extending: "openai.audio.transcriptions", with: "session-claim")
        XCTAssertThrowsError(try Provisions.load(registry: file, provider: "fluid-stt")) { error in
            XCTAssertTrue(String(describing: error).contains("session-claim"), "\(error)")
        }
    }

    /// An extension the build implements for one API is not implemented for another.
    func testP1_AnExtensionIsCheckedPerApi() throws {
        let file = try registry(extending: "fluid.stt.stream", with: "opus-input")
        XCTAssertThrowsError(try Provisions.load(registry: file, provider: "fluid-stt"))
    }

    func testP1_TheExampleEntrysExtensionsAreAccepted() {
        XCTAssertNoThrow(try Provisions.load(registry: exampleURL, provider: "fluid-stt"))
    }
}
