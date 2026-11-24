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
        "triton.model-repository": ["field:index.version"],
        "deepgram.speak": [
            "parameter:callback", "parameter:callback_method", "parameter:mip_opt_out", "parameter:tag",
            "parameter:bit_rate", "value:encoding=flac", "value:encoding=mulaw", "value:encoding=alaw",
            "value:encoding=mp3", "value:encoding=opus",
            "value:container=ogg",
        ],
        "deepgram.speak.live": ["value:encoding=mulaw", "value:encoding=alaw"],
        "openai.realtime": [
            "mode:transcription", "client-message:conversation.item.create",
            "client-message:conversation.item.delete", "client-message:conversation.item.retrieve",
            "client-message:conversation.item.truncate", "client-message:input_audio_buffer.append",
            "client-message:input_audio_buffer.clear", "client-message:input_audio_buffer.commit",
            "client-message:output_audio_buffer.clear",
            "parameter:intent", "parameter:audio.input.format", "parameter:audio.input.transcription",
            "parameter:audio.input.noise_reduction", "parameter:audio.input.turn_detection", "parameter:include",
        ],
        "fluid.tts.stream": [],
    ]

    /// Reads the `provides` of service `provider` and refuses an entry claiming more than the build serves.
    static func load(registry: URL, provider: String) throws -> Provisions {
        let declared = try ProvisionCheck.read(registry: registry, service: provider)
        try ProvisionCheck.check(declared, service: provider, build: build)
        return Provisions(declared: declared)
    }

    /// The speech route's format when a request names none, as its provision declares it.
    var speechFormat: String? {
        declared.declaredDefault("response_format", of: "openai.audio.speech")?.description
    }

    /// The Deepgram speak route's encoding when a request names none: the
    /// declared default, else the first value the provision restricts it to.
    var speakEncoding: String? {
        guard let provision = declared.first(where: { $0.api == "deepgram.speak" }) else { return nil }
        return (provision.defaults?["encoding"] ?? provision.restricts?["encoding"]?.first)?.description
    }
}
