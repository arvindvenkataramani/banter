import CryptoKit
import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore

/// Deepgram's `/v1/listen`, batch (`deepgram.listen.prerecorded`) and live
/// (`deepgram.listen.live`). The `Authorization` header is not checked.

func queryDictionary(_ parameters: Parameters) -> [String: String] {
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

/// A RIFF header and 16-bit PCM, so raw audio can go through the file decoders.
func wavFile(pcm16 bytes: Data, sampleRate: Int, channels: Int) -> Data {
    var data = Data()
    func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    data.append(Data("RIFF".utf8))
    le32(UInt32(36 + bytes.count))
    data.append(Data("WAVEfmt ".utf8))
    le32(16)
    le16(1)
    le16(UInt16(channels))
    le32(UInt32(sampleRate))
    le32(UInt32(sampleRate * channels * 2))
    le16(UInt16(channels * 2))
    le16(16)
    data.append(Data("data".utf8))
    le32(UInt32(bytes.count))
    data.append(bytes)
    return data
}

/// POST /v1/listen: the audio as the raw body, a file in any container the
/// decoders read, or raw `linear16` when `encoding` says so.
func registerListenBatch(on router: Router<BasicRequestContext>, ctx: AppContext) {
    for path in ["/listen", "/v1/listen"] {
        router.post(RouterPath(path)) { request, _ -> Response in
            let params = queryDictionary(request.uri.queryParameters)
            let sampleRate: Int
            let expecting: String?
            do {
                sampleRate = try params["sample_rate"].map { raw in
                    guard let rate = Int(raw), rate > 0 else {
                        throw FluidServerSTTError.badListenParameter("sample_rate=\(raw)")
                    }
                    return rate
                } ?? 16000
                // Raw audio other than linear16 has no decoder here; a file names its own encoding.
                if let encoding = params["encoding"], encoding != "linear16", encoding != "flac" {
                    throw FluidServerSTTError.unsupportedEncoding(encoding)
                }
                expecting = try params["model"].map { try ctx.resident.roster.id(forKey: $0) }
            } catch let error as FluidServerSTTError {
                return errorResponse(error)
            }

            let buffer = try await request.body.collect(upTo: 200 * 1024 * 1024)
            var body = Data(buffer: buffer)
            var ext = fileExtension(forContentType: request.headers[.contentType])
            if params["encoding"] == "linear16" {
                body = wavFile(pcm16: body, sampleRate: sampleRate, channels: 1)
                ext = "wav"
            }
            let tempURL = ctx.temporaryDirectory
                .appendingPathComponent("fluidserver-\(UUID().uuidString).\(ext)")
            try body.write(to: tempURL)
            defer { try? FileManager.default.removeItem(at: tempURL) }

            let result: TranscriptionOutput
            let served: String
            do {
                result = try await ctx.resident.transcribe(url: tempURL, expecting: expecting)
                served = await ctx.resident.loadedId ?? expecting ?? ""
            } catch let error as FluidServerSTTError {
                return errorResponse(error)
            }

            let data = DeepgramResults.batchResponse(
                text: result.text, words: mergeTokensIntoWords(result.tokenTimings),
                duration: result.duration ?? 0, channels: 1,
                model: ctx.resident.roster.model(id: served)?.entry.key ?? served,
                requestId: UUID().uuidString)
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

/// WebSocket /v1/listen: linear16 or one raw Opus packet per binary message.
/// Refusals and displacements close with their 4001–4010 code and send no frame.
func registerListenStream(on wsRouter: Router<BasicWebSocketRequestContext>, ctx: AppContext) {
    for path in ["/listen", "/v1/listen"] {
        wsRouter.ws(RouterPath(path)) { inbound, outbound, wsCtx in
            let sink = WebSocketSink(outbound)
            let query: ListenQuery
            let expecting: String?
            do {
                query = try ListenQuery.parse(
                    queryDictionary(wsCtx.request.uri.queryParameters), provisions: ctx.provisions)
                expecting = try query.model.map { try ctx.resident.roster.id(forKey: $0) }
            } catch {
                await closeCoded(sink, error)
                return
            }

            let token: UInt64
            let claimToken: ClaimToken
            let activeModel: String
            do {
                (token, claimToken, activeModel) = try await ctx.resident.beginSession(
                    expecting: expecting, session: query.session, takeover: query.takeover,
                    onDisplaced: { reason in
                        let code: SocketErrorCode = reason == .replaced ? .replaced : .superseded
                        await sink.close(code: code.closeCode, reason: code.rawValue)
                    })
            } catch {
                ctx.logger.info("listen session refused: \(error)")
                await closeCoded(sink, error)
                return
            }

            let ended: String
            do {
                ended = try await runListenSession(
                    inbound: inbound, outbound: outbound, sink: sink, ctx: ctx,
                    token: token, query: query,
                    model: ctx.resident.roster.model(id: activeModel)?.entry.key ?? activeModel)
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

/// Close with the code that names `error`, sending no frame first.
private func closeCoded(_ sink: WebSocketSink, _ error: any Error) async {
    let code = (error as? any SocketCoded)?.socketCode ?? .failed
    await sink.close(code: code.closeCode, reason: code.rawValue)
}

/// Turns one binary message into 16 kHz mono samples.
private enum ListenDecoder {
    case linear16(Linear16Decoder)
    case opus(AudioDecoder)

    func decode(_ bytes: [UInt8]) throws -> [Float] {
        switch self {
        case .linear16(let decoder): return decoder.decode(bytes)
        case .opus(let decoder): return try decoder.decode(bytes)
        }
    }
}

private func runListenSession(
    inbound: WebSocketInboundStream, outbound: WebSocketOutboundWriter, sink: WebSocketSink,
    ctx: AppContext, token: UInt64, query: ListenQuery, model: String
) async throws -> String {
    let decoder: ListenDecoder
    switch query.encoding {
    case .linear16:
        decoder = .linear16(Linear16Decoder(sampleRate: query.sampleRate, channels: query.channels))
    case .opus:
        do {
            decoder = .opus(try AudioDecoder(format: .opus))
        } catch {
            await closeCoded(sink, error)
            return "the decoder could not start: \(error)"
        }
    }
    var segmenter = query.endpointingMs.map { UtteranceSegmenter(endpointingMs: $0) }
    let requestId = UUID().uuidString
    let rate = 16000.0
    var digest = SHA256()

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

    /// Settles the open utterance and readies the session for the next. A `Finalize`
    /// is always answered, even with nothing heard; a pause only when there is text.
    func settle(fromFinalize: Bool) async throws {
        let result = try await ctx.resident.finishSession(token: token)
        // An empty answer settles nothing, so it is not marked final.
        if fromFinalize || !result.text.isEmpty {
            try await send(
                result.text, words: result.words, isFinal: !result.text.isEmpty, fromFinalize: fromFinalize)
        }
        try await ctx.resident.resetSession(token: token)
        lastPartial = ""
        utteranceStart = totalSamples
    }

    func schemaError(_ message: String, _ description: String) async throws {
        let object: [String: Any] = [
            "type": "Error", "variant": "SchemaError", "description": description, "message": message,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        try await outbound.write(.text(String(decoding: data, as: UTF8.self)))
    }

    for try await frame in inbound.messages(maxSize: 8 * 1024 * 1024) {
        switch frame {
        case .binary(let buffer):
            let bytes = Array(buffer.readableBytesView)
            digest.update(data: bytes)
            do {
                let samples = try decoder.decode(bytes)
                guard !samples.isEmpty else { continue }
                let partial = try await ctx.resident.appendToSession(token: token, samples: samples)
                totalSamples += samples.count
                if query.interimResults, partial != lastPartial {
                    lastPartial = partial
                    try await send(partial, words: [], isFinal: false, fromFinalize: false)
                }
                if segmenter?.feed(samples) == true { try await settle(fromFinalize: false) }
            } catch SlotError.superseded {
                return "a newer connection took over"
            } catch {
                await closeCoded(sink, error)
                return "audio could not be transcribed: \(error)"
            }

        case .text(let string):
            guard let data = string.data(using: .utf8),
                let control = try? JSONDecoder().decode(ControlFrame.self, from: data)
            else {
                try await schemaError(string, "the message is not a JSON object with a type")
                continue
            }
            switch control.type {
            case SocketControl.keepAlive.rawValue:
                continue
            case SocketControl.finalize.rawValue:
                do { try await settle(fromFinalize: true) } catch SlotError.superseded {
                    return "a newer connection took over"
                } catch {
                    await closeCoded(sink, error)
                    return "finalizing failed: \(error)"
                }
            case SocketControl.closeStream.rawValue:
                do { try await settle(fromFinalize: false) } catch {
                    await closeCoded(sink, error)
                    return "the client closed the stream: finalizing failed: \(error)"
                }
                let sha = digest.finalize().map { String(format: "%02x", $0) }.joined()
                try await outbound.write(
                    .text(
                        DeepgramResults.streamClosed(
                            duration: Double(totalSamples) / rate, channels: query.channels,
                            requestId: requestId, sha256: sha)))
                await sink.close(code: 1000, reason: "closed")
                return "the client closed the stream"
            default:
                try await schemaError(string, "unsupported message type \(control.type)")
            }
        }
    }
    return "the connection closed"
}
