import FluidAudio
import Foundation
import Hummingbird
import Logging
import HTTPTypes
import MultipartKit
import NIOCore

func buildRouter(ctx: AppContext) -> Router<BasicRequestContext> {
    let router = Router()

    if let corsEnv = ProcessInfo.processInfo.environment["FLUID_CORS_ORIGINS"],
       !corsEnv.trimmingCharacters(in: .whitespaces).isEmpty {
        let origins = corsEnv.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        router.add(middleware: CORSMiddleware(allowedOrigins: origins, logger: ctx.logger))
    }

    router.get("/healthz") { _, _ -> HealthResponse in
        HealthResponse(status: "ok", model: ctx.modelVersion)
    }

    router.post("/audio/transcriptions") { request, reqCtx in
        try await handleTranscribe(request: request, reqCtx: reqCtx, appCtx: ctx)
    }
    router.post("/v1/audio/transcriptions") { request, reqCtx in
        try await handleTranscribe(request: request, reqCtx: reqCtx, appCtx: ctx)
    }

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

    // Save to temp file
    let ext = (form.file.filename as NSString).pathExtension.isEmpty ? "wav" : (form.file.filename as NSString).pathExtension
    let tempURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("fluidserver-\(UUID().uuidString).\(ext)")
    try form.file.data.write(to: tempURL)
    defer { try? FileManager.default.removeItem(at: tempURL) }

    let result = try await appCtx.queue.transcribe(url: tempURL)

    if (form.response_format ?? "json") == "text" {
        return Response(
            status: .ok,
            headers: [.contentType: "text/plain; charset=utf-8"],
            body: ResponseBody(byteBuffer: ByteBuffer(string: result.text))
        )
    }

    let body = TranscriptionResponse(
        task: "transcribe",
        language: "en",
        duration: result.duration,
        text: result.text
    )
    let data = try JSONEncoder().encode(body)
    return Response(
        status: .ok,
        headers: [.contentType: "application/json; charset=utf-8"],
        body: ResponseBody(byteBuffer: ByteBuffer(bytes: data))
    )
}

// ── CORS ────────────────────────────────────────────────────────────────────

struct CORSMiddleware<Context: RequestContext>: RouterMiddleware {
    let allowedOrigins: [String]
    let logger: Logger

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let origin = request.headers[.init("Origin")!] ?? ""
        let matches = allowedOrigins.contains(origin) || allowedOrigins.contains("*")

        // A rejected origin is invisible to the caller: the browser blocks the
        // response and reports only a generic network failure, so the client
        // cannot tell "service down" from "origin not allowed". Log it here —
        // this is the only place the distinction is knowable.
        if !origin.isEmpty && !matches {
            logger.warning(
                "CORS: rejected origin \(origin) — not in FLUID_CORS_ORIGINS "
                + "(\(allowedOrigins.joined(separator: ", "))). "
                + "The caller will see an opaque network error."
            )
        }

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
