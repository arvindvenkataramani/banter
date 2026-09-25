import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Turns a request the generated decoder rejects into the 400 the spec promises.
///
/// A body missing a required field throws inside the generated code, before any
/// handler runs, and the transport renders that as a bodyless 500. The spec says
/// 400 with an `error` field, so without this the documented contract and the
/// behaviour disagree on the most ordinary client mistake there is.
///
/// This is an OpenAPI `ServerMiddleware` rather than a Hummingbird one: the
/// decode happens inside the generated handler, which a router-level middleware
/// wraps from the outside and never sees throw.
struct APIErrorMiddleware: ServerMiddleware {
    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        metadata: ServerRequestMetadata,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, ServerRequestMetadata) async throws -> (
            HTTPResponse, HTTPBody?
        )
    ) async throws -> (HTTPResponse, HTTPBody?) {
        do {
            return try await next(request, body, metadata)
        } catch {
            guard let detail = decodeFailure(error) else { throw error }
            let payload =
                (try? JSONEncoder().encode(ErrorResponse(error: detail)))
                ?? Data(#"{"error":"bad request"}"#.utf8)
            var response = HTTPResponse(status: .badRequest)
            response.headerFields[.contentType] = "application/json; charset=utf-8"
            return (response, HTTPBody(payload))
        }
    }

    /// Unwrap whatever the runtime wrapped the decoding failure in. Anything
    /// that is not a decoding failure belongs to the caller, not here.
    private func decodeFailure(_ error: any Error) -> String? {
        if let decoding = error as? DecodingError { return describe(decoding) }
        if let server = error as? ServerError { return decodeFailure(server.underlyingError) }
        if let client = error as? ClientError { return decodeFailure(client.underlyingError) }
        return nil
    }

    /// Name the field, since that is the whole of what the caller needs.
    private func describe(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, _):
            return "missing required field: \(key.stringValue)"
        case .typeMismatch(_, let ctx), .valueNotFound(_, let ctx):
            let path = ctx.codingPath.map(\.stringValue).joined(separator: ".")
            return path.isEmpty ? ctx.debugDescription : "invalid value for \(path)"
        case .dataCorrupted(let ctx):
            return ctx.debugDescription
        @unknown default:
            return "could not decode the request body"
        }
    }
}
