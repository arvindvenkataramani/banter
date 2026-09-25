import Foundation
import Hummingbird
import Logging

/// The error body both servers return.
///
/// Shared because it is externally visible, not for the code it saves: two
/// servers in the same family answering the same conditions differently leaks
/// to every client written against one and pointed at the other.
public struct ErrorBody: ResponseEncodable, Sendable {
    public let error: String
    public init(error: String) {
        self.error = error
    }
}

/// One model in a `GET /v1/models` listing.
///
/// OpenAI's four fields — `id`, `object`, `created`, `owned_by` — because a
/// client written against any OpenAI-compatible server should read this without
/// special cases, and mlx-audio already serves exactly that shape beside these
/// servers.
///
/// Two fields are added rather than substituted. These servers hold one model
/// resident at a time, which OpenAI's shape has no way to express: `loaded`
/// says which one it is, and `loadable` marks the models that can be made
/// resident over HTTP at all — a streaming-session model is served over a
/// socket and has no one-shot manager to load. A client that ignores both sees
/// a standard listing.
public struct ModelInfo: ResponseEncodable, Codable, Sendable {
    public let id: String
    public let object: String
    /// Seconds since the epoch. These models are not created by this server, so
    /// it reports process start: the field is required by the shape, and a
    /// fabricated per-request timestamp would be worse than a stable one.
    public let created: Int
    public let owned_by: String
    public let loaded: Bool
    public let loadable: Bool

    public init(
        id: String, object: String = "model", created: Int = processStart,
        owned_by: String = "fluidaudio", loaded: Bool, loadable: Bool = true
    ) {
        self.id = id
        self.object = object
        self.created = created
        self.owned_by = owned_by
        self.loaded = loaded
        self.loadable = loadable
    }
}

/// When this process started, as `created` for every model it lists.
public let processStart = Int(Date().timeIntervalSince1970)

/// `GET /v1/models` — every model this server can load, and which one is.
///
/// Both servers answer this identically. A client written against one and
/// pointed at the other must not have to tell them apart, and the flat
/// `{loaded, available}` shape the TTS server used could not even report
/// "nothing is loaded": a nil `loaded` was dropped from the JSON entirely, so
/// the absence of a model and the absence of the field looked the same.
public struct ModelList: ResponseEncodable, Codable, Sendable {
    public let object: String
    public let data: [ModelInfo]

    public init(object: String = "list", data: [ModelInfo]) {
        self.object = object
        self.data = data
    }
}

/// `GET /healthz` — liveness, and what the process is holding.
public struct HealthBody: ResponseEncodable, Sendable {
    public let status: String
    public let model: String?
    public init(status: String, model: String?) {
        self.status = status
        self.model = model
    }
}

/// An error a route can answer with directly.
///
/// Refines Hummingbird's `HTTPResponseError` rather than sitting beside it:
/// only that protocol is consulted when a route *throws*, so an error that
/// carried a status without conforming would render as a bodyless 500 from
/// every route that rethrows, and correctly only from the ones that build a
/// response by hand. That split is exactly the bug this replaced.
public protocol FluidServerError: HTTPResponseError, CustomStringConvertible {}

extension FluidServerError {
    /// The JSON body for this error, as both servers render it.
    public func errorResponse() -> Response {
        let payload =
            (try? JSONEncoder().encode(["error": description]))
            ?? Data(#"{"error":"request failed"}"#.utf8)
        return Response(
            status: status,
            headers: [.contentType: "application/json"],
            body: .init(byteBuffer: ByteBuffer(data: payload)))
    }

    /// `HTTPResponseError`'s requirement, satisfied once for every conformer so
    /// a thrown error and a returned one produce the same bytes.
    public func response(from request: Request, context: some RequestContext) throws -> Response {
        errorResponse()
    }
}

/// Busy and empty are 409 across both servers: the request is well formed and
/// names something real, but the server's state does not satisfy it yet.
extension SlotError: FluidServerError {
    public var status: HTTPResponse.Status { .conflict }
}

/// Cross-origin access for an allowlist read at startup.
///
/// The dashboard runs on the Pi and calls these servers across origins, so
/// without these headers a browser refuses a response it was served. Both
/// servers read one variable, `FLUID_CORS_ORIGINS`, because they are configured
/// by the same hand and a second spelling would be a trap.
///
/// Hand-written rather than Hummingbird's `CORSMiddleware`: its `oneOf` takes
/// variadic literals and cannot be given a list read from the environment, and
/// `originBased` would echo whatever origin asked, which is not an allowlist.
public struct CorsAllowlist<Context: RequestContext>: RouterMiddleware {
    let origins: Set<String>

    /// Nil when the variable is unset, so a server adds no middleware at all
    /// rather than one that allows nothing.
    public init?(fromEnvironment name: String = "FLUID_CORS_ORIGINS") {
        guard let env = ProcessInfo.processInfo.environment[name],
            !env.trimmingCharacters(in: .whitespaces).isEmpty
        else { return nil }
        self.origins = Set(
            env.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty })
    }

    public init(origins: Set<String>) {
        self.origins = origins
    }

    public func handle(
        _ request: Request, context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        // A request with no Origin did not come from a browser and needs no
        // headers: curl, the benchmark harness and the control plane all
        // arrive that way.
        guard let origin = request.headers[.origin], origins.contains(origin) else {
            return try await next(request, context)
        }

        // A preflight is answered here; it never reaches a route.
        if request.method == .options {
            var response = Response(status: .noContent)
            addHeaders(to: &response, origin: origin)
            return response
        }

        // A refused request is still a cross-origin request. Hummingbird
        // renders a thrown error above this chain, so letting one past would
        // send a bare response and the browser would report the origin as
        // disallowed — hiding the real status. That is how a 409 saying no
        // model is loaded reaches a dashboard as a CORS failure.
        var response: Response
        do {
            response = try await next(request, context)
        } catch let error as HTTPResponseError {
            response = try error.response(from: request, context: context)
        }
        addHeaders(to: &response, origin: origin)
        return response
    }

    private func addHeaders(to response: inout Response, origin: String) {
        response.headers[.accessControlAllowOrigin] = origin
        response.headers[.accessControlAllowHeaders] = "accept, authorization, content-type, origin"
        response.headers[.accessControlAllowMethods] = "GET, POST, DELETE, OPTIONS"
        // Origin decides the response, so a shared cache must not serve one
        // origin's response to another.
        response.headers[.vary] = "Origin"
    }
}

/// Which interfaces a server listens on, named by intent rather than address
/// so a typo cannot bind somewhere unintended.
public enum Bind: String, Sendable {
    /// Loopback only. Tailscale Serve proxies to localhost, and the health
    /// checker's localhost fallback expects it, so this is the default.
    case local
    /// Every interface, the Tailscale one included, over plain HTTP with no
    /// Serve in front.
    case all

    public var host: String {
        switch self {
        case .local: return "127.0.0.1"
        case .all: return "0.0.0.0"
        }
    }
}

public enum ServerArgsError: Error, CustomStringConvertible {
    case badBind(String?)

    public var description: String {
        switch self {
        case .badBind(let value):
            return "--bind takes local or all, got \(value ?? "nothing")"
        }
    }
}

/// Standard argument parsing for both servers.
public struct ServerArgs: Sendable {
    public var port: Int
    public var bind: Bind
    public var host: String { bind.host }
    /// Where FluidAudio looks for weights. It appends its own `repo.folderName`
    /// to this, so the tree must use those names rather than HuggingFace's
    /// `models--org--repo/snapshots/<hash>/` layout.
    public var modelsDirectory: URL?
    /// The node's registry, whose `roster` section says which models exist on
    /// this machine. Passed as a path rather than its contents so the running
    /// state is always attributable to something readable, and declared in the
    /// registry beside the port rather than assembled at spawn time.
    public var registryPath: URL?
    /// Which provider in that roster is this server. A roster covers the whole
    /// node; a server serves one entry of it.
    public var providerId: String?

    public init(
        port: Int, bind: Bind = .local, modelsDirectory: URL? = nil,
        registryPath: URL? = nil, providerId: String? = nil
    ) {
        self.port = port
        self.bind = bind
        self.modelsDirectory = modelsDirectory
        self.registryPath = registryPath
        self.providerId = providerId
    }

    public static func parse(defaultPort: Int, arguments: [String] = CommandLine.arguments)
        throws -> ServerArgs
    {
        var args = ServerArgs(port: defaultPort)
        var i = 1
        while i < arguments.count {
            switch arguments[i] {
            case "--port":
                if i + 1 < arguments.count, let p = Int(arguments[i + 1]) {
                    args.port = p
                    i += 1
                }
            case "--bind":
                let value = i + 1 < arguments.count ? arguments[i + 1] : nil
                guard let bind = value.flatMap(Bind.init(rawValue:)) else {
                    throw ServerArgsError.badBind(value)
                }
                args.bind = bind
                i += 1
            case "--models-dir":
                if i + 1 < arguments.count {
                    args.modelsDirectory = URL(
                        fileURLWithPath: (arguments[i + 1] as NSString).expandingTildeInPath)
                    i += 1
                }
            case "--registry":
                if i + 1 < arguments.count {
                    args.registryPath = URL(
                        fileURLWithPath: (arguments[i + 1] as NSString).expandingTildeInPath)
                    i += 1
                }
            case "--provider":
                if i + 1 < arguments.count {
                    args.providerId = arguments[i + 1]
                    i += 1
                }
            default:
                break
            }
            i += 1
        }
        return args
    }
}

/// One log configuration for both servers.
public func bootstrapLogging(label: String, level: Logger.Level = .info) -> Logger {
    LoggingSystem.bootstrap { label in
        var handler = StreamLogHandler.standardOutput(label: label)
        handler.logLevel = level
        return handler
    }
    return Logger(label: label)
}
