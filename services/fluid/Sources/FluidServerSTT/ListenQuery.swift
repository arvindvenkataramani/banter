import Foundation

/// What a Deepgram client declares in the `/v1/listen` query string. Parameters the
/// server does not implement are ignored, as the provision's omissions declare.
struct ListenQuery: Sendable {
    /// The audio's encoding on a live socket: raw Opus packets or little-endian PCM.
    enum Encoding: String, Sendable { case linear16, opus }

    var model: String?
    var language: String?
    var encoding: Encoding = .linear16
    var sampleRate = 16000
    var channels = 1
    /// Silence after speech that closes an utterance, in milliseconds; nil when
    /// the client sent `endpointing=false` and closes utterances itself.
    var endpointingMs: Int? = Self.deepgramEndpointingMs
    var interimResults = true
    var session: String?
    var takeover = false

    /// Deepgram's own default, for a server whose provision declares none.
    static let deepgramEndpointingMs = 10

    static func parse(_ params: [String: String]) throws -> ListenQuery {
        try parse(params, provisions: .none)
    }

    /// Reads the query, taking the endpointing default from the server's provisions.
    static func parse(_ params: [String: String], provisions: Provisions) throws -> ListenQuery {
        var query = ListenQuery()
        query.endpointingMs = provisions.listenEndpointingMs ?? Self.deepgramEndpointingMs
        query.model = params["model"]
        query.language = params["language"]
        query.session = params["session"]
        query.takeover = params["takeover"] == "1"

        if let raw = params["encoding"] {
            guard let encoding = Encoding(rawValue: raw) else {
                throw FluidServerSTTError.unsupportedEncoding(raw)
            }
            query.encoding = encoding
        }
        query.sampleRate = try integer("sample_rate", params, default: query.sampleRate)
        query.channels = try integer("channels", params, default: query.channels)
        if params["endpointing"] == "false" {
            query.endpointingMs = nil
        } else if params["endpointing"] != nil {
            query.endpointingMs = try integer("endpointing", params, default: 0)
        }
        if let flag = params["interim_results"] { query.interimResults = flag != "false" }
        return query
    }

    private static func integer(_ key: String, _ params: [String: String], default value: Int) throws -> Int {
        guard let raw = params[key] else { return value }
        guard let parsed = Int(raw), parsed > 0 else {
            throw FluidServerSTTError.badListenParameter("\(key)=\(raw)")
        }
        return parsed
    }
}
