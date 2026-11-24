import Foundation
import HTTPTypes
import OpenAPIRuntime

/// Reads an empty body sent as JSON as `{}`.
///
/// A request that sends nothing, with a JSON content type or none, fails the
/// generated decoder ("not valid JSON") even where the spec makes the body
/// optional, as the model repository's index and load routes do. `curl -X POST`
/// sends exactly that, so an empty body here means "no parameters". A body the spec requires then
/// fails on its missing fields, which names what the caller left out.
public struct EmptyJSONBodyMiddleware: ServerMiddleware {
    public init() {}

    public func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        metadata: ServerRequestMetadata,
        operationID: String,
        next: @Sendable (HTTPRequest, HTTPBody?, ServerRequestMetadata) async throws -> (
            HTTPResponse, HTTPBody?
        )
    ) async throws -> (HTTPResponse, HTTPBody?) {
        // The generated decoder reads a body with no content type as JSON too.
        let type = request.headerFields[.contentType]?.lowercased()
        guard type == nil || type!.hasPrefix("application/json")
        else { return try await next(request, body, metadata) }
        switch body?.length {
        case .none, .known(0):
            return try await next(request, HTTPBody("{}"), metadata)
        case .known:
            return try await next(request, body, metadata)
        case .unknown:
            // Length not declared up front: read it to tell empty from not.
            // These routes take small JSON objects, so a megabyte is ample.
            let data = try await Data(collecting: body!, upTo: 1 << 20)
            return try await next(request, HTTPBody(data.isEmpty ? Data("{}".utf8) : data), metadata)
        }
    }
}
