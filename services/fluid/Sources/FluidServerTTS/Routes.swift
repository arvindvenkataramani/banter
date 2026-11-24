import FluidAudio
import FluidServerKit
import Foundation
import Hummingbird
import OpenAPIHummingbird
import Logging

/// The OpenAI-compatible speech request, as the benchmark harness sends it.
/// `ref_audio` and `ref_text` are not OpenAI's — they are what the existing
/// mlx-audio arms already send for cloning engines, so they are accepted with
/// the same names.
struct SpeechRequest: Decodable {
    let input: String
    let model: String?
    let voice: String?
    let ref_audio: String?
    let ref_text: String?
    let language: String?
    let speed: Float?
    let temperature: Float?
    let response_format: String?
    /// `sse` for server-sent events; `audio`, or none, for the audio itself.
    let stream_format: String?
    /// Seconds of audio per emission. Named as mlx-audio's server names it, so
    /// one bench.yaml can sweep the interval against either.
    let streaming_interval: Double?
    // The union of what the eight managers accept. Each backend reads the ones
    // it has and ignores the rest; `seed` is what makes parameter delivery
    // testable, since equal seeds must reproduce equal audio.
    let seed: UInt64?
    let cfg_weight: Float?
    let repetition_penalty: Float?
    let min_p: Float?
    let top_p: Float?
    let top_k: Int?
    let emotion: String?
    let de_ess: Bool?
    let max_tokens_per_chunk: Int?
    let alpha: Float?
    let beta: Float?
    let noise_scale: Float?
    let total_steps: Int?
    let silence_duration: Float?
}

/// Give every route the same status and body for a backend failure.
///
/// Without this a `TtsError` thrown from a route that does not build its own
/// response reaches Hummingbird as an ordinary error and renders as a bodyless
/// 500, so a caller cannot tell a busy model from a broken one.
extension TtsError: FluidServerKit.FluidServerError {
    /// Busy and not-loaded are 409 here and on the transcription server: the
    /// request is well formed and names something real, but the server's state
    /// does not satisfy it yet. A client written against one and pointed at the
    /// other must not find them disagreeing.
    public var status: HTTPResponse.Status {
        switch self {
        case .unknownModel, .unknownFormat, .unknownStreamFormat, .unsupportedValue, .voiceNotOffered,
            .noModelNamed:
            return .badRequest
        case .busy, .notLoaded, .modelMismatch: return .conflict
        case .missingReference, .unsupported, .noUsableReference: return .internalServerError
        }
    }

}

/// What a driver is told about who speaks: a name, or a recording to clone.
struct VoiceTerms: Sendable {
    let voice: String?
    let refAudio: URL?
    let refText: String?
}

extension TtsAppContext {
    /// The one place a request's voice becomes what a driver is given, for the
    /// HTTP route and the socket alike.
    ///
    /// A request carrying a recording has chosen it: nothing is looked up and
    /// the voice name, which names no recording, is not passed on. A request
    /// naming only a voice is resolved through the roster for the model that
    /// will render it: `model` where the request names one, otherwise
    /// whichever is resident, and with neither it is refused.
    func voiceTerms(voice: String?, refAudio: String?, refText: String?, model: String?) async throws
        -> VoiceTerms
    {
        if let refAudio {
            return VoiceTerms(
                voice: nil, refAudio: Self.fileURL(refAudio), refText: Self.transcript(refText))
        }
        guard let voice else { return VoiceTerms(voice: nil, refAudio: nil, refText: nil) }

        var modelId = model
        if modelId == nil, let key = await resident.currentModel { modelId = roster.id(forKey: key) }
        guard let modelId else { throw TtsError.noModelNamed(voice: voice) }

        switch try roster.resolve(voice: voice, model: modelId) {
        case .preset(let name):
            return VoiceTerms(voice: name, refAudio: nil, refText: nil)
        case .clone(let audio, let text):
            return VoiceTerms(
                voice: voice, refAudio: Self.fileURL(audio), refText: Self.transcript(text))
        }
    }

    /// Reference paths arrive as `~`-relative strings from a harness.
    private static func fileURL(_ path: String) -> URL {
        URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    }

    /// A transcript is a path in the roster and in `bench.yaml` for some
    /// engines, and literal text in a hand-written request; a path is read.
    private static func transcript(_ value: String?) -> String? {
        guard let value else { return nil }
        let expanded = (value as NSString).expandingTildeInPath
        guard FileManager.default.fileExists(atPath: expanded) else { return value }
        return (try? String(contentsOfFile: expanded, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? value
    }
}

func buildRouter(ctx: TtsAppContext) -> Router<BasicRequestContext> {
    let router = Router()

    // Only when an allowlist is configured: a server with no origins set adds
    // no middleware rather than one that refuses everything.
    if let cors = CorsAllowlist<BasicRequestContext>(fromEnvironment: "FLUID_CORS_ORIGINS") {
        router.add(middleware: cors)
    }

    // Health and model lifecycle come from the generated protocol, so their
    // handlers cannot diverge from openapi.yaml without failing to compile —
    // which is what keeps this server and the transcription server answering
    // them identically.
    // An empty body sent as JSON reads as `{}`, so optional bodies are optional.
    try! APIHandlers(ctx: ctx).registerHandlers(on: router, middlewares: [EmptyJSONBodyMiddleware()])

    router.post("/v1/audio/speech") { request, context -> Response in
        let body = try await request.decode(as: SpeechRequest.self, context: context)

        // Through the roster, as the load endpoint does: a caller names the
        // platform's id and the driver wants the runtime's key, and a model
        // the roster omits is unknown here too.
        let key = try body.model.map { model -> String in
            guard let key = ctx.roster.key(for: model) else { throw TtsError.unknownModel(model) }
            return key
        }
        // Before the load: a voice the named model does not offer is refused
        // without evicting whatever is resident to find that out.
        let who = try await ctx.voiceTerms(
            voice: body.voice, refAudio: body.ref_audio, refText: body.ref_text, model: body.model)
        if let key { try await ctx.resident.ensureLoaded(key) }

        let synthesisRequest = SynthesisRequest(
            text: body.input,
            voice: who.voice,
            refAudio: who.refAudio,
            refText: who.refText,
            language: body.language,
            speed: body.speed,
            temperature: body.temperature,
            seed: body.seed,
            cfgWeight: body.cfg_weight,
            repetitionPenalty: body.repetition_penalty,
            minP: body.min_p,
            topP: body.top_p,
            topK: body.top_k,
            emotion: body.emotion,
            deEss: body.de_ess,
            maxTokensPerChunk: body.max_tokens_per_chunk,
            alpha: body.alpha,
            beta: body.beta,
            noiseScale: body.noise_scale,
            totalSteps: body.total_steps,
            silenceDuration: body.silence_duration)

        // A format the server cannot produce is refused here rather than served
        // as something else: a caller that asks for mp3 and receives WAV with a
        // 200 discovers the mismatch as audio that will not play.
        // With none named, the provision's declared default, else OpenAI's own mp3, which is refused.
        let requestedFormat = body.response_format ?? ctx.provisions.speechFormat ?? "mp3"
        guard let format = AudioFormat(requested: requestedFormat) else {
            return errorResponse(TtsError.unknownFormat(requestedFormat), ctx: ctx)
        }
        let events: Bool
        switch body.stream_format {
        case nil, "audio": events = false
        case "sse": events = true
        case let other?:
            return errorResponse(TtsError.unknownStreamFormat(other), ctx: ctx)
        }

        return try await streamingResponse(
            synthesisRequest, output: .format(format),
            interval: body.streaming_interval ?? defaultStreamingInterval,
            events: events, ctx: ctx)
    }

    registerSpeak(on: router, ctx: ctx)
    return router
}

/// The streaming interval when a request names none, for the HTTP route and the
/// socket alike. Where the measurements put the floor: below about 1.0s TTFB
/// stops tracking the interval and settles near 0.3s, so 0.5s sits at the floor
/// without paying for twice the chunks. The dashboard never names one, so this
/// is what the voice loop gets. `streaming_interval` is the field mlx-audio
/// accepts, so one `bench.yaml` drives both and a sweep sets it explicitly.
let defaultStreamingInterval = 0.5

/// How a response encodes audio: its content type, and an encoder for a model's sample rate.
struct OutputEncoding: Sendable {
    let contentType: String
    let make: @Sendable (Int) throws -> any StreamingAudioEncoder

    static func format(_ format: AudioFormat) -> OutputEncoding {
        OutputEncoding(contentType: format.contentType) { try makeEncoder(format: format, sampleRate: $0) }
    }
}

/// Encode a whole utterance as one response body.
func wholeResponse(samples: [Float], sampleRate: Int, output: OutputEncoding) throws -> Response {
    let encoder = try output.make(sampleRate)
    var data = try encoder.encode(samples)
    data.append(try encoder.finish())
    var response = Response(status: .ok, body: .init(byteBuffer: ByteBuffer(data: data)))
    response.headers[.contentType] = output.contentType
    return response
}

/// One server-sent event of the speech route, as OpenAI's `stream_format: "sse"` names them.
private func speechEvent(_ type: String, audio: Data? = nil) -> ByteBuffer {
    var event: [String: String] = ["type": type]
    if let audio { event["audio"] = audio.base64EncodedString() }
    let json = (try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])) ?? Data()
    return ByteBuffer(string: "data: \(String(decoding: json, as: UTF8.self))\n\n")
}

private let eventStreamType = "text/event-stream"

/// Serve an utterance as one encoded stream, emitted as it is generated, as
/// the audio itself or, with `events`, as server-sent events carrying it.
///
/// One encoder for the whole response: a container per interval would repeat
/// its header at every seam, and for a codec with encoder delay and end padding
/// put a gap there too. A backend that cannot stream serves the whole utterance
/// in the same container rather than failing, so a client never branches on
/// which model it is talking to.
func streamingResponse(
    _ request: SynthesisRequest, output: OutputEncoding, interval: Double, events: Bool,
    ctx: TtsAppContext
) async throws -> Response {
    let begun: (token: UInt64, stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
    do {
        begun = try await ctx.resident.beginStream(request)
    } catch let error as TtsError {
        // A backend with no streaming path is served whole.
        guard case .unsupported = error else { return errorResponse(error, ctx: ctx) }
        do {
            let result = try await ctx.resident.synthesize(request)
            guard events else {
                return try wholeResponse(
                    samples: result.samples, sampleRate: result.sampleRate, output: output)
            }
            let encoder = try output.make(result.sampleRate)
            var audio = try encoder.encode(result.samples)
            audio.append(try encoder.finish())
            var body = audio.isEmpty ? ByteBuffer() : speechEvent("speech.audio.delta", audio: audio)
            var done = speechEvent("speech.audio.done")
            body.writeBuffer(&done)
            var response = Response(status: .ok, body: .init(byteBuffer: body))
            response.headers[.contentType] = eventStreamType
            return response
        } catch {
            return errorResponse(error, ctx: ctx)
        }
    } catch {
        return errorResponse(error, ctx: ctx)
    }

    // Opened once here and discarded, purely so an encoder this machine cannot
    // create fails as a status the caller can read rather than as a stream that
    // ends after zero bytes. The one the body uses is built inside the task,
    // because an encoder is a reference type and crossing into the task with it
    // would be sending mutable state across isolation.
    do {
        _ = try output.make(begun.sampleRate)
    } catch {
        await ctx.resident.endStream(token: begun.token)
        return errorResponse(error, ctx: ctx)
    }

    // The producer runs in an unstructured task, deliberately. Hummingbird
    // cancels the request task when a client disconnects, and iterating an
    // `AsyncThrowingStream` from a cancelled task returns nil at once — while
    // FluidAudio keeps predicting. Releasing the slot there would hand the next
    // request an overlapping CoreML prediction, which is the crash the slot
    // exists to prevent. This task does not inherit that cancellation, so it
    // drains to the producer's own end and releases the slot there. Draining
    // costs the remaining synthesis time; stopping it early is what the
    // WebSocket's cancellation buys.
    //
    // `started` carries the outcome of the first chunk: the response waits for
    // it, so a failure before any audio is still a status the caller can read.
    let (started, signal) = AsyncStream<(any Error)?>.makeStream()
    let buffers = AsyncThrowingStream<ByteBuffer, Error> { continuation in
        Task {
            // Ordering: the slot is released before the body finishes, so a
            // client sees EOF only once the model is free. The harness deletes
            // the model and starts the next arm the moment a response ends,
            // and finishing first would race that against the slot clearing.
            defer { continuation.finish() }
            var signalled = false
            var failure: (any Error)?
            do {
                let encoder = try output.make(begun.sampleRate)
                for try await chunk in bufferedChunks(
                    begun.stream, interval: interval, sampleRate: begun.sampleRate)
                {
                    let encoded = try encoder.encode(chunk)
                    if !encoded.isEmpty {
                        continuation.yield(
                            events ? speechEvent("speech.audio.delta", audio: encoded) : ByteBuffer(data: encoded))
                    }
                    if !signalled {
                        signal.yield(nil)
                        signalled = true
                    }
                }
                // Flushes the encoder's tail, which for a packet-based codec is
                // the last fraction of a second of the utterance.
                let tail = try encoder.finish()
                if !tail.isEmpty {
                    continuation.yield(
                        events ? speechEvent("speech.audio.delta", audio: tail) : ByteBuffer(data: tail))
                }
                if events { continuation.yield(speechEvent("speech.audio.done")) }
            } catch {
                // After the first chunk the status has left, so a failure can
                // only truncate; before it, the response becomes the error.
                failure = error
                ctx.logger.error("streaming synthesis failed: \(error)")
            }
            await ctx.resident.endStream(token: begun.token)
            if !signalled { signal.yield(failure) }
            signal.finish()
        }
    }

    for await outcome in started {
        if let failure = outcome { return errorResponse(failure, ctx: ctx) }
        break
    }
    var response = Response(status: .ok, body: .init(asyncSequence: buffers))
    response.headers[.contentType] = events ? eventStreamType : output.contentType
    return response
}

/// Backend failures carry their own diagnosis — a phoneme-chunk limit, a
/// fixed-shape mismatch. Losing that to a bare 500 makes every failure look
/// alike, so it is logged and returned.
///
/// The synthesis routes build the response here rather than rethrowing, because
/// a failure part-way through the streaming decision still has to produce a
/// whole-utterance response on the fallback path.
func errorResponse(_ error: any Error, ctx: TtsAppContext) -> Response {
    ctx.logger.error("synthesis failed: \(String(describing: error))")
    // Both the server's own errors and the slot's carry their status, so a busy
    // model answers 409 here exactly as it does from a route that rethrows.
    if let known = error as? any FluidServerKit.FluidServerError {
        return known.errorResponse()
    }
    let payload =
        (try? JSONEncoder().encode(["error": String(describing: error)]))
        ?? Data(#"{"error":"synthesis failed"}"#.utf8)
    return Response(
        status: .internalServerError,
        headers: [.contentType: "application/json"],
        body: .init(byteBuffer: ByteBuffer(data: payload)))
}
