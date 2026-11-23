import Foundation
import XCTest

@testable import FluidServerSTT

/// The roster names the model a request that names none loads. It is checked
/// with the rest of the roster at startup, so a bad default stops the server
/// rather than surfacing on the first request.
final class RosterDefaultTests: XCTestCase {
    private let entries = [
        RosterEntry(
            id: "unified", name: "Unified", key: "parakeet-unified-0.6b", kind: .both,
            params: nil, variants: nil),
        RosterEntry(
            id: "nemotron", name: "Nemotron", key: "nemotron-streaming-en-0.6b",
            kind: .streaming,
            params: [RosterParam(name: "chunkMs", values: [560])],
            variants: [RosterVariant(id: "560ms", params: [ParamBinding(name: "chunkMs", value: 560)])]),
    ]

    func testADefaultNamingAModelNotInTheRosterStopsStartup() {
        XCTAssertThrowsError(try Roster.validate(entries, defaultModel: "missing")) { error in
            guard case RosterError.defaultUnknown(let id) = error else {
                return XCTFail("expected defaultUnknown, got \(error)")
            }
            XCTAssertEqual(id, "missing")
        }
    }

    func testADefaultNamingAModelThatNeedsAParameterStopsStartup() {
        XCTAssertThrowsError(try Roster.validate(entries, defaultModel: "nemotron")) { error in
            guard case RosterError.defaultNeedsParameter(let id) = error else {
                return XCTFail("expected defaultNeedsParameter, got \(error)")
            }
            XCTAssertEqual(id, "nemotron")
        }
    }

    func testANonPositiveIdleUnloadFallsBackToTheDefaultAndIsReported() throws {
        let roster = try Roster.validate(entries, idleUnloadMs: 0)
        XCTAssertEqual(roster.idleUnload, .seconds(30 * 60))
        XCTAssertEqual(roster.idleUnloadRejected, 0)
    }

    func testANegativeIdleUnloadFallsBackToTheDefaultAndIsReported() throws {
        let roster = try Roster.validate(entries, idleUnloadMs: -5)
        XCTAssertEqual(roster.idleUnload, .seconds(30 * 60))
        XCTAssertEqual(roster.idleUnloadRejected, -5)
    }

    func testANonIntegerIdleUnloadInTheRegistryFallsBackRatherThanFailingTheRoster() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("roster-idle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("registry.json")
        try Data(
            """
            {"version": 4, "services": [], "roster": {
              "sttModels": [{"id": "unified", "name": "Unified", "kind": "both"}],
              "providers": {"fluid-stt": {
                "idleUnloadMs": "30m",
                "serves": [{"model": "unified", "key": "parakeet-unified-0.6b"}]
              }}, "voices": []}}
            """.utf8
        ).write(to: file)

        let roster = try Roster.load(registry: file, provider: "fluid-stt")

        XCTAssertEqual(roster.idleUnload, .seconds(30 * 60))
        XCTAssertNotNil(roster.idleUnloadRejected)
    }

    func testNoIdleUnloadDeclaredFallsBackToThirtyMinutes() throws {
        XCTAssertEqual(try Roster.validate(entries).idleUnload, .seconds(30 * 60))
    }

    func testTheDefaultIsReadFromTheProvidersBlockInTheRegistry() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("roster-default-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("registry.json")
        try Data(
            """
            {"version": 4, "services": [], "roster": {
              "sttModels": [{"id": "unified", "name": "Unified", "kind": "both"}],
              "providers": {"fluid-stt": {
                "defaultModel": "unified",
                "idleUnloadMs": 90000,
                "serves": [{"model": "unified", "key": "parakeet-unified-0.6b"}]
              }}, "voices": []}}
            """.utf8
        ).write(to: file)

        let roster = try Roster.load(registry: file, provider: "fluid-stt")

        XCTAssertEqual(roster.defaultModel?.id, "unified")
        XCTAssertEqual(roster.idleUnload, .milliseconds(90000))
    }
}
