import Foundation
import XCTest

@testable import FluidServerTTS

/// Startup refuses an unimplemented extension (spec section 9, Startup), and the
/// Deepgram speak route's encoding default is the provision's alone.
final class ProsecutionTests: XCTestCase {
    private var exampleURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("registry.fluid.example.json")
            .standardizedFileURL
    }

    /// The example with `edit` applied to the `fluid-tts` provision of `api`.
    private func registry(editing api: String, _ edit: (inout [String: Any]) -> Void) throws -> URL {
        var root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: exampleURL)) as? [String: Any])
        var services = try XCTUnwrap(root["services"] as? [[String: Any]])
        let at = try XCTUnwrap(services.firstIndex { $0["id"] as? String == "fluid-tts" })
        var provides = try XCTUnwrap(services[at]["provides"] as? [[String: Any]])
        let index = try XCTUnwrap(provides.firstIndex { $0["api"] as? String == api })
        edit(&provides[index])
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

    /// `stream-flag` is not implemented: speech streams with no flag.
    func testP1_StartupRefusesAnEntryClaimingAnExtensionTheBuildDoesNotImplement() throws {
        let file = try registry(editing: "openai.audio.speech") { provision in
            provision["extends"] = (provision["extends"] as? [String] ?? []) + ["stream-flag"]
        }
        XCTAssertThrowsError(try Provisions.load(registry: file, provider: "fluid-tts")) { error in
            XCTAssertTrue(String(describing: error).contains("stream-flag"), "\(error)")
        }
    }

    func testP1_TheSpeakEncodingDefaultIsWhatTheProvisionDeclares() throws {
        let declared = try Provisions.load(registry: exampleURL, provider: "fluid-tts")
        XCTAssertEqual(declared.speakEncoding, "aac")
    }

    /// With none declared, the spec's own default applies; restricts is not a default.
    func testP1_WithNoDeclaredDefaultTheSpeakEncodingIsNotTakenFromRestricts() throws {
        let file = try registry(editing: "deepgram.speak") { $0.removeValue(forKey: "defaults") }
        let undeclared = try Provisions.load(registry: file, provider: "fluid-tts")
        XCTAssertNil(undeclared.speakEncoding)
    }
}
