import Foundation
import XCTest

@testable import FluidServerSTT

/// A server reads its own registry entry's `provides` at startup and refuses to
/// run when the entry claims more than its build serves: an API the build does
/// not provide, or a part of one it lacks that the entry does not list as
/// omitted. Spec section 9.
///
/// INVENTED seam (see dev/plans/service-apis-run/inventions.md): the spec names
/// the startup check and not the function that performs it. These tests call
/// `Provisions.load(registry:provider:)`, which throws when the check refuses
/// and returns what the entry declares otherwise.
final class ProvisionsTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("provisions-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var exampleURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("registry.fluid.example.json")
            .standardizedFileURL
    }

    /// The example registry with `edit` applied to the `fluid-stt` entry's
    /// provision of `api`, written where the server can be pointed at it.
    private func registry(
        editing api: String? = nil, adding extra: [String: Any]? = nil,
        _ edit: (inout [String: Any]) -> Void = { _ in }
    ) throws -> URL {
        let data = try Data(contentsOf: exampleURL)
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var services = try XCTUnwrap(root["services"] as? [[String: Any]])
        let at = try XCTUnwrap(services.firstIndex { $0["id"] as? String == "fluid-stt" })
        var provides = services[at]["provides"] as? [[String: Any]] ?? []
        if let api {
            let index = try XCTUnwrap(
                provides.firstIndex { $0["api"] as? String == api }, "the example has no \(api)")
            edit(&provides[index])
        }
        if let extra { provides.append(extra) }
        services[at]["provides"] = provides
        root["services"] = services
        let file = directory.appendingPathComponent("registry.json")
        try JSONSerialization.data(withJSONObject: root).write(to: file)
        return file
    }

    func testS1_StartupAcceptsTheFluidExampleEntry() throws {
        XCTAssertNoThrow(try Provisions.load(registry: exampleURL, provider: "fluid-stt"))
    }

    /// `openai.audio.speech` is what `fluid-tts` serves; this build never does.
    func testS1_StartupRefusesAnEntryClaimingAnApiTheBuildDoesNotServe() throws {
        let file = try registry(adding: ["api": "openai.audio.speech"])
        XCTAssertThrowsError(try Provisions.load(registry: file, provider: "fluid-stt")) { error in
            XCTAssertTrue(
                String(describing: error).contains("openai.audio.speech"),
                "the refusal should name the API: \(error)")
        }
    }

    /// The build ignores `keywords`, so an entry that stops listing it as omitted
    /// would claim a part the build lacks.
    func testS1_StartupRefusesAnEntryThatOmitsLessThanTheBuildLacks() throws {
        let file = try registry(editing: "openai.audio.transcriptions") { provision in
            var omits = provision["omits"] as? [String] ?? []
            omits.removeAll { $0 == "parameter:keywords" }
            provision["omits"] = omits
        }
        XCTAssertThrowsError(try Provisions.load(registry: file, provider: "fluid-stt")) { error in
            XCTAssertTrue(
                String(describing: error).contains("parameter:keywords"),
                "the refusal should name the part: \(error)")
        }
    }

    /// The other side of the same threshold: claiming less than the build
    /// serves is a conservative entry, not a false one.
    func testS1_StartupAcceptsAnEntryThatOmitsMoreThanTheBuildLacks() throws {
        let file = try registry(editing: "openai.audio.transcriptions") { provision in
            var omits = provision["omits"] as? [String] ?? []
            omits.append("parameter:timestamp_granularities")
            provision["omits"] = omits
        }
        XCTAssertNoThrow(try Provisions.load(registry: file, provider: "fluid-stt"))
    }

    /// `only` states the same thing by complement: listing just what the build
    /// implements is accepted, so S2's Realtime provisions can use it.
    func testS1_StartupAcceptsAnEntryWhoseOnlyLeavesOutWhatTheBuildLacks() throws {
        let file = try registry(editing: "openai.audio.transcriptions") { provision in
            provision["omits"] = ["value:timestamp_granularities=segment"]
            provision["only"] = [
                "parameter:file", "parameter:model", "parameter:response_format",
                "parameter:timestamp_granularities",
            ]
        }
        XCTAssertNoThrow(try Provisions.load(registry: file, provider: "fluid-stt"))
    }

    func testS1_StartupRefusesAnEntryWhoseOnlyIncludesAPartTheBuildLacks() throws {
        let file = try registry(editing: "openai.audio.transcriptions") { provision in
            provision["omits"] = ["value:timestamp_granularities=segment"]
            provision["only"] = [
                "parameter:file", "parameter:model", "parameter:response_format",
                "parameter:timestamp_granularities", "parameter:keywords",
            ]
        }
        XCTAssertThrowsError(try Provisions.load(registry: file, provider: "fluid-stt")) { error in
            XCTAssertTrue(
                String(describing: error).contains("parameter:keywords"),
                "the refusal should name the part: \(error)")
        }
    }
}
