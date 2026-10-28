import Foundation

/// What a Deepgram client declares in the `/listen` query string. Parameters the
/// server cannot honour (`diarize`, `numerals`, `filler_words`, `mip_opt_out`,
/// keyword boosting) are accepted and ignored, because clients always send them.
struct ListenQuery: Sendable {
    var model: String?
    var language: String?
    var sampleRate = 16000
    var channels = 1
    /// Silence after speech that closes an utterance; milliseconds.
    var endpointingMs = 700
    var interimResults = true

    static func parse(_ params: [String: String]) throws -> ListenQuery {
        var query = ListenQuery()
        query.model = params["model"]
        query.language = params["language"]

        if let encoding = params["encoding"], encoding != "linear16" {
            throw FluidServerSTTError.unsupportedEncoding(encoding)
        }
        query.sampleRate = try integer("sample_rate", params, default: query.sampleRate)
        query.channels = try integer("channels", params, default: query.channels)
        query.endpointingMs = try integer("endpointing", params, default: query.endpointingMs)
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
