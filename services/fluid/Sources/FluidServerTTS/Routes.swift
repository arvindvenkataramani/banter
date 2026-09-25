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
    let stream: Bool?
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
        case .unknownModel, .unknownFormat: return .badRequest
        case .busy, .notLoaded, .modelMismatch: return .conflict
        case .missingReference, .unsupported: return .internalServerError
        }
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
    try! APIHandlers(ctx: ctx).registerHandlers(on: router)

    router.post("/v1/audio/speech") { request, context -> Response in
        let body = try await request.decode(as: SpeechRequest.self, context: context)

        // Through the roster, as the load endpoint does: a caller names the
        // platform's id and the driver wants the runtime's key, and a model
        // the roster omits is unknown here too.
        if let model = body.model {
            guard let key = ctx.roster.key(for: model) else {
                throw TtsError.unknownModel(model)
            }
            try await ctx.resident.ensureLoaded(key)
        }

        // Reference paths arrive as the harness's own `~`-relative strings.
        let refURL = body.ref_audio.map { path -> URL in
            URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }
        // `ref_text` is a path in bench.yaml for some engines and literal text
        // for others; the mlx-audio adapter resolves files before sending, but
        // accept both so a hand-written request works too.
        var refText = body.ref_text
        if let t = refText {
            let expanded = (t as NSString).expandingTildeInPath
            if FileManager.default.fileExists(atPath: expanded) {
                refText = (try? String(contentsOfFile: expanded, encoding: .utf8))?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? t
            }
        }

        let synthesisRequest = SynthesisRequest(
            text: body.input,
            voice: body.voice,
            refAudio: refURL,
            refText: refText,
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
        guard let format = AudioFormat(requested: body.response_format) else {
            return errorResponse(
                TtsError.unknownFormat(body.response_format ?? ""), ctx: ctx)
        }

        if body.stream == true {
            return try await streamingResponse(
                synthesisRequest, format: format,
                interval: body.streaming_interval ?? defaultStreamingInterval,
                ctx: ctx)
        }

        // Synthesis failures carry the backend's own diagnosis (a phoneme-chunk
        // limit, a fixed-shape mismatch). Losing it to a bare 500 makes every
        // failure look alike, so it is logged and returned.
        let result: SynthesisResult
        do {
            result = try await ctx.resident.synthesize(synthesisRequest)
        } catch {
            return errorResponse(error, ctx: ctx)
        }
        do {
            return try wholeResponse(
                samples: result.samples, sampleRate: result.sampleRate, format: format)
        } catch {
            return errorResponse(error, ctx: ctx)
        }
    }

    return router
}

/// The interval mlx-audio's server defaults to, and the field name it accepts.
/// One `bench.yaml` drives both, so a sweep that works there works here.
let defaultStreamingInterval = 2.0

/// Encode a whole utterance as one response body.
func wholeResponse(samples: [Float], sampleRate: Int, format: AudioFormat) throws -> Response {
    let encoder = try makeEncoder(format: format, sampleRate: sampleRate)
    var data = try encoder.encode(samples)
    data.append(try encoder.finish())
    var response = Response(status: .ok, body: .init(byteBuffer: ByteBuffer(data: data)))
    response.headers[.contentType] = format.contentType
    return response
}

/// Serve an utterance as one encoded stream, emitted as it is generated.
///
/// One encoder for the whole response: a container per interval would repeat
/// its header at every seam, and for a codec with encoder delay and end padding
/// put a gap there too. A backend that cannot stream serves the whole utterance
/// in the same container rather than failing, so a client never branches on
/// which model it is talking to.
private func streamingResponse(
    _ request: SynthesisRequest, format: AudioFormat, interval: Double, ctx: TtsAppContext
) async throws -> Response {
    let begun: (token: UInt64, stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
    do {
        begun = try await ctx.resident.beginStream(request)
    } catch let error as TtsError {
        // A backend with no streaming path is served whole, so `stream: true`
        // stays a request for a shape rather than for a capability.
        guard case .unsupported = error else { return errorResponse(error, ctx: ctx) }
        do {
            let result = try await ctx.resident.synthesize(request)
            return try wholeResponse(
                samples: result.samples, sampleRate: result.sampleRate, format: format)
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
        _ = try makeEncoder(format: format, sampleRate: begun.sampleRate)
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
    let buffers = AsyncThrowingStream<ByteBuffer, Error> { continuation in
        Task {
            // Ordering: the slot is released before the body finishes, so a
            // client sees EOF only once the model is free. The harness deletes
            // the model and starts the next arm the moment a response ends,
            // and finishing first would race that against the slot clearing.
            defer { continuation.finish() }
            do {
                let encoder = try makeEncoder(format: format, sampleRate: begun.sampleRate)
                for try await chunk in bufferedChunks(
                    begun.stream, interval: interval, sampleRate: begun.sampleRate)
                {
                    let encoded = try encoder.encode(chunk)
                    if !encoded.isEmpty { continuation.yield(ByteBuffer(data: encoded)) }
                }
                // Flushes the encoder's tail, which for a packet-based codec is
                // the last fraction of a second of the utterance.
                let tail = try encoder.finish()
                if !tail.isEmpty { continuation.yield(ByteBuffer(data: tail)) }
            } catch {
                // The status and headers left with the first chunk, so a
                // failure here can only truncate. Inventing a trailer no client
                // parses would help nobody.
                ctx.logger.error("streaming synthesis failed mid-utterance: \(error)")
            }
            await ctx.resident.endStream(token: begun.token)
        }
    }

    var response = Response(status: .ok, body: .init(asyncSequence: buffers))
    response.headers[.contentType] = format.contentType
    return response
}

/// Backend failures carry their own diagnosis — a phoneme-chunk limit, a
/// fixed-shape mismatch. Losing that to a bare 500 makes every failure look
/// alike, so it is logged and returned.
///
/// The synthesis routes build the response here rather than rethrowing, because
/// a failure part-way through the streaming decision still has to produce a
/// whole-utterance response on the fallback path.
private func errorResponse(_ error: any Error, ctx: TtsAppContext) -> Response {
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
