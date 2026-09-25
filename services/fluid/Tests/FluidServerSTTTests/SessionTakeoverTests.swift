import FluidAudio
import FluidServerKit
import Logging
import XCTest

@testable import FluidServerSTT

/// Who holds a live streaming session follows the claim in `FluidServerKit`:
/// the session id decides, and the model a connection expects is checked
/// before the claim, so a request that will be refused leaves the live
/// session alone.
///
/// The resident model is a Nemotron manager built without its weights: a
/// session begins and ends with a reset, which needs no loaded model, and
/// nothing here transcribes.
final class SessionTakeoverTests: XCTestCase {
    /// Records why the connection holding the session was displaced, if it
    /// was.
    private actor Told {
        private(set) var reasons: [DisplacedReason] = []
        func record(_ reason: DisplacedReason) { reasons.append(reason) }
    }

    private func makeResident() async throws -> ResidentModel {
        let tiers = [560, 1120].map {
            RosterVariant(id: "\($0)ms", params: [ParamBinding(name: "chunkMs", value: $0)])
        }
        let roster = try Roster.validate([
            RosterEntry(
                id: "nemotron", name: "Nemotron", key: "nemotron-streaming-en-0.6b",
                kind: .streaming,
                params: [RosterParam(name: "chunkMs", values: [560, 1120])], variants: tiers),
            RosterEntry(
                id: "tdt", name: "TDT", key: "parakeet-tdt-v3", kind: .batch,
                params: nil, variants: nil),
        ])
        let resident = ResidentModel(roster: roster, logger: Logger(label: "test"))
        try await resident.slot.load(id: "nemotron", variant: "1120ms") {
            .nemotron(
                id: "nemotron", manager: StreamingNemotronAsrManager(requestedChunkSize: .ms1120),
                chunkMs: 1120)
        }
        return resident
    }

    func testAConnectionExpectingAnotherModelLeavesTheLiveSessionAlone() async throws {
        let resident = try await makeResident()
        let told = Told()
        let live = try await resident.beginSession(
            expecting: "nemotron", session: "a", onDisplaced: { await told.record($0) })

        do {
            try await resident.beginSession(expecting: "tdt", session: "b")
            XCTFail("a connection expecting a model that is not loaded should be refused")
        } catch FluidServerSTTError.modelMismatch(let requested, let loaded) {
            XCTAssertEqual(requested, "tdt")
            XCTAssertEqual(loaded, "nemotron")
        }

        let reasons = await told.reasons
        XCTAssertTrue(reasons.isEmpty, "the refused connection should not have taken the session")
        let stillHeld = await resident.endSession(token: live.token, claim: live.claim)
        XCTAssertTrue(stillHeld, "the live session should still hold the slot")
    }

    func testAConnectionExpectingAnUnknownModelLeavesTheLiveSessionAlone() async throws {
        let resident = try await makeResident()
        let told = Told()
        let live = try await resident.beginSession(
            expecting: "nemotron", session: "a", onDisplaced: { await told.record($0) })

        do {
            try await resident.beginSession(expecting: "nope", session: "b")
            XCTFail("a connection expecting an unknown model should be refused")
        } catch FluidServerSTTError.unknownModel(let id) {
            XCTAssertEqual(id, "nope")
        }

        let reasons = await told.reasons
        XCTAssertTrue(reasons.isEmpty)
        let stillHeld = await resident.endSession(token: live.token, claim: live.claim)
        XCTAssertTrue(stillHeld)
    }

    /// The same session reconnecting is its own takeover: the client has
    /// abandoned the old socket, so it is replaced without being asked.
    func testTheHoldersOwnSessionReconnectingReplacesIt() async throws {
        let resident = try await makeResident()
        let told = Told()
        let live = try await resident.beginSession(
            expecting: "nemotron", session: "a", onDisplaced: { await told.record($0) })

        let newer = try await resident.beginSession(expecting: "nemotron", session: "a")

        let reasons = await told.reasons
        XCTAssertEqual(reasons, [.replaced])
        let oldStillHeld = await resident.endSession(token: live.token, claim: live.claim)
        XCTAssertFalse(oldStillHeld, "the replaced session should no longer hold the slot")
        let newerHeld = await resident.endSession(token: newer.token, claim: newer.claim)
        XCTAssertTrue(newerHeld)
    }

    /// A different session is refused without disturbing the holder: the
    /// person decides whether to take it over, not the server.
    func testADifferentSessionIsRefusedHeldAndTheHolderKeepsIt() async throws {
        let resident = try await makeResident()
        let told = Told()
        let live = try await resident.beginSession(
            expecting: "nemotron", session: "a", onDisplaced: { await told.record($0) })

        do {
            _ = try await resident.beginSession(expecting: "nemotron", session: "b")
            XCTFail("session b was granted a claim held by a")
        } catch SocketClaimError.held {
            // expected
        }

        let reasons = await told.reasons
        XCTAssertTrue(reasons.isEmpty)
        let stillHeld = await resident.endSession(token: live.token, claim: live.claim)
        XCTAssertTrue(stillHeld)
    }

    /// `takeover` grants a different session the claim and tells the holder it
    /// was taken over, distinct from its own session reconnecting.
    func testADifferentSessionWithTakeoverTakesTheClaimOver() async throws {
        let resident = try await makeResident()
        let told = Told()
        let live = try await resident.beginSession(
            expecting: "nemotron", session: "a", onDisplaced: { await told.record($0) })

        let newer = try await resident.beginSession(
            expecting: "nemotron", session: "b", takeover: true)

        let reasons = await told.reasons
        XCTAssertEqual(reasons, [.takenOver])
        let oldStillHeld = await resident.endSession(token: live.token, claim: live.claim)
        XCTAssertFalse(oldStillHeld, "the taken-over session should no longer hold the slot")
        let newerHeld = await resident.endSession(token: newer.token, claim: newer.claim)
        XCTAssertTrue(newerHeld)
    }
}
