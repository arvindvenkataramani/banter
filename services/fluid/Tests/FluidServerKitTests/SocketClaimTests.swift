import XCTest

@testable import FluidServerKit

// The API these tests hold `SocketClaim` to:
//
//   public enum DisplacedReason: Equatable, Sendable { case replaced, takenOver }
//   public enum SocketClaimError: Error { case held }
//   public struct ClaimToken: Hashable, Sendable
//
//   public actor SocketClaim {
//       public init()
//       /// Grants the claim or throws `SocketClaimError.held`. A displaced
//       /// holder's `onDisplaced` has been awaited by the time this returns.
//       public func claim(
//           session: String?,
//           takeover: Bool = false,
//           onDisplaced: @escaping @Sendable (DisplacedReason) async -> Void = { _ in }
//       ) async throws -> ClaimToken
//       /// Frees the claim if `token` still holds it; a displaced holder's
//       /// release does nothing.
//       public func release(token: ClaimToken)
//   }

/// One streaming connection holds the server at a time, and the session id
/// decides who that is.
final class SocketClaimTests: XCTestCase {
    /// The same session on a new socket is its own reconnect: the client has
    /// already abandoned the old socket, so it is closed, not defended.
    func testTheHoldersOwnSessionIsGrantedAndTheHolderIsReplaced() async throws {
        let claim = SocketClaim()
        let told = Told()
        _ = try await claim.claim(session: "a", onDisplaced: { await told.record($0) })
        _ = try await claim.claim(session: "a")
        let reasons = await told.reasons
        XCTAssertEqual(reasons, [.replaced])
    }

    /// Another session is refused without disturbing the holder: the person
    /// decides whether to take it, not the server.
    func testAnotherSessionIsRefusedAndTheHolderKeepsTheClaim() async throws {
        let claim = SocketClaim()
        let told = Told()
        _ = try await claim.claim(session: "a", onDisplaced: { await told.record($0) })
        for newcomer in ["b", "c"] {
            do {
                _ = try await claim.claim(session: newcomer)
                XCTFail("session \(newcomer) was granted a claim held by a")
            } catch let error as SocketClaimError {
                guard case .held = error else { return XCTFail("expected held, got \(error)") }
            }
        }
        let reasons = await told.reasons
        XCTAssertTrue(reasons.isEmpty)
    }

    func testAnotherSessionThatTakesOverIsGrantedAndTheHolderIsTakenOver() async throws {
        let claim = SocketClaim()
        let told = Told()
        _ = try await claim.claim(session: "a", onDisplaced: { await told.record($0) })
        _ = try await claim.claim(session: "b", takeover: true)
        let reasons = await told.reasons
        XCTAssertEqual(reasons, [.takenOver])
    }

    /// A connection without an id has an identity of its own, so two of them
    /// never match.
    func testAHolderWithoutASessionRefusesANewcomerWithoutOne() async throws {
        let claim = SocketClaim()
        let told = Told()
        _ = try await claim.claim(session: nil, onDisplaced: { await told.record($0) })
        do {
            _ = try await claim.claim(session: nil)
            XCTFail("a connection without a session matched another without one")
        } catch let error as SocketClaimError {
            guard case .held = error else { return XCTFail("expected held, got \(error)") }
        }
        let reasons = await told.reasons
        XCTAssertTrue(reasons.isEmpty)
    }

    func testAfterReleaseAnyNewcomerIsGranted() async throws {
        let claim = SocketClaim()
        let first = try await claim.claim(session: "a")
        await claim.release(token: first)
        let second = try await claim.claim(session: "b")
        await claim.release(token: second)
        _ = try await claim.claim(session: nil)
    }
}

/// Records why a holder was displaced, for the assertions above.
private actor Told {
    private(set) var reasons: [DisplacedReason] = []
    func record(_ reason: DisplacedReason) { reasons.append(reason) }
}
