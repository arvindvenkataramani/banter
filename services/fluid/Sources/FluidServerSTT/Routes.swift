import FluidAudio
import FluidServerKit
import Foundation
import Hummingbird
import OpenAPIHummingbird
import HTTPTypes
import MultipartKit
import NIOCore

func buildRouter(ctx: AppContext) -> Router<BasicRequestContext> {
    let router = Router()

    // Same variable and same allowlist behaviour as the TTS server: the two
    // are configured by the same hand, and a client written against one and
    // pointed at the other must not find them disagreeing.
    if let cors = CorsAllowlist<BasicRequestContext>(fromEnvironment: "FLUID_CORS_ORIGINS") {
        router.add(middleware: cors)
    }

    // Health and model lifecycle come from the generated protocol, so their
    // handlers cannot diverge from openapi.yaml without failing to compile.
    // The middleware restores the 400 the spec promises for a body the
    // generated decoder rejects before any handler sees it.
    try! APIHandlers(ctx: ctx).registerHandlers(
        on: router, middlewares: [EmptyJSONBodyMiddleware(), APIErrorMiddleware()])

    // Transcription stays hand-written: its multipart parsing accepts both
    // spellings of `timestamp_granularities` and the harness depends on the
    // response shape it produces. The spec documents it; moving it onto the
    // generated path is a separate change with its own verification.
    router.post("/audio/transcriptions") { request, reqCtx in
        try await handleTranscribe(request: request, reqCtx: reqCtx, appCtx: ctx)
    }
    router.post("/v1/audio/transcriptions") { request, reqCtx in
        try await handleTranscribe(request: request, reqCtx: reqCtx, appCtx: ctx)
    }
    registerListenBatch(on: router, ctx: ctx)

    return router
}

func handleTranscribe(
    request: Request,
    reqCtx: BasicRequestContext,
    appCtx: AppContext
) async throws -> Response {
    guard let contentType = request.headers[.contentType],
          let mediaType = MediaType(from: contentType),
          let parameter = mediaType.parameter,
          parameter.name == "boundary"
    else {
        throw HTTPError(.unsupportedMediaType, message: "expected multipart/form-data")
    }
    let boundary = parameter.value

    // Collect the entire body — transcription requires the full file anyway.
    let buffer = try await request.body.collect(upTo: 200 * 1024 * 1024)

    // Parse multipart parts manually so we can accept whatever form fields are sent.
    struct Form: Decodable {
        var file: MultipartFile
        var response_format: String?
        /// Names the model to transcribe with, loaded or replacing an idle one
        /// as `ResidentModel.transcribe` describes.
        var model: String?
        /// `true` answers as server-sent events.
        var stream: String?
        /// OpenAI sends this field name with the brackets included, and clients
        /// repeat it once per granularity. Both spellings are accepted so a
        /// caller using either convention gets timestamps rather than silence.
        var timestamp_granularities: [String]?
        var `timestamp_granularities[]`: [String]?
    }
    struct MultipartFile: MultipartPartConvertible, Decodable {
        let data: Data
        let filename: String

        var multipart: MultipartPart? { nil }

        init?(multipart: MultipartPart) {
            self.data = Data(buffer: multipart.body)
            let disposition = multipart.headers["content-disposition"].first ?? ""
            let fn = disposition
                .split(separator: ";")
                .compactMap { part -> String? in
                    let trimmed = part.trimmingCharacters(in: .whitespaces)
                    guard trimmed.hasPrefix("filename=") else { return nil }
                    let value = trimmed.dropFirst("filename=".count)
                        .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                    return value
                }
                .first
            self.filename = fn ?? "audio.wav"
        }
    }

    let decoder = FormDataDecoder()
    let form: Form
    do {
        form = try decoder.decode(Form.self, from: buffer, boundary: boundary)
    } catch {
        throw HTTPError(.badRequest, message: "multipart decode failed: \(error)")
    }

    // Save to temp file, in this server's own temp subdirectory rather than
    // the shared system one.
    let ext = (form.file.filename as NSString).pathExtension.isEmpty ? "wav" : (form.file.filename as NSString).pathExtension
    let tempURL = appCtx.temporaryDirectory
        .appendingPathComponent("fluidserver-\(UUID().uuidString).\(ext)")
    try form.file.data.write(to: tempURL)
    defer { try? FileManager.default.removeItem(at: tempURL) }

    let result: TranscriptionOutput
    do {
        let expecting = try form.model.map { try appCtx.resident.roster.id(forKey: $0) }
        result = try await appCtx.resident.transcribe(url: tempURL, expecting: expecting)
    } catch let error as FluidServerSTTError {
        return errorResponse(error)
    }

    if form.stream == "true" { return transcriptEvents(result.text) }

    if (form.response_format ?? "json") == "text" {
        return Response(
            status: .ok,
            headers: [.contentType: "text/plain; charset=utf-8"],
            body: ResponseBody(byteBuffer: ByteBuffer(string: result.text))
        )
    }

    let granularities = (form.timestamp_granularities ?? []) + (form.`timestamp_granularities[]` ?? [])
    let wantsWords = (form.response_format ?? "json") == "verbose_json"
        && granularities.contains("word")

    let body = TranscriptionResponse(
        task: "transcribe",
        language: "en",
        duration: result.duration,
        text: result.text,
        words: wantsWords ? mergeTokensIntoWords(result.tokenTimings) : nil
    )
    let data = try JSONEncoder().encode(body)
    return Response(
        status: .ok,
        headers: [.contentType: "application/json; charset=utf-8"],
        body: ResponseBody(byteBuffer: ByteBuffer(bytes: data))
    )
}

func jsonResponse<T: Encodable>(_ value: T, status: HTTPResponse.Status = .ok) throws -> Response {
    let data = try JSONEncoder().encode(value)
    return Response(
        status: status,
        headers: [.contentType: "application/json; charset=utf-8"],
        body: ResponseBody(byteBuffer: ByteBuffer(bytes: data))
    )
}

func errorResponse(_ error: FluidServerSTTError) -> Response {
    let data = (try? JSONEncoder().encode(ErrorResponse(error: error.description))) ?? Data()
    return Response(
        status: error.status,
        headers: [.contentType: "application/json; charset=utf-8"],
        body: ResponseBody(byteBuffer: ByteBuffer(bytes: data))
    )
}

// ── CORS ────────────────────────────────────────────────────────────────────

struct CORSMiddleware<Context: RequestContext>: RouterMiddleware {
    let allowedOrigins: [String]

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let origin = request.headers[.init("Origin")!] ?? ""
        let matches = allowedOrigins.contains(origin) || allowedOrigins.contains("*")

        if request.method == .options {
            var headers: HTTPFields = [
                .init("Access-Control-Allow-Methods")!: "POST, GET, OPTIONS",
                .init("Access-Control-Allow-Headers")!: "*",
                .init("Access-Control-Max-Age")!: "86400",
            ]
            if matches {
                headers[.init("Access-Control-Allow-Origin")!] = origin
            }
            return Response(status: .noContent, headers: headers)
        }

        var response = try await next(request, context)
        if matches {
            response.headers[.init("Access-Control-Allow-Origin")!] = origin
            response.headers[.init("Vary")!] = "Origin"
        }
        return response
    }
}

/// A finished transcript as OpenAI's streamed transcription events: the text as
/// one `transcript.text.delta`, then `transcript.text.done`.
func transcriptEvents(_ text: String) -> Response {
    func event(_ object: [String: String]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return "data: \(String(decoding: data, as: UTF8.self))\n\n"
    }
    var body = ""
    if !text.isEmpty { body += event(["type": "transcript.text.delta", "delta": text]) }
    body += event(["type": "transcript.text.done", "text": text])
    return Response(
        status: .ok,
        headers: [.contentType: "text/event-stream"],
        body: ResponseBody(byteBuffer: ByteBuffer(string: body)))
}
