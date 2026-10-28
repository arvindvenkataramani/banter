import Foundation
import XCTest

@testable import FluidServerKit

/// Locations are derived from an injected identifier — never the test
/// runner's own bundle identity, which would make these tests depend on how
/// they happen to be invoked.
final class AppLocationsTests: XCTestCase {
    private func testIdentifier() -> String {
        "com.banter.test.\(UUID().uuidString)"
    }

    func testEachLocationIsKeyedByTheIdentifier() {
        let id = testIdentifier()
        let locations = AppLocations(identifier: id)

        XCTAssertEqual(locations.caches.lastPathComponent, id)
        XCTAssertEqual(locations.applicationSupport.lastPathComponent, id)
        XCTAssertEqual(locations.temporary.lastPathComponent, id)
        XCTAssertTrue(locations.caches.path.contains("/Library/Caches/"))
        XCTAssertTrue(locations.applicationSupport.path.contains("/Library/Application Support/"))
    }

    func testPrepareCreatesAnEmptyTemporaryDirectory() throws {
        let locations = AppLocations(identifier: testIdentifier())
        defer { try? FileManager.default.removeItem(at: locations.temporary) }

        try locations.prepareTemporaryDirectory()

        var isDirectory: ObjCBool = false
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: locations.temporary.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
        let contents = try FileManager.default.contentsOfDirectory(atPath: locations.temporary.path)
        XCTAssertTrue(contents.isEmpty)
    }

    func testPrepareEmptiesWhateverAPreviousRunLeftBehind() throws {
        let locations = AppLocations(identifier: testIdentifier())
        defer { try? FileManager.default.removeItem(at: locations.temporary) }

        try FileManager.default.createDirectory(
            at: locations.temporary, withIntermediateDirectories: true)
        let leftover = locations.temporary.appendingPathComponent("leftover.wav")
        try Data().write(to: leftover)

        try locations.prepareTemporaryDirectory()

        let contents = try FileManager.default.contentsOfDirectory(atPath: locations.temporary.path)
        XCTAssertTrue(contents.isEmpty)
    }

    /// Only the temp subdirectory is created at startup; caches and
    /// Application Support are exposed but left for whatever writes to them —
    /// CoreML, in the case of caches — to create.
    func testPrepareDoesNotCreateCachesOrApplicationSupport() throws {
        let locations = AppLocations(identifier: testIdentifier())
        defer { try? FileManager.default.removeItem(at: locations.temporary) }

        try locations.prepareTemporaryDirectory()

        XCTAssertFalse(FileManager.default.fileExists(atPath: locations.caches.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: locations.applicationSupport.path))
    }
}

/// `AppIdentity` reads a bundle's info dictionary, or falls back when the
/// process has none — a bare `swift run`, or a test host.
final class AppIdentityTests: XCTestCase {
    func testInitFromInfoFailsWhenAnyFieldIsMissing() {
        XCTAssertNil(AppIdentity(info: nil))
        XCTAssertNil(AppIdentity(info: ["CFBundleIdentifier": "com.banter.fluid-stt"]))
    }

    func testResolveFallsBackToTheExecutableNameWhenNoIdentityIsFound() {
        let identity = AppIdentity.resolve(info: nil, executableName: "fluid-stt")
        XCTAssertEqual(identity.bundleIdentifier, "fluid-stt")
        XCTAssertEqual(identity.shortVersion, "unknown")
        XCTAssertEqual(identity.buildVersion, "unknown")
    }

    func testResolvePrefersARealIdentityOverTheFallback() {
        let identity = AppIdentity.resolve(
            info: [
                "CFBundleIdentifier": "com.banter.fluid-stt",
                "CFBundleShortVersionString": "0.1.0",
                "CFBundleVersion": "abc123",
            ], executableName: "fluid-stt")
        XCTAssertEqual(identity.bundleIdentifier, "com.banter.fluid-stt")
        XCTAssertEqual(identity.shortVersion, "0.1.0")
        XCTAssertEqual(identity.buildVersion, "abc123")
    }

    func testReadsAllThreeFieldsWhenPresent() {
        let identity = AppIdentity(
            bundleIdentifier: "com.banter.fluid-tts", shortVersion: "0.1.0", buildVersion: "abc123")
        XCTAssertEqual(identity.bundleIdentifier, "com.banter.fluid-tts")
        XCTAssertEqual(identity.shortVersion, "0.1.0")
        XCTAssertEqual(identity.buildVersion, "abc123")
    }
}
