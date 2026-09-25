import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore

/// Control frames a client sends as text. Audio arrives as binary frames.
private struct ClientFrame: Decodable {
    let type: String
}

/// Results the server sends.
///
/// Follows the convention streaming-ASR services use: binary audio in, JSON
/// results out, with `is_final` separating a transcript that may still change
/// from one that will not. Interim results carry the transcript as it currently
/// stands, not a delta, so a client renders the latest and discards the rest.
///
/// Audio is binary rather than base64 inside JSON. A 16 kHz pcm16 uplink
/// measured 257.8 kbit/s against its 256 kbit/s requirement on cellular, where
/// base64's extra third is the difference between keeping up and falling behind.
private struct ServerFrame: Encodable {
    let type: String
    var is_final: Bool? = nil
    var text: String? = nil
    var words: [WordTiming]? = nil
    var model: String? = nil
    var format: String? = nil
}

/// The streaming transcription endpoint.
///
/// Contract: binary frames are audio in the format the `format` query names,
/// decoded by `AudioDecoder` — `pcm16` (raw little-endian Int16) or `opus`
/// (raw packets, one per frame), 16 kHz mono either way, the rate
/// `mic-capture.ts` pins its `AudioContext` to, so nothing resamples at the
/// boundary. Text frames are control: `Finalize` ends the utterance and asks
/// for the final transcript, `CloseStream` does the same and then closes, and
/// `KeepAlive` proves the client is alive. The client decides when an
/// utterance ends, because VAD and smart-turn already make that judgement and
/// the server should not second-guess them.
///
/// `session` and `takeover` (`1`) name who holds the connection: the claim in
/// `ResidentModel` decides before anything here touches the slot.
///
/// The session is bound to the connection. Whatever ends it — a clean close, a
/// dropped socket, a decode failure, a takeover — the claim and the slot are
/// both released, and why is logged: the client may never get to say.
func buildStreamRouter(ctx: AppContext) -> Router<BasicWebSocketRequestContext> {
    let wsRouter = Router(context: BasicWebSocketRequestContext.self)

    wsRouter.ws("/v1/audio/stream") { inbound, outbound, wsCtx in
        // Asserts which model the caller believes is loaded; it never switches.
        // Loading is POST /v1/models/load and nothing else.
        let expecting = wsCtx.request.uri.queryParameters["model"].map(String.init)
        let formatName = wsCtx.request.uri.queryParameters["format"].map(String.init) ?? "opus"
        let session = wsCtx.request.uri.queryParameters["session"].map(String.init)
        let takeover = wsCtx.request.uri.queryParameters["takeover"].map(String.init) == "1"

        let sink = WebSocketSink(outbound)

        guard let format = AudioFormat(rawValue: formatName) else {
            await sink.fail(FluidServerSTTError.unknownFormat(formatName))
            return
        }
        let decoder: AudioDecoder
        do {
            decoder = try AudioDecoder(format: format)
        } catch {
            await sink.fail(error)
            return
        }

        // A displaced connection is told why it lost the claim: its own
        // session reconnected (close only, the client already knows) or
        // another session took over (an error frame first, so it is told
        // rather than just dropped).
        let token: UInt64
        let claimToken: ClaimToken
        let activeModel: String
        do {
            (token, claimToken, activeModel) = try await ctx.resident.beginSession(
                expecting: expecting, session: session, takeover: takeover,
                onDisplaced: { reason in
                    switch reason {
                    case .replaced:
                        await sink.close(
                            code: SocketErrorCode.replaced.closeCode, reason: "replaced")
                    case .takenOver:
                        await sink.fail(SlotError.superseded)
                    }
                })
        } catch {
            ctx.logger.info("session refused: \(error)")
            await sink.fail(error)
            return
        }

        // Every exit releases the claim and the slot. Awaited rather than
        // detached — a `Task` here would let this teardown land after the
        // next connection's beginSession and end a session it does not own.
        let started = ContinuousClock.now
        let ended: String
        do {
            ended = try await runSession(
                inbound: inbound, outbound: outbound, sink: sink, ctx: ctx, token: token,
                decoder: decoder, model: activeModel, format: format)
        } catch {
            await ctx.resident.endSession(token: token, claim: claimToken)
            ctx.logger.info(
                "session \(token) ended after \(elapsed(since: started)): socket failed: \(error)")
            throw error
        }
        // A takeover closes this socket from the server's side, which the loop
        // sees only as the connection closing.
        let held = await ctx.resident.endSession(token: token, claim: claimToken)
        let why = held ? ended : "a newer connection took over"
        ctx.logger.info("session \(token) ended after \(elapsed(since: started)): \(why)")
    }

    return wsRouter
}

/// How long a quiet connection keeps its session before the server takes it
/// back. Quiet is ordinary — a speaker thinking, a window behind another app
/// whose browser has stopped its timers — and a newer connection taking over
/// is what frees the model from a client that has gone. This only reclaims one
/// that went and was never replaced, and matches the shard's idle unload.
private let sessionBackstop = 30 * 60

/// The frame loop, factored out so the caller can release the session on every
/// path including a thrown error. Returns why the session ended.
private func runSession(
    inbound: WebSocketInboundStream,
    outbound: WebSocketOutboundWriter,
    sink: WebSocketSink,
    ctx: AppContext,
    token: UInt64,
    decoder: AudioDecoder,
    model: String,
    format: AudioFormat
) async throws -> String {
        try await outbound.write(
            .text(encode(ServerFrame(type: "ready", model: model, format: format.rawValue))))

        var lastPartial = ""

        let watchdog = IdleWatchdog(seconds: sessionBackstop)
        let timedOut = startIdleGuard(
            watchdog: watchdog, sink: sink,
            reason: "nothing received for \(sessionBackstop / 60) minutes; closing the session",
            logger: ctx.logger)
        defer { timedOut.cancel() }

        for try await frame in inbound.messages(maxSize: 8 * 1024 * 1024) {
            await watchdog.poke()
            switch frame {
            case .binary(let buffer):
                do {
                    let samples = try decoder.decode(Array(buffer.readableBytesView))
                    guard !samples.isEmpty else { continue }
                    let partial = try await ctx.resident.appendToSession(
                        token: token, samples: samples)
                    // Send on change, not on every frame: a frame that completes
                    // no chunk produces no new text, and echoing it would make a
                    // client think the transcript moved.
                    if partial != lastPartial {
                        lastPartial = partial
                        try await outbound.write(
                            .text(
                                encode(
                                    ServerFrame(
                                        type: "transcript", is_final: false, text: partial))))
                    }
                } catch SlotError.superseded {
                    return "a newer connection took over"
                } catch {
                    await sink.fail(error)
                    return "audio could not be transcribed: \(error)"
                }

            case .text(let string):
                guard let data = string.data(using: .utf8),
                    let parsed = try? JSONDecoder().decode(ClientFrame.self, from: data)
                else { continue }

                switch parsed.type {
                case SocketControl.keepAlive.rawValue:
                    // Deliberately unanswered, as Deepgram's is: the message
                    // exists to prove the client is alive, and a reply would be
                    // traffic that proves nothing further.
                    continue

                case SocketControl.finalize.rawValue, "done":
                    // Return the transcript and stay open for the next
                    // utterance. A conversation is many turns, and tearing the
                    // connection down after each one would put connection setup
                    // in the conversational path.
                    //
                    // "done" is the older spelling of this, kept working.
                    do {
                        let result = try await ctx.resident.finishSession(token: token)
                        try await outbound.write(
                            .text(
                                encode(
                                    ServerFrame(
                                        type: "transcript", is_final: true,
                                        text: result.text, words: result.words))))
                        try await ctx.resident.resetSession(token: token)
                        lastPartial = ""
                    } catch SlotError.superseded {
                        return "a newer connection took over"
                    } catch {
                        await sink.fail(error)
                        return "finalizing failed: \(error)"
                    }

                case SocketControl.closeStream.rawValue:
                    // Final transcript, then close.
                    do {
                        let result = try await ctx.resident.finishSession(token: token)
                        try await outbound.write(
                            .text(
                                encode(
                                    ServerFrame(
                                        type: "transcript", is_final: true,
                                        text: result.text, words: result.words))))
                    } catch {
                        await sink.fail(error)
                        return "the client closed the stream: finalizing failed: \(error)"
                    }
                    return "the client closed the stream"

                default:
                    continue
                }
            }
        }
        // The inbound stream ends when the socket closes from either side:
        // the client going, or this server closing it for the backstop or a
        // takeover, both of which log their own reason first.
        return "the connection closed"
}

private func elapsed(since start: ContinuousClock.Instant) -> String {
    let seconds = (ContinuousClock.now - start).components.seconds
    return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m\(seconds % 60)s"
}

private func encode(_ frame: ServerFrame) -> String {
    guard let data = try? JSONEncoder().encode(frame),
        let string = String(data: data, encoding: .utf8)
    else { return #"{"type":"error","message":"encode failed"}"# }
    return string
}
