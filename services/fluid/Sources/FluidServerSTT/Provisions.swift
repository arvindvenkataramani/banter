import FluidServerKit
import Foundation

/// What this server's registry entry declares it provides, checked against what the build serves.
struct Provisions: Sendable {
    let declared: [Provision]

    static let none = Provisions(declared: [])

    /// Each API this build serves, with the parts of it the build lacks.
    static let build: [String: [String]] = [
        "fluid.stt.stream": [],
        "openai.audio.transcriptions": [
            "parameter:language", "parameter:languages", "parameter:keywords", "parameter:prompt",
            "parameter:temperature", "parameter:include", "value:include=logprobs",
            "parameter:stream", "parameter:chunking_strategy", "parameter:known_speaker_names",
            "parameter:known_speaker_references", "value:response_format=srt",
            "value:response_format=vtt", "value:response_format=diarized_json",
        ],
        "triton.model-repository": [],
    ]

    /// Reads the `provides` of service `provider` and refuses an entry claiming more than the build serves.
    static func load(registry: URL, provider: String) throws -> Provisions {
        let declared = try ProvisionCheck.read(registry: registry, service: provider)
        try ProvisionCheck.check(declared, service: provider, build: build)
        return Provisions(declared: declared)
    }

    /// The listen route's endpointing default: the provision's, else 700 ms.
    var listenEndpointingMs: Int {
        declared.declaredDefault("endpointing", of: "deepgram.listen.live")?.int ?? 700
    }
}
