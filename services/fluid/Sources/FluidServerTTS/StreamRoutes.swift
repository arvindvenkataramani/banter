import FluidAudio
import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging

/// What a client sends. Text arrives as it is generated upstream, so `speak`
/// carries whatever span the caller has — a clause, a sentence, a paragraph.
private struct TtsClientFrame: Decodable {
    let type: String
    let text: String?
    let voice: String?
    let ref_audio: String?
    let response_format: String?
    let streaming_interval: Double?
}

/// What the server sends. Audio goes out as binary; everything else is JSON, so
/// a client never has to guess which it is holding.
private struct TtsServerFrame: Encodable {
    let type: String
    var model: String? = nil
    var format: String? = nil
    var sample_rate: Int? = nil
    var message: String? = nil
    /// Identifies the utterance a frame belongs to, so a client can discard
    /// audio from one it has already cancelled.
    var utterance: UInt64? = nil
    var queued: Int? = nil
}

/// The streaming synthesis endpoint.
///
/// Why a socket rather than the HTTP route: text reaches the dashboard from the
/// gateway a token at a time and should reach synthesis as fast as it arrives.
/// An HTTP request needs its text up front, so a client must accumulate enough
/// to be worth sending — which is the only reason `text-chunker.ts` exists. A
/// socket removes the request boundary, and the server synthesises on whatever
/// spans it is given.
///
/// The server queues rather than the client serialising. Synthesising the next
/// span while the current one plays is what keeps the seams gapless, and a
/// client should not be modelling the fact that this server holds one model —
/// that is a server fact and would have to change again if it stopped being
/// true.
///
/// One connection at a time drives synthesis here, exactly as one connection
/// at a time drives a transcription session on `fluid-stt`: `claim`, shared by
/// every socket this router opens, decides who that is by `session` and
/// `takeover`, the same way and with the same codes. Synthesis itself still
/// takes the model slot per span through `beginStream` — the claim is a gate
/// in front of the connection, not a replacement for that.
func buildStreamRouter(ctx: TtsAppContext) -> Router<BasicWebSocketRequestContext> {
    let wsRouter = Router(context: BasicWebSocketRequestContext.self)
    let claim = SocketClaim()

    wsRouter.ws("/v1/audio/stream") { inbound, outbound, wsCtx in
        let expecting = wsCtx.request.uri.queryParameters["model"].map(String.init)
        let requested = wsCtx.request.uri.queryParameters["format"].map(String.init)
        let requestedSession = wsCtx.request.uri.queryParameters["session"].map(String.init)
        let takeover =
            wsCtx.request.uri.queryParameters["takeover"].map(String.init) == "1"

        let sink = WebSocketSink(outbound)

        guard let format = AudioFormat(requested: requested) else {
            await sink.fail(TtsError.unknownFormat(requested ?? ""))
            return
        }
        if let want = expecting {
            // Asserts which model the caller believes is loaded; it never
            // switches. Loading is POST /v1/models/load and nothing else, so
            // opening a socket cannot evict a model from under another caller.
            //
            // Compared as platform ids: the slot holds the runtime key, and a
            // caller names what the listing showed it.
            let current = await ctx.resident.currentModel.flatMap { ctx.roster.id(forKey: $0) }
            guard current == want else {
                await sink.fail(TtsError.modelMismatch(
                    "requested model \(want) is not loaded; \(current ?? "none") is"))
                return
            }
        }

        let claimToken: ClaimToken
        do {
            claimToken = try await claim.claim(
                session: requestedSession, takeover: takeover,
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
            await sink.fail(error)
            return
        }

        let session = SynthesisQueue(ctx: ctx, format: format, sink: sink)
        // Every exit drains the queue and releases whatever it holds: a clean
        // close, a dropped socket, a thrown error. Awaited rather than
        // detached — a task here could outlive the next connection and cancel
        // work it does not own.
        do {
            try await runSession(inbound: inbound, sink: sink, session: session, ctx: ctx)
        } catch {
            await session.shutdown()
            await claim.release(token: claimToken)
            throw error
        }
        await session.shutdown()
        await claim.release(token: claimToken)
    }

    return wsRouter
}

private func runSession(
    inbound: WebSocketInboundStream,
    sink: any SocketSink,
    session: SynthesisQueue,
    ctx: TtsAppContext
) async throws {
    // As the platform id, which is what the client asked for and what the
    // listing showed it — never the runtime key the slot happens to hold.
    let model = await ctx.resident.currentModel.flatMap { ctx.roster.id(forKey: $0) }
    await sink.send(TtsServerFrame(type: "ready", model: model))

    // A speaker pauses between turns while the socket stays open, and closing
    // on a thinking pause would put connection setup back in the
    // conversational path.
    let watchdog = IdleWatchdog(seconds: 60)
    let idle = startIdleGuard(
        watchdog: watchdog, sink: sink,
        reason: "no frames within 60s; closing so the model is not held",
        logger: ctx.logger)
    defer { idle.cancel() }

    for try await frame in inbound.messages(maxSize: 1024 * 1024) {
        await watchdog.poke()
        guard case .text(let string) = frame else {
            // Nothing a client sends here is binary; ignoring rather than
            // closing keeps one confused frame from ending a conversation.
            continue
        }
        guard let data = string.data(using: .utf8),
            let parsed = try? JSONDecoder().decode(TtsClientFrame.self, from: data)
        else { continue }

        switch parsed.type {
        case "speak":
            guard let text = parsed.text, !text.trimmingCharacters(in: .whitespaces).isEmpty
            else { continue }
            await session.enqueue(text: text, voice: parsed.voice, refAudio: parsed.ref_audio)

        case "cancel":
            // Barge-in: stop generating and drop the queue, in one ordered
            // message. Audio already on the wire is the client's to discard,
            // and `playback-engine.ts`'s generation counter already does.
            await session.cancelAll()

        case SocketControl.keepAlive.rawValue:
            continue

        case SocketControl.finalize.rawValue:
            // Wait for what is queued, then stay open. A conversation is many
            // turns and connection setup does not belong in the middle of one.
            await session.drain()

        case SocketControl.closeStream.rawValue:
            await session.drain()
            return

        default:
            continue
        }
    }
}

/// Serialises synthesis for one connection.
///
/// One model is resident, so overlapping requests have to queue somewhere.
/// Held-open HTTP requests are a queue with no control surface — no way to drop
/// it as a unit, no ordering between a cancel and the work it cancels, and N
/// aborts racing N connections. Here a cancel is one message against one queue.
actor SynthesisQueue {
    private let ctx: TtsAppContext
    private let format: AudioFormat
    private let sink: any SocketSink
    /// Spans waiting to be synthesised.
    private var pending: [(id: UInt64, request: SynthesisRequest)] = []
    private var counter: UInt64 = 0
    /// The utterance being synthesised, and the task doing it.
    private var running: (id: UInt64, task: Task<Void, Never>)?
    /// Bounds a runaway client: a peer that enqueues faster than the model
    /// synthesises would otherwise grow this without limit.
    private static let depthCap = 32

    init(ctx: TtsAppContext, format: AudioFormat, sink: any SocketSink) {
        self.ctx = ctx
        self.format = format
        self.sink = sink
    }

    func enqueue(text: String, voice: String?, refAudio: String?) async {
        guard pending.count < Self.depthCap else {
            // Scoped to this request: the connection and the queue are still
            // good, so the client is told and the session carries on.
            await sink.reportError(
                code: .busy, message: "queue is full at \(Self.depthCap) spans; slow down or cancel")
            return
        }
        counter += 1
        let refURL = refAudio.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
        pending.append(
            (
                id: counter,
                request: SynthesisRequest(
                    text: text, voice: voice, refAudio: refURL, refText: nil, language: nil,
                    speed: nil, temperature: nil, seed: nil, cfgWeight: nil,
                    repetitionPenalty: nil, minP: nil, topP: nil, topK: nil, emotion: nil,
                    deEss: nil, maxTokensPerChunk: nil, alpha: nil, beta: nil, noiseScale: nil,
                    totalSteps: nil, silenceDuration: nil)
            ))
        pump()
    }

    /// Start the next span if nothing is running.
    private func pump() {
        guard running == nil, !pending.isEmpty else { return }
        let next = pending.removeFirst()
        let task = Task { await self.synthesise(id: next.id, request: next.request) }
        running = (id: next.id, task: task)
    }

    private func synthesise(id: UInt64, request: SynthesisRequest) async {
        defer { finished(id: id) }
        do {
            let begun = try await ctx.resident.beginStream(request)
            defer { Task { await ctx.resident.endStream(token: begun.token) } }

            let encoder = try makeEncoder(format: format, sampleRate: begun.sampleRate)
            await sink.send(
                TtsServerFrame(
                    type: "utterance.start", format: format.rawValue,
                    sample_rate: begun.sampleRate, utterance: id))

            for try await chunk in bufferedChunks(
                begun.stream, interval: voiceLoopInterval, sampleRate: begun.sampleRate)
            {
                if Task.isCancelled { break }
                let encoded = try encoder.encode(chunk)
                if !encoded.isEmpty { try await sink.sendBinary(encoded) }
            }
            // Flushed even on cancellation, so a player is never left holding a
            // partial packet it cannot decode.
            let tail = try encoder.finish()
            if !tail.isEmpty { try? await sink.sendBinary(tail) }
            if !Task.isCancelled {
                await sink.send(TtsServerFrame(type: "utterance.end", utterance: id))
            }
        } catch {
            ctx.logger.error("socket synthesis failed: \(error)")
            // Scoped to this span: the connection stays open for the next
            // `speak`, so the client is told and nothing closes.
            await sink.reportError(error)
        }
    }

    private func finished(id: UInt64) {
        if running?.id == id { running = nil }
        pump()
    }

    /// Stop generating and drop everything queued.
    func cancelAll() async {
        pending.removeAll()
        if let active = running {
            active.task.cancel()
            // The task releases the slot on its own way out; waiting here keeps
            // a following `speak` from racing that release.
            _ = await active.task.value
            running = nil
        }
        await sink.send(TtsServerFrame(type: "cancelled", queued: 0))
    }

    /// Wait for everything queued to finish.
    func drain() async {
        while let active = running {
            _ = await active.task.value
            if running?.id == active.id { running = nil }
            pump()
        }
    }

    /// Release everything on the way out of a connection.
    func shutdown() async {
        pending.removeAll()
        if let active = running {
            active.task.cancel()
            _ = await active.task.value
            running = nil
        }
    }
}

/// What the voice loop asks for, where the measurements put the floor: below
/// about 1.0s TTFB stops tracking the interval and settles near 0.3s, so 0.5s
/// sits at the floor without paying for twice the chunks.
private let voiceLoopInterval = 0.5
