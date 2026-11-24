import FluidServerKit
import Foundation

/// What this server's registry entry declares it provides, checked against what the build serves.
struct Provisions: Sendable {
    let declared: [Provision]

    static let none = Provisions(declared: [])

    /// Each API this build serves, with the parts of it the build lacks.
    static let build: [String: [String]] = [
        "openai.audio.speech": [
            "parameter:instructions", "value:response_format=mp3", "value:response_format=opus",
            "value:response_format=flac",
        ],
        "triton.model-repository": [],
    ]

    /// Reads the `provides` of service `provider` and refuses an entry claiming more than the build serves.
    static func load(registry: URL, provider: String) throws -> Provisions {
        let declared = try ProvisionCheck.read(registry: registry, service: provider)
        try ProvisionCheck.check(declared, service: provider, build: build)
        return Provisions(declared: declared)
    }

    /// The speech route's format when a request names none: the provision's default, else AAC.
    var speechFormat: String? {
        declared.declaredDefault("response_format", of: "openai.audio.speech")?.description
    }
}
