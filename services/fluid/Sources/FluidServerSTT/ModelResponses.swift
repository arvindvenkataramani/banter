import Foundation
import Hummingbird

/// The body `/v1/models/load` accepts.
///
/// The listing and action *responses* are generated from `openapi.yaml`, so
/// they are not declared here: a second hand-written copy would be free to
/// drift from the spec the handlers must satisfy.
///
/// Both spellings are accepted because both have been sent: `model` is what the
/// spec documents and what every current caller uses, `id` is what an earlier
/// client sent.
struct LoadRequest: Codable {
    let model: String?
    let id: String?
}
