import Foundation

/// Why a displaced holder's socket is closing.
public enum DisplacedReason: Equatable, Sendable {
    /// The same session opened a new socket; the old one is abandoned.
    case replaced
    /// A different session took the claim over.
    case takenOver
}

public enum SocketClaimError: Error, Sendable {
    /// Another session holds the claim and this connection did not ask to
    /// take it over.
    case held
}

/// Identifies one grant of the claim, so a release only ever frees the grant
/// it was given for.
public struct ClaimToken: Hashable, Sendable {
    private let id: UUID
    fileprivate init() { self.id = UUID() }
}

/// One streaming connection holds a server at a time, and the session id says
/// who that is.
///
/// `fluid-stt` and `fluid-tts` each keep one of these per server: a socket
/// opening consults it before taking any model work, and releases it on every
/// path out. It holds connections, not model work — the model's own slot
/// (`ResidentSlot`) is a separate lock the claimed connection then uses.
///
/// A session id is the caller's own identity, chosen by the client and opaque
/// here. `nil` means the connection has no identity of its own, so it can
/// never be recognised as a reconnect — only ever a newcomer, refused or
/// granted like any other.
public actor SocketClaim {
    private var holder:
        (session: String?, token: ClaimToken, onDisplaced: @Sendable (DisplacedReason) async -> Void)?

    public init() {}

    /// Grant the claim to `session`, or throw `SocketClaimError.held`.
    ///
    /// - no holder: granted.
    /// - the holder's own session reconnecting: granted; the holder is told
    ///   `.replaced`, since the client has already abandoned that socket.
    /// - another session, without `takeover`: refused with `.held`.
    /// - another session, with `takeover`: granted; the holder is told
    ///   `.takenOver`.
    ///
    /// A holder with no session id never matches a newcomer, with or without
    /// one — an id-less connection has no identity to reconnect as.
    ///
    /// State changes before `onDisplaced` is awaited, so a newcomer arriving
    /// during that await sees the new holder rather than the one being
    /// displaced.
    public func claim(
        session: String?,
        takeover: Bool = false,
        onDisplaced: @escaping @Sendable (DisplacedReason) async -> Void = { _ in }
    ) async throws -> ClaimToken {
        guard let current = holder else {
            let token = ClaimToken()
            holder = (session, token, onDisplaced)
            return token
        }

        let sameSession = session != nil && current.session == session
        guard sameSession || takeover else {
            throw SocketClaimError.held
        }

        let token = ClaimToken()
        let displaced = current.onDisplaced
        holder = (session, token, onDisplaced)
        await displaced(sameSession ? .replaced : .takenOver)
        return token
    }

    /// Free the claim if `token` still holds it. A displaced holder's release
    /// does nothing, since a later grant already moved `holder` on.
    public func release(token: ClaimToken) {
        guard holder?.token == token else { return }
        holder = nil
    }
}
