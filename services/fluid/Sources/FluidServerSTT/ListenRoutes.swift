import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore

/// Deepgram's `/listen`, batch and streaming, beside the routes the dashboard
/// uses. The `Authorization` header is not checked: any key satisfies a client
/// that insists on one, and Tailscale is the access control.

private func queryDictionary(_ parameters: Parameters) -> [String: String] {
    parameters.reduce(into: [:]) { result, pair in
        let key = String(pair.key)
        if result[key] == nil { result[key] = String(pair.value) }
    }
}

private func fileExtension(forContentType contentType: String?) -> String {
    switch contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() {
    case "audio/mpeg", "audio/mp3": return "mp3"
    case "audio/mp4", "audio/m4a", "audio/x-m4a": return "m4a"
    case "audio/flac", "audio/x-flac": return "flac"
    case "audio/ogg": return "ogg"
    default: return "wav"
    }
}

/// POST /listen — the audio file is the raw request body.
func registerListenBatch(on router: Router<BasicRequestContext>, ctx: AppContext) {
    for path in ["/listen", "/v1/listen"] {
        router.post(RouterPath(path)) { request, _ -> Response in
            let query: ListenQuery
            do {
                query = try ListenQuery.parse(queryDictionary(request.uri.queryParameters))
            } catch let error as FluidServerSTTError {
                return errorResponse(error)
            }

            let buffer = try await request.body.collect(upTo: 200 * 1024 * 1024)
            let ext = fileExtension(forContentType: request.headers[.contentType])
            let tempURL = ctx.temporaryDirectory
                .appendingPathComponent("fluidserver-\(UUID().uuidString).\(ext)")
            try Data(buffer: buffer).write(to: tempURL)
            defer { try? FileManager.default.removeItem(at: tempURL) }

            let result: TranscriptionOutput
            do {
                result = try await ctx.resident.transcribe(url: tempURL, expecting: nil)
            } catch let error as FluidServerSTTError {
                return errorResponse(error)
            }

            let data = DeepgramResults.batchResponse(
                text: result.text, words: mergeTokensIntoWords(result.tokenTimings),
                duration: result.duration ?? 0, channels: query.channels,
                model: query.model ?? "fluid-stt", requestId: UUID().uuidString)
            return Response(
                status: .ok,
                headers: [.contentType: "application/json; charset=utf-8"],
                body: ResponseBody(byteBuffer: ByteBuffer(bytes: data)))
        }
    }
}

private struct ControlFrame: Decodable {
    let type: String
}

/// WebSocket /listen. Binary frames are linear16 audio; `Finalize`, `KeepAlive`
/// and `CloseStream` arrive as text. The server closes utterances itself on a
/// pause (`UtteranceSegmenter`), which the dashboard's stream route leaves to
/// its client.
func registerListenStream(on wsRouter: Router<BasicWebSocketRequestContext>, ctx: AppContext) {
    for path in ["/listen", "/v1/listen"] {
        wsRouter.ws(RouterPath(path)) { inbound, outbound, wsCtx in
            let sink = WebSocketSink(outbound)
            let query: ListenQuery
            do {
                query = try ListenQuery.parse(queryDictionary(wsCtx.request.uri.queryParameters))
            } catch {
                await sink.fail(error)
                return
            }

            // A generated session and no takeover: a second client is refused
            // rather than displacing a call in progress.
            let token: UInt64
            let claimToken: ClaimToken
            let activeModel: String
            do {
                (token, claimToken, activeModel) = try await ctx.resident.beginSession(
                    expecting: nil, session: UUID().uuidString, takeover: false,
                    onDisplaced: { _ in await sink.close(reason: "replaced") })
            } catch {
                ctx.logger.info("listen session refused: \(error)")
                await sink.fail(error)
                return
            }

            let ended: String
            do {
                ended = try await runListenSession(
                    inbound: inbound, outbound: outbound, sink: sink, ctx: ctx,
                    token: token, query: query, model: activeModel)
            } catch {
                await ctx.resident.endSession(token: token, claim: claimToken)
                ctx.logger.info("listen session \(token) ended: socket failed: \(error)")
                throw error
            }
            await ctx.resident.endSession(token: token, claim: claimToken)
            ctx.logger.info("listen session \(token) ended: \(ended)")
        }
    }
}

private func runListenSession(
    inbound: WebSocketInboundStream, outbound: WebSocketOutboundWriter, sink: WebSocketSink,
    ctx: AppContext, token: UInt64, query: ListenQuery, model: String
) async throws -> String {
    let decoder = Linear16Decoder(sampleRate: query.sampleRate, channels: query.channels)
    var segmenter = UtteranceSegmenter(endpointingMs: query.endpointingMs)
    let requestId = UUID().uuidString
    let rate = 16000.0

    var totalSamples = 0
    var utteranceStart = 0
    var lastPartial = ""

    func send(_ text: String, words: [WordTiming], isFinal: Bool, fromFinalize: Bool) async throws {
        let offset = Double(utteranceStart) / rate
        let duration = Double(totalSamples - utteranceStart) / rate
        try await outbound.write(
            .text(
                DeepgramResults.streamResult(
                    text: text, words: words, offset: offset, duration: duration,
                    isFinal: isFinal, speechFinal: isFinal, fromFinalize: fromFinalize,
                    channels: query.channels, model: model, requestId: requestId)))
    }

    /// Final transcript for the open utterance, then ready the session for the
    /// next. An empty utterance sends nothing.
    func finalizeUtterance(fromFinalize: Bool) async throws {
        let result = try await ctx.resident.finishSession(token: token)
        if !result.text.isEmpty {
            try await send(result.text, words: result.words, isFinal: true, fromFinalize: fromFinalize)
        }
        try await ctx.resident.resetSession(token: token)
        lastPartial = ""
        utteranceStart = totalSamples
    }

    for try await frame in inbound.messages(maxSize: 8 * 1024 * 1024) {
        switch frame {
        case .binary(let buffer):
            let samples = decoder.decode(Array(buffer.readableBytesView))
            guard !samples.isEmpty else { continue }
            do {
                let partial = try await ctx.resident.appendToSession(token: token, samples: samples)
                totalSamples += samples.count
                if query.interimResults, partial != lastPartial {
                    lastPartial = partial
                    try await send(partial, words: [], isFinal: false, fromFinalize: false)
                }
                if segmenter.feed(samples) { try await finalizeUtterance(fromFinalize: false) }
            } catch SlotError.superseded {
                return "a newer connection took over"
            } catch {
                await sink.fail(error)
                return "audio could not be transcribed: \(error)"
            }

        case .text(let string):
            guard let data = string.data(using: .utf8),
                let control = try? JSONDecoder().decode(ControlFrame.self, from: data)
            else { continue }
            switch control.type {
            case SocketControl.finalize.rawValue:
                do { try await finalizeUtterance(fromFinalize: true) } catch SlotError.superseded {
                    return "a newer connection took over"
                } catch {
                    await sink.fail(error)
                    return "finalizing failed: \(error)"
                }
            case SocketControl.closeStream.rawValue:
                do { try await finalizeUtterance(fromFinalize: true) } catch {
                    await sink.fail(error)
                    return "the client closed the stream: finalizing failed: \(error)"
                }
                try await outbound.write(
                    .text(
                        DeepgramResults.streamClosed(
                            duration: Double(totalSamples) / rate, channels: query.channels,
                            requestId: requestId)))
                return "the client closed the stream"
            default:
                continue
            }
        }
    }
    return "the connection closed"
}
