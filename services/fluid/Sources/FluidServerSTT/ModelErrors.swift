import FluidServerKit
import Foundation
import Hummingbird

/// The STT server's own conditions.
///
/// Conforms to the kit's error protocol, so a status travels with the error
/// whether a route throws it or builds a response from it, and so both servers
/// answer the same condition the same way.
enum FluidServerSTTError: FluidServerError {
    case unknownModel(String)
    case noModelLoaded
    case notStreamable(String)
    /// The model is resident, but not in the mode this request needs. A
    /// different condition from "not loaded": the weights for the other mode
    /// are up, and loading this one is a decision the caller makes.
    case modeNotLoaded(id: String, mode: String)
    /// The roster refused the request — no mode named for a model that serves
    /// both, an unoffered chunk size, and so on. Carries its own wording.
    case roster(RosterError)
    case streamingModelSelected(String)
    case badAudioFrame
    case streamBusy
    case decoderFailed(String)
    case unknownFormat(String)
    case unsupportedEncoding(String)
    case badListenParameter(String)
    /// Loading on a request's behalf failed; the slot is left empty.
    case loadFailed(id: String, detail: String)

    var description: String {
        switch self {
        case .unknownModel(let id):
            return "unknown model: \(id)"
        case .noModelLoaded:
            return "no model is loaded"
        case .notStreamable(let id):
            return "\(id) is a batch model and cannot stream"
        case .modeNotLoaded(let id, let mode):
            return
                "\(id) is loaded, but not for \(mode); load it with \"mode\": \"\(mode)\" first"
        case .roster(let error):
            return error.description
        case .streamingModelSelected(let id):
            return "\(id) is a streaming model and has no batch path"
        case .badAudioFrame:
            return "could not build an audio buffer from the frame"
        case .streamBusy:
            return "a streaming session holds the model; one model is resident at a time"
        case .decoderFailed(let detail):
            return "audio decode failed: \(detail)"
        case .unknownFormat(let f):
            return "unknown audio format: \(f); expected pcm16 or opus"
        case .unsupportedEncoding(let e):
            return "unsupported encoding: \(e); /listen takes linear16"
        case .badListenParameter(let p):
            return "invalid query parameter: \(p)"
        case .loadFailed(let id, let detail):
            return "loading \(id) failed: \(detail)"
        }
    }

    /// A state conflict is 409 rather than 400: the request is well formed and the id
    /// is real, but the server's state does not satisfy it.
    var status: HTTPResponse.Status {
        switch self {
        case .unknownModel: return .badRequest
        case .noModelLoaded, .streamBusy: return .conflict
        case .notStreamable: return .badRequest
        // The request is well formed and the model is real; the server's state
        // does not satisfy it.
        case .modeNotLoaded: return .conflict
        case .roster: return .badRequest
        case .streamingModelSelected: return .conflict
        case .badAudioFrame, .decoderFailed: return .unprocessableContent
        case .unknownFormat, .unsupportedEncoding, .badListenParameter: return .badRequest
        case .loadFailed: return .serviceUnavailable
        }
    }
}

extension FluidServerSTTError: SocketCoded {
    var socketCode: SocketErrorCode {
        switch self {
        case .noModelLoaded, .modeNotLoaded, .notStreamable, .loadFailed:
            return .modelNotLoaded
        case .unknownModel, .streamingModelSelected, .roster:
            return .modelMismatch
        case .streamBusy:
            return .busy
        case .unknownFormat, .unsupportedEncoding, .badListenParameter:
            return .badFormat
        case .badAudioFrame, .decoderFailed:
            return .badAudio
        }
    }
}
