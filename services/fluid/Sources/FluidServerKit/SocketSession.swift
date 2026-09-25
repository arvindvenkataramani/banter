import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOWebSocket

/// The control frames every socket in this family understands.
///
/// Both servers hold one resident model behind a socket, and both face the same
/// client behaviour: a peer that stops sending without closing, and a peer that
/// wants to end a unit of work without ending the connection. Naming those the
/// same way in both means a client written against one reads correctly against
/// the other.
public enum SocketControl: String, Sendable {
    /// Proves the client is alive. Deliberately unanswered — the message exists
    /// to reset the idle clock, and a reply would be traffic proving nothing
    /// further.
    case keepAlive = "KeepAlive"
    /// End the current unit of work, keep the connection. A conversation is
    /// many turns, and tearing the socket down after each would put connection
    /// setup in the conversational path.
    case finalize = "Finalize"
    /// End the work and close.
    case closeStream = "CloseStream"
}

/// What a client sends as text. Servers decode their own payloads; this is the
/// discriminator they share.
public struct ClientFrameHeader: Decodable, Sendable {
    public let type: String
}

/// The code on an error frame, and the close code that follows it. Every
/// value here is what a client acts on; `message` is for a human reading logs.
public enum SocketErrorCode: String, Sendable {
    case held
    case superseded
    case idle
    case modelNotLoaded = "model_not_loaded"
    case modelMismatch = "model_mismatch"
    case busy
    case badFormat = "bad_format"
    case badAudio = "bad_audio"
    case failed
    case replaced

    /// The WebSocket close code that follows the error frame carrying this
    /// code (or, for `replaced`, the close that stands in for one — see
    /// `SocketSink.close(code:reason:)`).
    public var closeCode: UInt16 {
        switch self {
        case .held: return 4001
        case .superseded: return 4002
        case .idle: return 4003
        case .modelNotLoaded: return 4004
        case .modelMismatch: return 4005
        case .busy: return 4006
        case .badFormat: return 4007
        case .badAudio: return 4008
        case .failed: return 4009
        case .replaced: return 4010
        }
    }
}

/// An error that knows which socket code names it. Both servers' stream
/// errors, `SlotError`, and `SocketClaimError` conform, so a route can send
/// the right code without a second switch alongside the message.
public protocol SocketCoded {
    var socketCode: SocketErrorCode { get }
}

extension SlotError: SocketCoded {
    public var socketCode: SocketErrorCode {
        switch self {
        case .busy: return .busy
        case .empty: return .modelNotLoaded
        case .superseded: return .superseded
        }
    }
}

extension SocketClaimError: SocketCoded {
    public var socketCode: SocketErrorCode {
        switch self {
        case .held: return .held
        }
    }
}

/// The error frame, identical on both servers.
public struct SocketErrorFrame: Encodable, Sendable {
    public let type = "error"
    public let code: String
    public let message: String
    public init(code: SocketErrorCode, message: String) {
        self.code = code.rawValue
        self.message = message
    }
}

/// Encode a frame for the wire, never throwing: a socket that cannot report an
/// encoding failure is worse off than one that reports it badly.
public func encodeFrame<Frame: Encodable>(_ frame: Frame) -> String {
    guard let data = try? JSONEncoder().encode(frame),
        let string = String(data: data, encoding: .utf8)
    else { return #"{"type":"error","message":"encode failed"}"# }
    return string
}

/// What a session writes to, so the logic around it can be tested.
///
/// `WebSocketOutboundWriter` is tied to a live connection and cannot be built
/// in a test, which would otherwise leave the queueing and cancellation rules —
/// the parts with decisions in them — checkable only by running a server.
public protocol SocketSink: Sendable {
    func sendText(_ text: String) async throws
    func sendBinary(_ data: Data) async throws
    func close(reason: String) async
    /// Close with a specific WebSocket close code, for the 4001–4010 range the
    /// protocol assigns each error code. Defaults to the plain close above for
    /// a sink that does not distinguish codes.
    func close(code: UInt16, reason: String) async
}

extension SocketSink {
    public func close(code: UInt16, reason: String) async {
        await close(reason: reason)
    }
}

/// The real sink, over a live socket.
public struct WebSocketSink: SocketSink {
    let outbound: WebSocketOutboundWriter

    public init(_ outbound: WebSocketOutboundWriter) {
        self.outbound = outbound
    }

    public func sendText(_ text: String) async throws {
        try await outbound.write(.text(text))
    }

    public func sendBinary(_ data: Data) async throws {
        try await outbound.write(.binary(ByteBuffer(data: data)))
    }

    public func close(reason: String) async {
        try? await outbound.close(.goingAway, reason: reason)
    }

    public func close(code: UInt16, reason: String) async {
        try? await outbound.close(WebSocketErrorCode(codeNumber: Int(code)), reason: reason)
    }
}

extension SocketSink {
    /// Send a frame, dropping it if the socket has gone. A send that fails
    /// means the peer left, which the read side discovers on its own.
    public func send<Frame: Encodable>(_ frame: Frame) async {
        try? await sendText(encodeFrame(frame))
    }

    /// Send the coded error frame for `error`, then close with its matching
    /// close code. For a condition that ends the session: the pairing the
    /// protocol requires whenever the connection cannot continue.
    /// Unrecognised errors fall back to `failed`, so nothing here can send a
    /// frame with no code or skip the close that must follow it.
    public func fail(_ error: any Error) async {
        let code = (error as? any SocketCoded)?.socketCode ?? .failed
        let message = (error as? any FluidServerError)?.description ?? "\(error)"
        await fail(code: code, message: message)
    }

    /// Send an error frame with an explicit code and message, then close with
    /// the code's matching close code. For a condition that carries its own
    /// wording rather than an error type's fixed `description` — a queue-depth
    /// refusal naming its own cap, say — and that ends the session.
    public func fail(code: SocketErrorCode, message: String) async {
        await send(SocketErrorFrame(code: code, message: message))
        await close(code: code.closeCode, reason: code.rawValue)
    }

    /// Send the coded error frame for `error`, without closing. For a failure
    /// scoped to one request on a session that carries on — a busy queue, one
    /// failed span — where the connection is still good for what comes next.
    public func reportError(_ error: any Error) async {
        let code = (error as? any SocketCoded)?.socketCode ?? .failed
        let message = (error as? any FluidServerError)?.description ?? "\(error)"
        await reportError(code: code, message: message)
    }

    /// Send an error frame with an explicit code and message, without closing.
    /// The no-close counterpart to `fail(code:message:)`, for the same reason
    /// `reportError(_:)` differs from `fail(_:)`.
    public func reportError(code: SocketErrorCode, message: String) async {
        await send(SocketErrorFrame(code: code, message: message))
    }
}

/// Bounds a client that opens a socket, takes the model, and stops sending.
///
/// One model is resident at a time, so such a peer makes the server refuse all
/// other work while waiting on someone who may be gone; TCP will not notice for
/// minutes. Any frame resets it, so a client that is actively working never
/// needs to send one. The interval is the caller's: it has to outlast the
/// longest gap a live client can leave, which differs by what the socket
/// carries.
///
/// Returns a task the caller must cancel on its way out — cancelling the task
/// *is* stopping the watchdog, so the two cannot disagree.
public func startIdleGuard(
    watchdog: IdleWatchdog,
    sink: any SocketSink,
    reason: String,
    logger: Logger? = nil
) -> Task<Void, Never> {
    Task {
        await watchdog.expire()
        if Task.isCancelled { return }
        logger?.notice("closing idle socket: \(reason)")
        await sink.send(SocketErrorFrame(code: .idle, message: reason))
        await sink.close(code: SocketErrorCode.idle.closeCode, reason: "idle")
    }
}
