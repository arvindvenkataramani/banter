import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import Logging
import NIOCore

/// Deepgram's `/v1/speak`, over POST and WebSocket. `model` is a roster model, `voice` a
/// roster voice (`voice-param`), and `ref_audio` and `ref_text` clone (`cloning-reference`).

func queryDictionary(_ parameters: Parameters) -> [String: String] {
    parameters.reduce(into: [:]) { result, pair in
        let key = String(pair.key)
        if result[key] == nil { result[key] = String(pair.value) }
    }
}

/// Resamples to `to` before handing samples to `inner`, an encoder at that rate.
final class ResamplingEncoder: StreamingAudioEncoder {
    private let resampler: PcmStreamEncoder
    private let inner: any StreamingAudioEncoder

    init(from: Int, to: Int, inner: any StreamingAudioEncoder) throws {
        resampler = try PcmStreamEncoder(sampleRate: from, targetRate: to)
        self.inner = inner
    }

    func encode(_ samples: [Float]) throws -> Data {
        try inner.encode(try resampler.resampled(samples, ending: false))
    }

    func finish() throws -> Data {
        var data = try inner.encode(try resampler.resampled([], ending: true))
        data.append(try inner.finish())
        return data
    }
}

/// What a Deepgram client asks of the audio: `encoding`, `container` and `sample_rate`.
struct SpeakAudio: Sendable {
    let encoding: String
    let sampleRate: Int?
    let output: OutputEncoding

    /// `linear16` is raw unless `container=wav` (the REST default) asks for a header;
    /// `aac` is ADTS. Any other value is refused.
    init(encoding: String, container: String?, sampleRate: Int?, rawByDefault: Bool) throws {
        self.encoding = encoding
        self.sampleRate = sampleRate
        switch encoding {
        case "linear16":
            let rate = sampleRate ?? AudioFormat.pcmSampleRate
            switch container ?? (rawByDefault ? "none" : "wav") {
            case "none":
                output = OutputEncoding(contentType: "audio/pcm;rate=\(rate)") {
                    try PcmStreamEncoder(sampleRate: $0, targetRate: rate)
                }
            case "wav":
                output = OutputEncoding(contentType: "audio/wav") { source in
                    if rate == source { return WavStreamEncoder(sampleRate: rate) }
                    return try ResamplingEncoder(from: source, to: rate, inner: WavStreamEncoder(sampleRate: rate))
                }
            case let other:
                throw TtsError.unsupportedValue("container=\(other)")
            }
        case "aac":
            output = OutputEncoding(contentType: "audio/aac") { source in
                guard let rate = sampleRate, rate != source else { return try AacStreamEncoder(sampleRate: source) }
                return try ResamplingEncoder(from: source, to: rate, inner: AacStreamEncoder(sampleRate: rate))
            }
        default:
            throw TtsError.unsupportedValue("encoding=\(encoding)")
        }
    }
}

/// The synthesis a Deepgram request names, resolved through the roster.
private struct SpeakTerms {
    let modelId: String?
    let key: String?
    let voice: String?
    let refAudio: String?
    let refText: String?
    let speed: Float?

    init(_ params: [String: String], roster: TtsRoster) throws {
        modelId = params["model"]
        key = try modelId.map { id in
            guard let key = roster.key(for: id) else { throw TtsError.unknownModel(id) }
            return key
        }
        voice = params["voice"]
        refAudio = params["ref_audio"]
        refText = params["ref_text"]
        speed = try params["speed"].map { raw in
            guard let speed = Float(raw) else { throw TtsError.unsupportedValue("speed=\(raw)") }
            return speed
        }
    }

    func request(_ text: String, ctx: TtsAppContext) async throws -> SynthesisRequest {
        let who = try await ctx.voiceTerms(voice: voice, refAudio: refAudio, refText: refText, model: modelId)
        if let key { try await ctx.resident.ensureLoaded(key) }
        return SynthesisRequest(
            text: text, voice: who.voice, refAudio: who.refAudio, refText: who.refText, language: nil,
            speed: speed, temperature: nil, seed: nil, cfgWeight: nil, repetitionPenalty: nil, minP: nil,
            topP: nil, topK: nil, emotion: nil, deEss: nil, maxTokensPerChunk: nil, alpha: nil, beta: nil,
            noiseScale: nil, totalSteps: nil, silenceDuration: nil)
    }
}

private func sampleRate(_ params: [String: String]) throws -> Int? {
    try params["sample_rate"].map { raw in
        guard let rate = Int(raw), rate > 0 else { throw TtsError.unsupportedValue("sample_rate=\(raw)") }
        return rate
    }
}

private struct SpeakBody: Decodable {
    let text: String
}

/// POST /v1/speak: `{"text"}` in, the audio streamed out as it renders.
func registerSpeak(on router: Router<BasicRequestContext>, ctx: TtsAppContext) {
    router.post("/v1/speak") { request, context -> Response in
        let params = queryDictionary(request.uri.queryParameters)
        let body = try await request.decode(as: SpeakBody.self, context: context)
        let audio: SpeakAudio
        let synthesis: SynthesisRequest
        do {
            // With no encoding named, the provision's declared default, else Deepgram's own mp3.
            audio = try SpeakAudio(
                encoding: params["encoding"] ?? ctx.provisions.speakEncoding ?? "mp3",
                container: params["container"], sampleRate: try sampleRate(params), rawByDefault: false)
            synthesis = try await SpeakTerms(params, roster: ctx.roster).request(body.text, ctx: ctx)
        } catch {
            return errorResponse(error, ctx: ctx)
        }
        return try await streamingResponse(
            synthesis, output: audio.output, interval: defaultStreamingInterval, events: false, ctx: ctx)
    }
}

/// WebSocket /v1/speak: `Speak` gathers text, `Flush` speaks it then sends `Flushed`, `Clear`
/// stops it and sends `Cleared`. Refusals close with their 4001–4010 code and no frame.
func registerSpeakLive(
    on wsRouter: Router<BasicWebSocketRequestContext>, ctx: TtsAppContext, claim: SocketClaim
) {
    wsRouter.ws("/v1/speak") { inbound, outbound, wsCtx in
        let sink = WebSocketSink(outbound)
        let params = queryDictionary(wsCtx.request.uri.queryParameters)
        let terms: SpeakTerms
        let audio: SpeakAudio
        do {
            terms = try SpeakTerms(params, roster: ctx.roster)
            audio = try SpeakAudio(
                encoding: params["encoding"] ?? "linear16", container: "none",
                sampleRate: try sampleRate(params), rawByDefault: true)
        } catch {
            return await closeCoded(sink, error)
        }

        let claimToken: ClaimToken
        do {
            claimToken = try await claim.claim(
                session: params["session"], takeover: params["takeover"] == "1",
                onDisplaced: { reason in
                    let code: SocketErrorCode = reason == .replaced ? .replaced : .superseded
                    await sink.close(code: code.closeCode, reason: code.rawValue)
                })
        } catch {
            return await closeCoded(sink, error)
        }

        let modelName: String?
        if let id = terms.modelId {
            modelName = id
        } else {
            modelName = await ctx.resident.currentModel.flatMap { ctx.roster.id(forKey: $0) }
        }
        // INVENTED: an empty `model_version` and a random `model_uuid`; the server has neither.
        let metadata: [String: Any] = [
            "type": "Metadata", "request_id": UUID().uuidString.lowercased(),
            "model_name": modelName ?? "", "model_version": "",
            "model_uuid": UUID().uuidString.lowercased(), "additional_model_uuids": [String](),
        ]
        try? await sink.sendText(jsonText(metadata))

        let session = SpeakLiveSession(ctx: ctx, sink: sink, terms: terms, audio: audio)
        do {
            for try await frame in inbound.messages(maxSize: 1024 * 1024) {
                guard case .text(let string) = frame,
                    let data = string.data(using: .utf8),
                    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                    let type = object["type"] as? String
                else {
                    await session.warn("the message is not a JSON object with a type", code: "INVALID_MESSAGE")
                    continue
                }
                switch type {
                case "Speak":
                    guard let text = object["text"] as? String else {
                        await session.warn("Speak carries no text", code: "INVALID_MESSAGE")
                        continue
                    }
                    await session.speak(text)
                case "Flush": await session.flush()
                case "Clear": await session.clear()
                case "Close":
                    await session.flush()
                    await session.drain()
                    await sink.close(code: 1000, reason: "closed")
                default:
                    await session.warn("unsupported message type \(type)", code: "INVALID_MESSAGE")
                }
                if type == "Close" { break }
            }
        } catch {
            await session.shutdown()
            await claim.release(token: claimToken)
            throw error
        }
        await session.shutdown()
        await claim.release(token: claimToken)
    }
}

/// Close with the code that names `error`, sending no frame first.
func closeCoded(_ sink: WebSocketSink, _ error: any Error) async {
    let code = (error as? any SocketCoded)?.socketCode ?? .failed
    await sink.close(code: code.closeCode, reason: code.rawValue)
}

/// A JSON object as one text message.
func jsonText(_ object: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    return String(decoding: data, as: UTF8.self)
}

/// One live speak connection: text gathered between flushes, and the flushes
/// being spoken, one at a time and in order.
private actor SpeakLiveSession {
    private let ctx: TtsAppContext
    private let sink: WebSocketSink
    private let terms: SpeakTerms
    private let audio: SpeakAudio
    private var gathered = ""
    private var sequence = 0
    private var jobs: [Task<Void, Never>] = []

    init(ctx: TtsAppContext, sink: WebSocketSink, terms: SpeakTerms, audio: SpeakAudio) {
        self.ctx = ctx
        self.sink = sink
        self.terms = terms
        self.audio = audio
    }

    func speak(_ text: String) { gathered += text }

    func flush() {
        let text = gathered
        gathered = ""
        let id = sequence
        sequence += 1
        let previous = jobs.last
        jobs.append(
            Task {
                await previous?.value
                if Task.isCancelled { return }
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    await self.render(text)
                }
                if Task.isCancelled { return }
                try? await self.sink.sendText(jsonText(["type": "Flushed", "sequence_id": id]))
            })
    }

    func clear() async {
        gathered = ""
        await stopAll()
        try? await sink.sendText(jsonText(["type": "Cleared", "sequence_id": sequence]))
    }

    func drain() async {
        for job in jobs { await job.value }
        jobs.removeAll()
    }

    func shutdown() async { await stopAll() }

    // INVENTED: the `Warning` codes, `INVALID_MESSAGE` and `SYNTHESIS_FAILED`.
    func warn(_ description: String, code: String) async {
        try? await sink.sendText(jsonText(["type": "Warning", "description": description, "code": code]))
    }

    private func stopAll() async {
        let running = jobs
        jobs.removeAll()
        for job in running { job.cancel() }
        for job in running { await job.value }
    }

    private func render(_ text: String) async {
        do {
            let request = try await terms.request(text, ctx: ctx)
            let begun: (token: UInt64, stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
            do {
                begun = try await ctx.resident.beginStream(request)
            } catch TtsError.unsupported {
                // A backend with no streaming path is spoken whole.
                let result = try await ctx.resident.synthesize(request)
                let encoder = try audio.output.make(result.sampleRate)
                var data = try encoder.encode(result.samples)
                data.append(try encoder.finish())
                if !data.isEmpty, !Task.isCancelled { try await sink.sendBinary(data) }
                return
            }
            do {
                let encoder = try audio.output.make(begun.sampleRate)
                for try await chunk in bufferedChunks(
                    begun.stream, interval: defaultStreamingInterval, sampleRate: begun.sampleRate)
                {
                    if Task.isCancelled { break }
                    let encoded = try encoder.encode(chunk)
                    if !encoded.isEmpty { try await sink.sendBinary(encoded) }
                }
                let tail = try encoder.finish()
                if !tail.isEmpty, !Task.isCancelled { try await sink.sendBinary(tail) }
            } catch {
                await ctx.resident.endStream(token: begun.token)
                throw error
            }
            await ctx.resident.endStream(token: begun.token)
        } catch {
            ctx.logger.error("speak synthesis failed: \(error)")
            let message = (error as? any FluidServerError)?.description ?? "\(error)"
            await warn(message, code: "SYNTHESIS_FAILED")
        }
    }
}
