import Foundation
import Hummingbird

struct TranscriptionResponse: ResponseEncodable, Codable {
    let task: String
    let language: String?
    let duration: Double?
    let text: String
}

struct HealthResponse: ResponseEncodable, Codable {
    let status: String
    let model: String
}

struct ErrorResponse: ResponseEncodable, Codable {
    let error: String
}
