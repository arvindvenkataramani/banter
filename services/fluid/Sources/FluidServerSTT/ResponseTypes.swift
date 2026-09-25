import Foundation
import Hummingbird

struct TranscriptionResponse: ResponseEncodable, Codable {
    let task: String
    let language: String?
    let duration: Double?
    let text: String
    /// Populated only for `verbose_json` with a `word` granularity; omitted otherwise
    /// so the default response shape is unchanged.
    let words: [WordTiming]?
}

struct HealthResponse: ResponseEncodable, Codable {
    let status: String
    /// The model actually resident, not the launch flag. Null when none is
    /// loaded — which is a real state now that loading can fail.
    let model: String?
}

struct ErrorResponse: ResponseEncodable, Codable {
    let error: String
}
